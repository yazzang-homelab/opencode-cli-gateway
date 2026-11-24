import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "./plugin/index.js";
import {
  classifyCalls,
  createAccumulator,
  createEventParser,
  rewriteBody,
  tokens,
} from "./plugin/upstream.js";

const read = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file",
    parameters: { type: "object" },
  },
};
const shell = {
  type: "function",
  function: { name: "shell", parameters: { type: "object" } },
};
const lookup = {
  type: "function",
  function: {
    name: "lookup",
    description: "Find a value.",
    parameters: { type: "object", properties: { key: { type: "string" } } },
  },
};
const native = {
  model: "tidepool-alpha-free",
  messages: [
    { role: "system", content: "OpenCode harness" },
    { role: "system", content: "Environment" },
    { role: "user", content: "Continue." },
  ],
  tools: [shell, read],
  stream: true,
  stream_options: { include_usage: true },
  max_completion_tokens: 13107,
  temperature: 1,
  reasoning_effort: "high",
};
const spec = (overrides = {}) => ({
  messages: [
    { role: "system", content: "Caller system" },
    { role: "user", content: "질문" },
  ],
  tools: [lookup],
  toolChoice: "auto",
  parallelToolCalls: false,
  params: { max_completion_tokens: 512, reasoning_effort: "minimal" },
  ...overrides,
});
const sse = (...chunks) =>
  chunks
    .map((chunk) =>
      typeof chunk === "string" ? chunk : `data: ${JSON.stringify(chunk)}\n\n`,
    )
    .join("") + "data: [DONE]\n\n";
const chunk = (delta, finish = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const usage = {
  choices: [],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 30,
    prompt_tokens_details: { cached_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 10 },
  },
};

test("본문은 OpenCode 시스템 프롬프트와 read를 남기고 나머지를 호출자 것으로 바꾼다", () => {
  const body = rewriteBody(native, spec());
  assert.deepEqual(body, {
    model: "tidepool-alpha-free",
    messages: [
      { role: "system", content: "OpenCode harness" },
      { role: "system", content: "Environment" },
      { role: "system", content: "Caller system" },
      { role: "user", content: "질문" },
    ],
    tools: [lookup, read],
    tool_choice: "auto",
    parallel_tool_calls: false,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 512,
    reasoning_effort: "minimal",
  });
  const callerRead = {
    ...read,
    function: { ...read.function, description: "Caller read" },
  };
  assert.deepEqual(rewriteBody(native, spec({ tools: [callerRead] })).tools, [
    callerRead,
  ]);
  const text = rewriteBody(native, spec({ tools: [], toolChoice: "none" }));
  assert.deepEqual(text.tools, [read]);
  assert.equal(text.tool_choice, "none");
  assert.equal("parallel_tool_calls" in text, false);
  assert.equal("temperature" in text, false);
  assert.throws(
    () => rewriteBody({ ...native, tools: [shell] }, spec()),
    /no read tool/,
  );
  assert.throws(
    () =>
      rewriteBody(
        { ...native, messages: [{ role: "user", content: "x" }] },
        spec(),
      ),
    /no system prompt/,
  );
});

test("SSE는 조각 경계와 무관하게 data JSON만 꺼낸다", () => {
  const parser = createEventParser();
  const text = sse(
    chunk({ content: "가" }),
    ": keep-alive\n\n",
    chunk({ content: "나" }),
  );
  const events = [];
  for (const piece of [text.slice(0, 7), text.slice(7, 40), text.slice(40)])
    events.push(...parser.push(piece));
  events.push(...parser.end());
  assert.deepEqual(events, [
    chunk({ content: "가" }),
    chunk({ content: "나" }),
  ]);
  const crlf = createEventParser();
  assert.deepEqual(crlf.push('data: {"a":1}\r\n\r\ndata: {"b":2}'), [{ a: 1 }]);
  assert.deepEqual(crlf.end(), [{ b: 2 }]);
  assert.throws(() => createEventParser().push("data: {bad\n\n"));
});

