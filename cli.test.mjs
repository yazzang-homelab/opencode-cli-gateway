import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliRunner, pluginRequest } from "./cli.mjs";

const lookup = {
  type: "function",
  function: {
    name: "lookup",
    description: "Find a value.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
};
const request = {
  modelId: "deepseek-v4.1-flash-free",
  messages: [
    {
      role: "user",
      content: "--command bad\n한글 입력",
      parts: [{ type: "text", text: "--command bad\n한글 입력" }],
    },
  ],
  maxOutputTokens: 512,
  tools: [],
  toolChoice: "none",
  parallelToolCalls: true,
  options: {},
};
const step = (
  reason,
  tokens = {
    input: 10,
    output: 5,
    reasoning: 3,
    cache: { read: 20, write: 0 },
  },
) => ({
  type: "gateway.step",
  reason,
  tokens,
  cost: 0,
});
const attempt = (value = 0) => ({ type: "gateway.attempt", step: value });
const delta = (text, kind = "text") => ({ type: "gateway.delta", kind, text });

// Stands in for `opencode run` with the plugin loaded: it writes plugin
// events to the gateway socket, optional CLI stdout lines, then idles like a
// run whose follow-up model request is held by `chat.params`.
function cli({ events = [], stdout = [], exit = false }) {
  return `
const net = require("node:net");
const socket = net.connect(process.env.GATEWAY_EVENT_SOCKET, () => {
  for (const line of ${JSON.stringify(stdout)}) console.log(JSON.stringify(line));
  for (const event of ${JSON.stringify(events)}) socket.write(JSON.stringify(event) + "\\n");
  ${exit ? "socket.end(() => process.exit(0));" : "setInterval(() => {}, 1000);"}
});`;
}

async function fixture(t, script, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "opencode-runner-test-"));
  const captured = [];
  const children = [];
  const runner = createCliRunner({
    executable: "/official/opencode",
    stateDir: join(root, "state"),
    cacheDir: join(root, "cache"),
    maxWorkers: options.maxWorkers ?? 4,
    plugin: "/gateway/opencode-plugin.mjs",
    spawnProcess(executable, args, spawnOptions) {
      captured.push({ executable, args, options: spawnOptions });
      const child = spawn(process.execPath, ["-e", script], spawnOptions);
      children.push(child);
      return child;
    },
  });
  t.after(async () => {
    await runner.close();
    await rm(root, { recursive: true, force: true });
  });
  return { runner, root, captured, children };
}

test("요청 내용은 argv에 넣지 않고 격리된 공식 CLI와 플러그인 설정으로 실행한다", async (t) => {
  const f = await fixture(
    t,
    cli({ events: [attempt(), delta("응"), delta("답"), step("stop")] }),
  );
  const deltas = [];
  const result = await f.runner.run(request, {
    onText: (text) => deltas.push(text),
  });
  assert.equal(result.text, "응답");
  assert.deepEqual(deltas, ["응", "답"]);
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.usage, {
    prompt_tokens: 30,
    completion_tokens: 8,
    total_tokens: 38,
    prompt_tokens_details: { cached_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 3 },
  });
  const [{ executable, args, options }] = f.captured;
  assert.equal(executable, "/official/opencode");
  assert.equal(args.join(" ").includes("한글"), false);
  assert.equal(args.includes("--auto"), false);
  assert.equal(options.shell, undefined);
  assert.equal(options.env.GATEWAY_TOKEN_FILE, undefined);
  assert.equal(options.env.OPENCODE_API_KEY, undefined);
  const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.plugin, ["file:///gateway/opencode-plugin.mjs"]);
  assert.deepEqual(config.permission, { "*": "ask" });
  assert.deepEqual(await readdir(join(f.root, "state")), []);
});

test("추론 델타는 본문과 분리해 실시간으로 전달한다", async (t) => {
  const f = await fixture(
    t,
    cli({
      events: [
        attempt(),
        delta("생각", "reasoning"),
        delta("답"),
        step("stop"),
      ],
    }),
  );
  const reasoning = [];
  const result = await f.runner.run(request, {
    onReasoning: (text) => reasoning.push(text),
  });
  assert.deepEqual(reasoning, ["생각"]);
  assert.equal(result.reasoning, "생각");
  assert.equal(result.text, "답");
});

