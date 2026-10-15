import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCliRunner } from "./cli.mjs";
import { normalizeTools } from "./tools.mjs";
import { GatewayError } from "./errors.mjs";

const tools = normalizeTools(
  ["lookup", "second"].map((name) => ({
    type: "function",
    function: {
      name,
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
    },
  })),
);
const base = {
  modelId: "deepseek-v4.1-flash-free",
  messages: [{ role: "user", content: "값 조회" }],
  tools,
  toolChoice: "auto",
  parallelToolCalls: true,
  maxOutputTokens: 512,
};
const source = `
const fs=require('node:fs');
process.stdin.resume();
process.on('SIGUSR1',()=>{
 const replies=JSON.parse(fs.readFileSync(process.env.FIXTURE_REPLY,'utf8'));
 console.log(JSON.stringify({type:'tool_use',part:{tool:'caller_fn0',state:{status:'completed'}}}));
 console.log(JSON.stringify({type:'step_finish',part:{id:'tools',reason:'tool-calls',tokens:{input:11,output:3,reasoning:2},cost:0}}));
 console.log(JSON.stringify({type:'text',part:{id:'answer',text:replies.join('|')}}));
 console.log(JSON.stringify({type:'step_finish',part:{id:'end',reason:'stop',tokens:{input:17,output:4,reasoning:1},cost:0}}));
 process.exit(0);
});
process.stdin.on('end',()=>console.log(JSON.stringify({type:'fixture_ready'})));
process.on('SIGUSR2',()=>console.log(JSON.stringify({type:'text',part:{id:'late-prefix',text:'late-'}})));
setInterval(()=>{},1000);
`;

async function until(condition) {
  const deadline = Date.now() + 2500;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("시험 상태 대기 초과");
    await delay(5);
  }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "tool-sessions-"));
  const bridges = [],
    children = [];
  const runner = createCliRunner({
    executable: "/official/opencode",
    stateDir: join(root, "state"),
    cacheDir: join(root, "cache"),
    ...options,
    createBridge: async (callbacks) => {
      const bridge = {
        ...callbacks,
        configPath: join(callbacks.work, "fixture.json"),
        calls: 0,
        replies: [],
        closed: false,
        emit(name = "lookup", args = { key: "alpha" }) {
          const requestId = "r" + ++this.calls;
          callbacks.onCall({ requestId, name, arguments: args });
        },
        reply(_requestId, content) {
          this.replies.push(content);
          if (this.replies.length === this.calls) {
            writeFileSync(
              join(callbacks.work, "reply.json"),
              JSON.stringify(this.replies),
            );
            const child = children.find(
              (entry) => entry.work === callbacks.work,
            ).process;
            child.kill("SIGUSR1");
          }
        },
        async close() {
          this.closed = true;
        },
      };
      bridges.push(bridge);
      return bridge;
    },
    spawnProcess(_executable, _args, options) {
      const process = spawn(globalThis.process.execPath, ["-e", source], {
        ...options,
        env: { ...options.env, FIXTURE_REPLY: join(options.cwd, "reply.json") },
      });
      const entry = { process, work: options.cwd, ready: false };
      let buffer = "";
      process.stdout.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes('"fixture_ready"')) entry.ready = true;
      });
      children.push(entry);
      return process;
    },
  });
  t.after(async () => {
    await runner.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    runner,
    bridges,
    children,
    root,
    ready: (index) => until(() => children[index]?.ready),
  };
}

function resume(request, result, content = "실제 외부 결과") {
  return {
    ...request,
    messages: [
      ...request.messages,
      { role: "assistant", content: result.text, tool_calls: result.toolCalls },
      ...result.toolCalls.map((call) => ({
        role: "tool",
        tool_call_id: call.id,
        content,
      })),
    ],
  };
}

test("클라이언트 결과 전에는 네이티브 호출이 대기하고 동일 프로세스로 결과를 회신한다", async (t) => {
  const f = await fixture(t);
  const pending = f.runner.run(base);
  await f.ready(0);
  f.bridges[0].emit();
  const first = await pending;
  assert.equal(first.finishReason, "tool_calls");
  assert.equal(first.usage, null);
  assert.deepEqual(f.bridges[0].replies, []);
  assert.equal(f.runner.stats().active, 1);
  first.commit();
  assert.equal(f.runner.stats().waitingForTools, 1);
  const second = await f.runner.run(resume(base, first));
  assert.equal(second.text, "실제 외부 결과");
  assert.equal(second.finishReason, "stop");
  assert.equal(second.usage.total_tokens, 38);
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.bridges[0].replies, ["실제 외부 결과"]);
  assert.equal(f.runner.stats().active, 0);
  assert.deepEqual(await readdir(join(f.root, "state")), []);
});