test("누적기는 추론·본문 델타, 나뉜 함수 인자, 종료 사유와 사용량을 모은다", () => {
  const result = createAccumulator();
  const deltas = [
    chunk({ role: "assistant", content: "", reasoning_content: null }),
    chunk({ reasoning_content: "생각" }),
    chunk({ reasoning: "더" }),
    chunk({ content: "답" }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_a",
          function: { name: "lookup", arguments: '{"ke' },
        },
      ],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'y":"v"}' } }] }),
    chunk({
      tool_calls: [
        { index: 1, id: "call_b", function: { name: "read", arguments: "{}" } },
      ],
    }),
    chunk({}, "tool_calls"),
    usage,
  ].flatMap((item) => result.apply(item));
  assert.deepEqual(deltas, [
    { kind: "reasoning", text: "생각" },
    { kind: "reasoning", text: "더" },
    { kind: "text", text: "답" },
  ]);
  assert.equal(result.text, "답");
  assert.equal(result.state.finishReason, "tool_calls");
  assert.deepEqual(tokens(result.state.usage), {
    input: 60,
    output: 20,
    reasoning: 10,
    cache: { read: 40, write: 0 },
  });
  assert.deepEqual(classifyCalls(result.calls, new Set(["lookup"])), {
    invalid: false,
    caller: [{ id: "call_a", name: "lookup", arguments: { key: "v" } }],
    native: ["read"],
  });
  assert.equal(
    classifyCalls(
      [{ id: "c", name: "lookup", arguments: "[1]" }],
      new Set(["lookup"]),
    ).invalid,
    true,
  );
  const failed = createAccumulator();
  failed.apply({ error: { message: "boom" } });
  assert.equal(failed.state.error.message, "boom");
  assert.deepEqual(tokens(undefined), {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  });
});

// Loads the plugin with a stand-in OpenCode context and a gateway socket, then
// drives the registered hooks the way the V2 CLI does for one model call.
async function harness(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "gateway-plugin-test-"));
  const requestFile = join(root, "request.json");
  await writeFile(requestFile, JSON.stringify(spec(overrides)));
  const events = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        events.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
    });
  });
  const socketPath = join(root, "events.sock");
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const hooks = {};
  const ctx = {
    options: { request: requestFile, socket: socketPath },
    session: { hook: async (name, callback) => void (hooks[name] = callback) },
    tool: {
      hook: async (name, callback) => void (hooks[`tool.${name}`] = callback),
    },
  };
  const cleanup = await plugin.setup(ctx);
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    cleanup();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  return {
    hooks,
    events,
    settle,
    async send(stream, status = 200) {
      const request = {
        kind: "primary",
        request: new Request(
          "https://opencode.ai/inference/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencode-client": "cli",
            },
            body: JSON.stringify(native),
          },
        ),
      };
      await hooks["http.request"](request);
      const response = {
        kind: "primary",
        request: request.request,
        response: new Response(stream, {
          status,
          headers: {
            "content-type":
              status === 200 ? "text/event-stream" : "application/json",
          },
        }),
      };
      const done = hooks["http.response"](response);
      return { request: request.request, response, done };
    },
  };
}

test("플러그인은 상류 스트림을 이벤트로 넘기고 OpenCode에는 빈 종료 응답만 준다", async (t) => {
  const h = await harness(t);
  const title = {};
  await h.hooks.title(title);
  assert.equal(title.result, "gateway");
  const retry = { decision: { retry: true, delay: 1 } };
  await h.hooks.retry(retry);
  assert.deepEqual(retry.decision, { retry: false });
  const { request, response, done } = await h.send(
    sse(
      chunk({ reasoning_content: "생각" }),
      chunk({ content: "확인" }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_a",
            function: { name: "lookup", arguments: '{"key":"v"}' },
          },
        ],
      }),
      chunk({}, "tool_calls"),
      usage,
    ),
  );
  await done;
  const sent = JSON.parse(await request.text());
  assert.deepEqual(
    sent.messages.slice(0, 3).map((m) => m.content),
    ["OpenCode harness", "Environment", "Caller system"],
  );
  assert.deepEqual(
    sent.tools.map((tool) => tool.function.name),
    ["lookup", "read"],
  );
  assert.equal(request.headers.get("x-opencode-client"), "cli");
  const terminal = await response.response.text();
  assert.match(terminal, /"finish_reason":"stop"/);
  assert.doesNotMatch(terminal, /tool_calls/);
  await h.settle();
  assert.deepEqual(h.events, [
    { type: "gateway.attempt", step: 0 },
    { type: "gateway.delta", kind: "reasoning", text: "생각" },
    { type: "gateway.delta", kind: "text", text: "확인" },
    {
      type: "gateway.call",
      id: "call_a",
      name: "lookup",
      arguments: { key: "v" },
    },
    {
      type: "gateway.step",
      reason: "tool_calls",
      tokens: {
        input: 60,
        output: 20,
        reasoning: 10,
        cache: { read: 40, write: 0 },
      },
    },
  ]);
  await assert.rejects(
    async () => h.hooks["tool.execute.before"]({ tool: "shell" }),
    /disabled by the gateway/,
  );
  await h.settle();
  assert.equal(h.events.at(-1).code, "native_tool_execution");
});

