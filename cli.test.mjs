import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliRunner } from "./cli.mjs";
import { GatewayError } from "./errors.mjs";

const request = {
  modelId: "deepseek-v4.1-flash-free",
  messages: [{ role: "user", content: "--command bad\n한글 입력" }],
  maxOutputTokens: 512,
  tools: [],
  toolChoice: "none",
  parallelToolCalls: true,
};
const finish = {
  type: "step_finish",
  part: {
    id: "s1",
    reason: "stop",
    cost: 0,
    tokens: {
      input: 10,
      output: 5,
      reasoning: 3,
      cache: { read: 20, write: 0 },
    },
  },
};
const text = (value) => ({ type: "text", part: { id: "t1", text: value } });

async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), "opencode-runner-test-"));
  let captured;
  let child;
  const runner = createCliRunner({
    executable: "/official/opencode",
    stateDir: join(root, "state"),
    cacheDir: join(root, "cache"),
    spawnProcess(executable, args, options) {
      captured = { executable, args, options };
      child = spawn(process.execPath, ["-e", source], options);
      return child;
    },
  });
  t.after(async () => {
    await runner.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    run: runner.run,
    root,
    get captured() {
      return captured;
    },
    get child() {
      return child;
    },
  };
}

function emit(events) {
  return `process.stdin.resume();process.stdin.on('end',()=>{for(const e of ${JSON.stringify(events)})console.log(JSON.stringify(e));});`;
}

test("CLI 입력은 셸과 argv를 거치지 않고 환경과 작업 파일은 격리된다", async (t) => {
  const f = await fixture(t, emit([text("응답"), finish]));
  const deltas = [];
  const result = await f.run(request, {
    onText: (value) => deltas.push(value),
  });
  assert.equal(result.text, "응답");
  assert.deepEqual(deltas, ["응답"]);
  assert.deepEqual(result.usage, {
    prompt_tokens: 30,
    completion_tokens: 8,
    total_tokens: 38,
    prompt_tokens_details: { cached_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 3 },
  });
  assert.equal(f.captured.executable, "/official/opencode");
  assert.equal(f.captured.args.includes("--command"), false);
  assert.equal(f.captured.args.includes("--auto"), false);
  assert.equal(f.captured.options.shell, undefined);
  assert.equal(f.captured.options.env.OPENCODE_API_KEY, undefined);
  assert.equal(f.captured.options.env.GATEWAY_TOKEN_FILE, undefined);
  assert.equal(
    f.captured.options.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX,
    "512",
  );
  const cfg = JSON.parse(f.captured.options.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(cfg.permission, { "*": "ask" });
  assert.deepEqual(cfg.agent.build.permission, { "*": "ask" });
  assert.deepEqual(await readdir(join(f.root, "state")), []);
});

test("중복 이벤트는 중복 텍스트나 사용량을 만들지 않는다", async (t) => {
  const f = await fixture(
    t,
    emit([text("가"), text("가나"), text("가나"), finish, finish]),
  );
  const result = await f.run(request);
  assert.equal(result.text, "가나");
  assert.equal(result.usage.total_tokens, 38);
});

test("UTF-8 청크 분할도 손상 없이 복원한다", async (t) => {
  const body = `${JSON.stringify(text("한글"))}\n${JSON.stringify(finish)}\n`;
  const f = await fixture(
    t,
    `process.stdin.resume();process.stdin.on('end',()=>{const b=Buffer.from(${JSON.stringify(body)});for(let i=0;i<b.length;i++)process.stdout.write(b.subarray(i,i+1));});`,
  );
  assert.equal((await f.run(request)).text, "한글");
});

test("공식 CLI의 공급자 오류 상태를 보존한다", async (t) => {
  const f = await fixture(
    t,
    emit([
      {
        type: "error",
        error: { data: { statusCode: 403, message: "FreeTierError" } },
      },
    ]),
  );
  await assert.rejects(
    f.run(request),
    (e) =>
      e.status === 403 &&
      e.code === "upstream_error" &&
      e.message === "FreeTierError",
  );
});

test("내장 도구 이벤트는 외부 함수 호출로 위장하지 않고 실패한다", async (t) => {
  const f = await fixture(
    t,
    emit([
      { type: "tool_use", part: { tool: "bash", state: { status: "error" } } },
    ]),
  );
  await assert.rejects(
    f.run(request),
    (e) => e.status === 403 && e.code === "native_tool_denied",
  );
});

test("완료 이벤트 없는 출력과 비정상 종료는 성공으로 처리하지 않는다", async (t) => {
  const f = await fixture(t, emit([text("부분 응답")]));
  await assert.rejects(
    f.run(request),
    (e) => e.status === 502 && e.code === "incomplete_cli_output",
  );
});

test("출력 길이 종료는 length로 반환한다", async (t) => {
  const f = await fixture(
    t,
    emit([
      text("부분 응답"),
      { ...finish, part: { ...finish.part, reason: "length" } },
    ]),
  );
  assert.equal((await f.run(request)).finishReason, "length");
});

test("요청 취소는 자식 종료와 임시 파일 정리까지 기다린다", async (t) => {
  const f = await fixture(
    t,
    "process.stdin.resume();setInterval(()=>{},1000);",
  );
  const controller = new AbortController();
  const pending = f.run(request, { signal: controller.signal });
  const timer = setInterval(() => {
    if (f.child) {
      clearInterval(timer);
      controller.abort(new GatewayError(504, "request_timeout", "Timed out"));
    }
  }, 5);
  t.after(() => clearInterval(timer));
  await assert.rejects(pending, (e) => e.status === 504);
  assert.notEqual(
    f.child.exitCode === null && f.child.signalCode === null,
    true,
  );
  assert.deepEqual(await readdir(join(f.root, "state")), []);
});

test("빈 오류 로그를 응답 성공으로 대체하지 않는다", async (t) => {
  const f = await fixture(
    t,
    "process.stdin.resume();process.stdin.on('end',()=>{console.error('PRIVATE_TOKEN');process.exit(1);});",
  );
  await assert.rejects(
    f.run(request),
    (e) => e.status === 502 && !e.message.includes("PRIVATE_TOKEN"),
  );
});