test("동시 호출은 모두 보존하고 parallel false면 한 번에 하나씩 전달한다", async (t) => {
  const f = await fixture(t);
  const request = { ...base, parallelToolCalls: false };
  const pending = f.runner.run(request);
  await f.ready(0);
  f.bridges[0].emit();
  f.bridges[0].emit("second", { key: "beta" });
  const first = await pending;
  assert.equal(first.toolCalls.length, 1);
  first.commit();
  const request2 = resume(request, first, "one");
  const second = await f.runner.run(request2);
  assert.equal(second.toolCalls.length, 1);
  assert.equal(second.toolCalls[0].function.name, "second");
  second.commit();
  const final = await f.runner.run(resume(request2, second, "two"));
  assert.equal(final.text, "one|two");
  assert.equal(f.children.length, 1);
});

test("병렬 배치의 누락 결과와 변경된 대화·스키마는 세션을 소비하지 않고 거절한다", async (t) => {
  const f = await fixture(t);
  const pending = f.runner.run(base);
  await f.ready(0);
  f.bridges[0].emit();
  f.bridges[0].emit("second");
  const first = await pending;
  assert.equal(first.toolCalls.length, 2);
  first.commit();
  const complete = resume(base, first);
  for (const changed of [
    { ...complete, messages: complete.messages.slice(0, -1) },
    {
      ...complete,
      messages: [
        { role: "user", content: "다른 대화" },
        ...complete.messages.slice(1),
      ],
    },
    { ...complete, maxOutputTokens: 1000 },
    { ...complete, tools: tools.slice(0, 1) },
  ])
    await assert.rejects(
      f.runner.run(changed),
      (error) => error.status === 409,
    );
  assert.deepEqual(f.bridges[0].replies, []);
  assert.equal((await f.runner.run(complete)).finishReason, "stop");
});

test("대기 세션도 워커 한도에 포함하지만 같은 호출의 결과 재개는 허용한다", async (t) => {
  const f = await fixture(t, { maxWorkers: 1 });
  const pending = f.runner.run(base);
  await f.ready(0);
  f.bridges[0].emit();
  const first = await pending;
  first.commit();
  await assert.rejects(f.runner.run(base), (error) => error.status === 429);
  assert.equal((await f.runner.run(resume(base, first))).finishReason, "stop");
});

test("도구 대기 TTL은 CLI와 상태를 정리하고 늦은 결과를 다시 실행하지 않는다", async (t) => {
  const f = await fixture(t, { toolTtlMs: 40 });
  const pending = f.runner.run(base);
  await f.ready(0);
  f.bridges[0].emit();
  const first = await pending;
  first.commit();
  await until(() => f.runner.stats().active === 0);
  await assert.rejects(
    f.runner.run(resume(base, first)),
    (error) => error.status === 410,
  );
  assert.equal(f.children.length, 1);
  assert.deepEqual(await readdir(join(f.root, "state")), []);
});

test("호출 응답 전달 전 취소와 서버 종료는 보류 중인 네이티브 실행까지 종료한다", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = f.runner.run(base, { signal: controller.signal });
  await f.ready(0);
  f.bridges[0].emit();
  await pending;
  controller.abort(new GatewayError(499, "client_disconnected", "closed"));
  await until(() => f.runner.stats().active === 0);
  const another = f.runner.run(base);
  await f.ready(1);
  f.bridges[1].emit();
  const first = await another;
  first.commit();
  await f.runner.close();
  assert.equal(f.runner.stats().active, 0);
  assert.ok(f.bridges.every((bridge) => bridge.closed));
});

test("도구 대기 중 늦게 온 텍스트도 다음 스트림과 응답 이력에 동일하게 반영한다", async (t) => {
  const f = await fixture(t);
  const pending = f.runner.run(base);
  await f.ready(0);
  f.bridges[0].emit();
  const first = await pending;
  first.commit();
  let seen;
  const late = new Promise((resolve) => {
    seen = resolve;
  });
  f.children[0].process.stdout.on("data", (chunk) => {
    if (chunk.toString().includes("late-prefix")) seen();
  });
  f.children[0].process.kill("SIGUSR2");
  await late;
  const deltas = [];
  const final = await f.runner.run(resume(base, first, "actual"), {
    onText: (text) => deltas.push(text),
  });
  assert.equal(final.text, "late-actual");
  assert.equal(deltas.join(""), final.text);
});