test("상류 오류 응답은 상태와 메시지를 그대로 알린다", async (t) => {
  const h = await harness(t);
  const { done } = await h.send(
    JSON.stringify({
      type: "error",
      error: {
        type: "FreeUsageLimitError",
        message: "Free usage limit reached.",
      },
    }),
    429,
  );
  await done;
  await h.settle();
  assert.deepEqual(h.events.at(-1), {
    type: "gateway.upstream_error",
    status: 429,
    message: "Free usage limit reached.",
  });
});

test("출력 없이 OpenCode read만 부르면 다시 묻고, 계속되면 내장 도구 호출로 실패한다", async (t) => {
  const readOnly = sse(
    chunk({
      tool_calls: [
        { index: 0, id: "r1", function: { name: "read", arguments: "{}" } },
      ],
    }),
    chunk({}, "tool_calls"),
  );
  const answered = await harness(t);
  const fetched = [];
  globalThis.fetch = async (url, init) => {
    fetched.push([url, init.body]);
    return new Response(sse(chunk({ content: "다시" }, "stop"), usage));
  };
  const first = await answered.send(readOnly);
  await first.done;
  await answered.settle();
  assert.equal(fetched.length, 1);
  assert.equal(JSON.parse(fetched[0][1]).messages.at(-1).content, "질문");
  assert.deepEqual(
    answered.events.map((event) => event.type),
    ["gateway.attempt", "gateway.attempt", "gateway.delta", "gateway.step"],
  );
  assert.equal(answered.events.at(-1).reason, "stop");

  const stuck = await harness(t);
  globalThis.fetch = async () => new Response(readOnly);
  void (await stuck.send(readOnly)).done;
  await stuck.settle();
  assert.deepEqual(stuck.events.at(-1), {
    type: "gateway.native_call",
    name: "read",
  });
  assert.equal(
    stuck.events.filter((event) => event.type === "gateway.attempt").length,
    3,
  );
});

test("본문을 말한 뒤 read를 부르면 본문만 정상 종료로 돌려준다", async (t) => {
  const h = await harness(t, { tools: [], toolChoice: "none" });
  const { done } = await h.send(
    sse(
      chunk({ content: "답" }),
      chunk({
        tool_calls: [
          { index: 0, id: "r1", function: { name: "read", arguments: "{}" } },
        ],
      }),
      chunk({}, "tool_calls"),
    ),
  );
  await done;
  await h.settle();
  assert.equal(h.events.at(-1).type, "gateway.step");
  assert.equal(h.events.at(-1).reason, "stop");
});

test("잘못된 함수 인자와 스트림 안의 오류는 명시적으로 실패한다", async (t) => {
  const invalid = await harness(t);
  void (
    await invalid.send(
      sse(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "c",
              function: { name: "lookup", arguments: "{bad" },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ),
    )
  ).done;
  await invalid.settle();
  assert.deepEqual(invalid.events.at(-1), {
    type: "gateway.native_call",
    name: "invalid",
  });

  const broken = await harness(t);
  void (
    await broken.send(
      sse(chunk({ content: "일부" }), { error: { message: "overloaded" } }),
    )
  ).done;
  await broken.settle();
  assert.deepEqual(broken.events.at(-1), {
    type: "gateway.upstream_error",
    status: 502,
    message: "overloaded",
  });
});