test("모델의 함수 호출은 ID·이름·인자를 그대로 반환하고 즉시 프로세스를 정리한다", async (t) => {
  const events = [
    attempt(),
    delta("확인"),
    {
      type: "gateway.call",
      id: "call_00_a",
      name: "lookup",
      arguments: { key: "alpha" },
    },
    {
      type: "gateway.call",
      id: "call_01_b",
      name: "lookup",
      arguments: { key: "beta" },
    },
    step("tool-calls"),
  ];
  const f = await fixture(t, cli({ events }));
  const result = await f.runner.run({
    ...request,
    tools: [lookup],
    toolChoice: "auto",
  });
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.text, "확인");
  assert.deepEqual(result.toolCalls, [
    {
      id: "call_00_a",
      type: "function",
      function: { name: "lookup", arguments: '{"key":"alpha"}' },
    },
    {
      id: "call_01_b",
      type: "function",
      function: { name: "lookup", arguments: '{"key":"beta"}' },
    },
  ]);
  assert.notEqual(f.children[0].signalCode ?? f.children[0].exitCode, null);
  assert.deepEqual(f.runner.stats(), { active: 0, maxWorkers: 4 });
  assert.deepEqual(await readdir(join(f.root, "state")), []);

  const serial = await fixture(t, cli({ events }));
  const single = await serial.runner.run({
    ...request,
    tools: [lookup],
    toolChoice: "auto",
    parallelToolCalls: false,
  });
  assert.deepEqual(
    single.toolCalls.map((call) => call.id),
    ["call_00_a"],
  );
});

test("선언되지 않은 함수·내장 도구·필수 호출 누락은 명시적으로 실패한다", async (t) => {
  for (const [events, code, choice] of [
    [
      [
        attempt(),
        { type: "gateway.call", id: "c1", name: "bash", arguments: {} },
        step("tool-calls"),
      ],
      "invalid_tool_call",
      "auto",
    ],
    [
      [
        attempt(),
        { type: "gateway.native_call", name: "invalid" },
        step("tool-calls"),
      ],
      "native_tool_call",
      "auto",
    ],
    [
      [
        attempt(),
        { type: "gateway.call", id: "c1", name: "lookup", arguments: [] },
      ],
      "invalid_tool_call",
      "auto",
    ],
    [
      [attempt(), delta("텍스트"), step("stop")],
      "tool_choice_unsatisfied",
      "required",
    ],
    [
      [attempt(), { type: "gateway.fatal", code: "unexpected_native_tool" }],
      "plugin_failed",
      "auto",
    ],
  ]) {
    const f = await fixture(t, cli({ events }));
    await assert.rejects(
      f.runner.run({ ...request, tools: [lookup], toolChoice: choice }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.status, 502);
        return true;
      },
    );
  }
});

test("출력 전 재시도는 허용하고 출력 뒤 같은 단계 재시도는 중복 대신 실패한다", async (t) => {
  const retried = await fixture(
    t,
    cli({ events: [attempt(0), attempt(0), delta("한 번"), step("stop")] }),
  );
  assert.equal((await retried.runner.run(request)).text, "한 번");
  const duplicated = await fixture(
    t,
    cli({
      events: [
        attempt(0),
        delta("중"),
        attempt(0),
        delta("중복"),
        step("stop"),
      ],
    }),
  );
  await assert.rejects(
    duplicated.runner.run(request),
    (error) => error.code === "upstream_retry_after_output",
  );
});

test("텍스트 전용 요청은 거절된 내장 도구 단계 뒤 최종 답변을 이어 붙인다", async (t) => {
  const events = [
    attempt(0),
    delta("A"),
    { type: "gateway.native_rejected", name: "glob" },
    attempt(1),
    delta("B"),
    step("stop", {
      input: 20,
      output: 4,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
  ];
  const f = await fixture(t, cli({ events }));
  const result = await f.runner.run(request);
  assert.equal(result.text, "AB");
  assert.equal(result.usage.total_tokens, 24);
});

test("호출자에 없는 OpenCode read 호출은 거절 처리하고 호출자 함수만 반환한다", async (t) => {
  const events = [
    attempt(0),
    { type: "gateway.native_rejected", name: "read" },
    {
      type: "gateway.call",
      id: "call_x",
      name: "lookup",
      arguments: { key: "k" },
    },
    step("tool-calls"),
  ];
  const f = await fixture(t, cli({ events }));
  const result = await f.runner.run({
    ...request,
    tools: [lookup],
    toolChoice: "auto",
  });
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(
    result.toolCalls.map((call) => call.function.name),
    ["lookup"],
  );
});

test("공식 CLI의 상류 오류 상태와 메시지를 보존한다", async (t) => {
  const f = await fixture(
    t,
    cli({
      stdout: [
        {
          type: "error",
          error: { data: { statusCode: 429, message: "rate limited" } },
        },
      ],
    }),
  );
  await assert.rejects(
    f.runner.run(request),
    (error) => error.status === 429 && error.message === "rate limited",
  );
});

test("단계 완료 없이 종료한 CLI는 성공으로 처리하지 않는다", async (t) => {
  const f = await fixture(
    t,
    cli({ events: [attempt(), delta("일부")], exit: true }),
  );
  await assert.rejects(
    f.runner.run(request),
    (error) => error.code === "incomplete_cli_output",
  );
});

test("요청 취소는 자식 프로세스 종료와 임시 파일 정리까지 기다린다", async (t) => {
  const f = await fixture(t, cli({ events: [attempt()] }));
  const controller = new AbortController();
  const pending = f.runner.run(request, { signal: controller.signal });
  while (!f.children.length)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort(
    Object.assign(new Error("cancelled"), { code: "cancelled" }),
  );
  await assert.rejects(pending, (error) => error.code === "cancelled");
  assert.notEqual(f.children[0].signalCode ?? f.children[0].exitCode, null);
  assert.deepEqual(await readdir(join(f.root, "state")), []);
});

test("동시 실행 상한을 넘는 요청은 429로 거절한다", async (t) => {
  const f = await fixture(t, cli({ events: [attempt()] }), { maxWorkers: 1 });
  const controller = new AbortController();
  const first = f.runner.run(request, { signal: controller.signal });
  await assert.rejects(f.runner.run(request), (error) => error.status === 429);
  assert.deepEqual(f.runner.stats(), { active: 1, maxWorkers: 1 });
  controller.abort(new Error("done"));
  await assert.rejects(first);
});

test("플러그인 요청은 원래 역할·도구 결과·함수 정의·생성 설정을 그대로 옮긴다", () => {
  const spec = pluginRequest({
    ...request,
    messages: [
      { role: "system", content: "S1" },
      { role: "developer", content: "D1" },
      {
        role: "user",
        content: "질문",
        parts: [{ type: "text", text: "질문" }],
      },
      {
        role: "assistant",
        content: "",
        reasoning_content: "이전 추론",
        tool_calls: [
          {
            id: "call_x",
            type: "function",
            function: { name: "lookup", arguments: '{"key":"k"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_x", content: "실제 결과" },
    ],
    tools: [
      lookup,
      {
        type: "function",
        function: { name: "other", parameters: { type: "object" } },
      },
    ],
    toolChoice: { type: "function", function: { name: "lookup" } },
    parallelToolCalls: false,
    temperature: 0.3,
    options: { seed: 7 },
  });
  assert.equal(spec.system, "S1\n\nD1");
  assert.equal(spec.mode, "caller");
  assert.equal(spec.toolChoice, "required");
  assert.deepEqual(spec.tools, [
    {
      name: "lookup",
      description: "Find a value.",
      parameters: lookup.function.parameters,
    },
  ]);
  assert.deepEqual(spec.messages, [
    { role: "user", parts: [{ type: "text", text: "질문" }] },
    {
      role: "assistant",
      text: "",
      reasoning: "이전 추론",
      toolCalls: [
        {
          id: "call_x",
          name: "lookup",
          arguments: { key: "k" },
          output: "실제 결과",
        },
      ],
    },
  ]);
  assert.deepEqual(spec.sampling, {
    temperature: 0.3,
    topP: undefined,
    maxOutputTokens: 512,
  });
  assert.deepEqual(spec.options, { parallel_tool_calls: false, seed: 7 });
  // The AI SDK drops snake_case `reasoning_effort`; only `reasoningEffort` reaches the upstream body.
  assert.deepEqual(
    pluginRequest({
      ...request,
      options: { reasoning_effort: "max", stop: ["x"] },
    }).options,
    {
      stop: ["x"],
      reasoningEffort: "max",
    },
  );
  assert.equal(pluginRequest(request).mode, "native");
});
