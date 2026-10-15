import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import {
  setImmediate as nextTurn,
  setTimeout as delay,
} from "node:timers/promises";
import test from "node:test";
import { GatewayError } from "./errors.mjs";
import { createGateway } from "./server.mjs";

const TOKEN = "test-only-secret-token";
const MODEL = "deepseek-v4.1-flash-free";
const USAGE = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function result(text = "응답", finishReason = "stop") {
  return { text, finishReason, usage: { ...USAGE }, cost: 0 };
}

function input(overrides = {}) {
  return {
    model: MODEL,
    messages: [{ role: "user", content: "질문" }],
    ...overrides,
  };
}

async function fixture(t, options = {}) {
  const server = createGateway({
    token: TOKEN,
    run: async () => result(),
    ...options,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    const closed = new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  });
  return server;
}

function request(
  server,
  { path = "/healthz", method = "GET", token = TOKEN, body, headers = {} } = {},
) {
  const payload =
    body === undefined
      ? undefined
      : typeof body === "string" || Buffer.isBuffer(body)
        ? body
        : JSON.stringify(body);
  const requestHeaders = {
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    ...(payload === undefined
      ? {}
      : {
          "content-type": "application/json",
          ...(headers["transfer-encoding"]
            ? {}
            : { "content-length": Buffer.byteLength(payload) }),
        }),
    ...headers,
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.address().port,
        path,
        method,
        headers: requestHeaders,
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (part) => {
          text += part;
        });
        res.once("error", reject);
        res.once("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text }),
        );
      },
    );
    req.setTimeout(4000, () =>
      req.destroy(new Error("시험 HTTP 요청 제한 시간 초과")),
    );
    req.once("error", reject);
    req.end(payload);
  });
}

function chat(server, body = input(), options = {}) {
  return request(server, {
    path: "/v1/chat/completions",
    method: "POST",
    body,
    ...options,
  });
}

function json(response) {
  return JSON.parse(response.text);
}

function events(response) {
  return response.text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split("\n");
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      return {
        event:
          lines.find((line) => line.startsWith("event: "))?.slice(7) ??
          "message",
        data: data === "[DONE]" ? data : JSON.parse(data),
      };
    });
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve(signal.reason);
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(signal.reason), {
      once: true,
    }),
  );
}

async function waitActive(server, expected) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const response = await request(server);
    if (json(response).active === expected) return;
    await delay(5);
  }
  assert.fail(`active가 ${expected}(으)로 복구되지 않았습니다.`);
}

test(
  "공개 상태는 비밀 없이 워커 수만 노출하고 보호 경로는 Bearer를 검사한다",
  { timeout: 5000 },
  async (t) => {
    let calls = 0;
    const server = await fixture(t, {
      maxWorkers: 2,
      run: async () => {
        calls += 1;
        return result();
      },
    });
    const health = await request(server, { token: null });
    assert.equal(health.status, 200);
    assert.deepEqual(json(health), { status: "ok", active: 0, maxWorkers: 2 });
    assert.equal(health.text.includes(TOKEN), false);
    for (const authorization of [
      undefined,
      "Basic invalid",
      "Bearer wrong",
      "Bearer ",
      "Bearer a b",
    ]) {
      const options = {
        token: null,
        headers: authorization === undefined ? {} : { authorization },
      };
      for (const response of [
        await request(server, { path: "/v1/models", ...options }),
        await chat(server, input(), options),
      ]) {
        assert.equal(response.status, 401);
        assert.equal(response.headers["www-authenticate"], "Bearer");
        assert.equal(json(response).error.code, "invalid_api_key");
        assert.equal(response.text.includes(TOKEN), false);
      }
    }
    const success = await chat(server);
    assert.equal(success.status, 200);
    assert.equal(calls, 1);
  },
);

test(
  "모델 목록은 도구·이미지 미지원을 광고하고 모델 불일치는 실행 전에 404이다",
  { timeout: 5000 },
  async (t) => {
    let calls = 0;
    const server = await fixture(t, {
      run: async () => {
        calls += 1;
        return result();
      },
    });
    const response = await request(server, { path: "/v1/models" });
    assert.equal(response.status, 200);
    const models = json(response);
    assert.equal(models.object, "list");
    assert.equal(models.data.length, 1);
    assert.equal(models.data[0].id, MODEL);
    assert.equal(models.data[0].object, "model");
    assert.equal(models.data[0].supports_tool_use, false);
    assert.equal(models.data[0].supports_vision, false);
    assert.match(models.data[0].metadata.system_message_semantics, /대화 기록/);
    const missing = await chat(server, input({ model: "다른-모델" }));
    assert.equal(missing.status, 404);
    assert.equal(json(missing).error.code, "model_not_found");
    assert.equal(calls, 0);
  },
);

test(
  "경로와 HTTP 메서드는 명시적인 404·405 및 Allow를 반환한다",
  { timeout: 5000 },
  async (t) => {
    const server = await fixture(t);
    for (const [path, method, allow] of [
      ["/healthz", "POST", "GET"],
      ["/v1/models", "POST", "GET"],
      ["/v1/chat/completions", "GET", "POST"],
      ["/v1/chat/completions", "PUT", "POST"],
    ]) {
      const response = await request(server, { path, method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, allow);
      assert.equal(json(response).error.code, "method_not_allowed");
    }
    const unknown = await request(server, {
      path: "/does-not-exist",
      token: null,
    });
    assert.equal(unknown.status, 404);
    assert.equal(json(unknown).error.code, "not_found");
  },
);

test(
  "잘못된 JSON·UTF-8과 길이 헤더·청크 본문 상한을 거절한다",
  { timeout: 5000 },
  async (t) => {
    let calls = 0;
    const server = await fixture(t, {
      maxBodyBytes: 256,
      run: async () => {
        calls += 1;
        return result();
      },
    });
    for (const body of [
      "{",
      "",
      "null",
      "[]",
      Buffer.concat([
        Buffer.from(
          `{"model":"${MODEL}","messages":[{"role":"user","content":"`,
        ),
        Buffer.from([0xff]),
        Buffer.from('"}]}'),
      ]),
    ]) {
      const response = await chat(server, body);
      assert.equal(response.status, 400);
    }
    const tooLarge = "가".repeat(100);
    for (const headers of [{}, { "transfer-encoding": "chunked" }]) {
      const response = await chat(server, tooLarge, { headers });
      assert.equal(response.status, 413);
      assert.equal(json(response).error.code, "body_too_large");
    }
    assert.equal(calls, 0);
    assert.equal((await chat(server)).status, 200);
  },
);

test(
  "텍스트·역할·샘플링과 출력 토큰을 보존하고 비활성 도구 선언은 허용한다",
  { timeout: 5000 },
  async (t) => {
    const received = [];
    const server = await fixture(t, {
      run: async (normalized) => {
        received.push(normalized);
        return result();
      },
    });
    const messages = [
      { role: "system", content: "시스템 대화 기록" },
      { role: "developer", content: [{ type: "text", text: "개발자 기록" }] },
      {
        role: "user",
        content: [
          { type: "input_text", text: "질문 " },
          { type: "text", text: "둘" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "이전 응답" }],
      },
    ];
    const response = await chat(
      server,
      input({
        messages,
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        n: 1,
        temperature: 0,
        top_p: 1,
        max_completion_tokens: 8192,
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(received[0], {
      modelId: MODEL,
      messages: [
        { role: "system", content: "시스템 대화 기록" },
        { role: "developer", content: "개발자 기록" },
        { role: "user", content: "질문 둘" },
        { role: "assistant", content: "이전 응답" },
      ],
      maxOutputTokens: 8192,
      temperature: 0,
      topP: 1,
    });
    assert.match(
      json(response).metadata.system_message_semantics,
      /네이티브 OpenCode 에이전트.*대화 기록/,
    );
    assert.equal(json(response).metadata.streaming, "completed_text_parts");
    assert.equal(
      (
        await chat(
          server,
          input({
            tools: [],
            tool_choice: "none",
            parallel_tool_calls: false,
            max_tokens: 1,
            max_completion_tokens: 1,
            temperature: 2,
            top_p: 0,
          }),
        )
      ).status,
      200,
    );
    assert.equal(received[1].maxOutputTokens, 1);
    assert.equal(received[1].temperature, 2);
    assert.equal(received[1].topP, 0);
  },
);

test(
  "도구·멀티모달과 지원하지 않는 제어 및 잘못된 타입·범위는 실행 전에 400이다",
  { timeout: 5000 },
  async (t) => {
    let calls = 0;
    const server = await fixture(t, {
      run: async () => {
        calls += 1;
        return result();
      },
    });
    const cases = [
      ["모델 생략", { model: undefined }],
      ["모델 타입", { model: 1 }],
      ["빈 모델", { model: "" }],
      ["빈 메시지", { messages: [] }],
      ["메시지 타입", { messages: {} }],
      ["null 메시지", { messages: [null] }],
      ["도구 역할", { messages: [{ role: "tool", content: "결과" }] }],
      ["역할 타입", { messages: [{ role: 1, content: "내용" }] }],
      [
        "이미지",
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "https://invalid.test/image" },
                },
              ],
            },
          ],
        },
      ],
      ["빈 파트", { messages: [{ role: "user", content: [{}] }] }],
      [
        "파트 타입",
        { messages: [{ role: "user", content: [{ type: "text", text: 3 }] }] },
      ],
      ["내용 타입", { messages: [{ role: "user", content: null }] }],
      [
        "어시스턴트 도구 호출",
        { messages: [{ role: "assistant", content: "", tool_calls: [] }] },
      ],
      [
        "함수 호출",
        {
          messages: [
            { role: "assistant", content: "", function_call: { name: "f" } },
          ],
        },
      ],
      ["도구 선언", { tools: [{ type: "function", function: { name: "f" } }] }],
      ["도구 타입", { tools: {} }],
      ["도구 null", { tools: null }],
      ["필수 도구", { tool_choice: "required" }],
      [
        "강제 함수",
        { tool_choice: { type: "function", function: { name: "f" } } },
      ],
      ["도구 선택 null", { tool_choice: null }],
      ["병렬 도구", { parallel_tool_calls: true }],
      ["병렬 도구 타입", { parallel_tool_calls: null }],
      ["응답 저장", { store: true }],
      ["응답 저장 타입", { store: "false" }],
      ["응답 저장 null", { store: null }],
      ["stop", { stop: ["끝"] }],
      ["response_format", { response_format: { type: "json_object" } }],
      ["seed", { seed: 1 }],
      ["logprobs", { logprobs: false }],
      ["여러 응답", { n: 2 }],
      ["n 타입", { n: "1" }],
      ["n 영", { n: 0 }],
      ["음수 온도", { temperature: -0.01 }],
      ["큰 온도", { temperature: 2.01 }],
      ["온도 타입", { temperature: "1" }],
      ["온도 null", { temperature: null }],
      ["음수 top_p", { top_p: -0.01 }],
      ["큰 top_p", { top_p: 1.01 }],
      ["top_p 타입", { top_p: false }],
      ["출력 제한 영", { max_tokens: 0 }],
      ["출력 제한 초과", { max_tokens: 8193 }],
      ["출력 제한 소수", { max_tokens: 1.5 }],
      ["출력 제한 문자열", { max_tokens: "10" }],
      ["출력 제한 null", { max_completion_tokens: null }],
      ["출력 제한 충돌", { max_tokens: 10, max_completion_tokens: 11 }],
      ["스트림 타입", { stream: "true" }],
      ["스트림 null", { stream: null }],
      ["비스트림 옵션", { stream_options: { include_usage: true } }],
      ["스트림 옵션 타입", { stream: true, stream_options: [] }],
      [
        "사용량 옵션 타입",
        { stream: true, stream_options: { include_usage: "true" } },
      ],
      [
        "알 수 없는 스트림 옵션",
        { stream: true, stream_options: { other: true } },
      ],
    ];
    for (const [label, overrides] of cases) {
      const response = await chat(server, input(overrides));
      assert.equal(response.status, 400, label);
      assert.equal(json(response).error.type, "invalid_request_error", label);
    }
    assert.equal(calls, 0);
  },
);

test(
  "비스트림은 실제 runner 텍스트·사용량·종료 사유와 고유 ID를 반환한다",
  { timeout: 5000 },
  async (t) => {
    const before = Math.floor(Date.now() / 1000);
    const server = await fixture(t, {
      run: async (_normalized, { onText }) => {
        onText("완성된 답");
        return result("완성된 답", "length");
      },
    });
    const response = await chat(server);
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^application\/json/);
    const completion = json(response);
    assert.match(
      completion.id,
      /^chatcmpl-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(completion.id, `chatcmpl-${response.headers["x-request-id"]}`);
    assert.equal(completion.object, "chat.completion");
    assert.equal(completion.model, MODEL);
    assert.ok(
      Number.isInteger(completion.created) &&
        completion.created >= before &&
        completion.created <= Math.floor(Date.now() / 1000),
    );
    assert.deepEqual(completion.choices, [
      {
        index: 0,
        message: { role: "assistant", content: "완성된 답" },
        finish_reason: "length",
      },
    ]);
    assert.deepEqual(completion.usage, USAGE);
    const second = json(await chat(server));
    assert.notEqual(second.id, completion.id);
  },
);

test(
  "SSE는 완성 텍스트 파트와 종료 청크·요청된 usage·DONE을 보낸다",
  { timeout: 5000 },
  async (t) => {
    const server = await fixture(t, {
      run: async (_normalized, { onText }) => {
        onText("첫 ");
        await nextTurn();
        onText("응답");
        return result("첫 응답", "length");
      },
    });
    const response = await chat(
      server,
      input({ stream: true, stream_options: { include_usage: true } }),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^text\/event-stream/);
    const parsed = events(response);
    assert.equal(parsed.at(-1).data, "[DONE]");
    assert.equal(parsed.filter((entry) => entry.data === "[DONE]").length, 1);
    const chunks = parsed.slice(0, -1).map((entry) => entry.data);
    assert.equal(chunks[0].choices[0].delta.role, "assistant");
    assert.match(chunks[0].metadata.system_message_semantics, /대화 기록/);
    assert.deepEqual(
      chunks.slice(1, 3).map((entry) => entry.choices[0].delta.content),
      ["첫 ", "응답"],
    );
    assert.equal(chunks.at(-2).choices[0].finish_reason, "length");
    assert.deepEqual(chunks.at(-1).choices, []);
    assert.deepEqual(chunks.at(-1).usage, USAGE);
    for (const chunk of chunks) {
      assert.equal(chunk.object, "chat.completion.chunk");
      assert.equal(chunk.id, `chatcmpl-${response.headers["x-request-id"]}`);
      assert.equal(chunk.created, chunks[0].created);
      assert.ok(Number.isInteger(chunk.created));
      assert.equal(chunk.model, MODEL);
    }
    for (const chunk of chunks.slice(0, -1)) assert.equal(chunk.usage, null);
  },
);

test(
  "사용량 미요청 SSE와 빈 출력도 올바르게 종료한다",
  { timeout: 5000 },
  async (t) => {
    for (const text of ["", "완성 결과"]) {
      const server = await fixture(t, { run: async () => result(text) });
      const response = await chat(
        server,
        input({ stream: true, stream_options: { include_usage: false } }),
      );
      const parsed = events(response);
      assert.equal(response.status, 200);
      assert.equal(parsed.at(-1).data, "[DONE]");
      const chunks = parsed.slice(0, -1).map((entry) => entry.data);
      assert.equal(
        chunks.map((entry) => entry.choices[0].delta.content ?? "").join(""),
        text,
      );
      assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
      assert.ok(chunks.every((entry) => !Object.hasOwn(entry, "usage")));
    }
  },
);

test(
  "첫 텍스트 전 오류는 스트림에서도 정확한 HTTP 상태이며 비공개 오류는 가린다",
  { timeout: 5000 },
  async (t) => {
    const server = await fixture(t, {
      run: async (_normalized, { onText }) => {
        onText("");
        throw new GatewayError(
          503,
          "cli_unavailable",
          "네이티브 CLI를 사용할 수 없습니다.",
        );
      },
    });
    for (const stream of [false, true]) {
      const response = await chat(server, input({ stream }));
      assert.equal(response.status, 503);
      assert.match(response.headers["content-type"], /^application\/json/);
      assert.equal(json(response).error.code, "cli_unavailable");
      assert.equal(
        json(response).error.message,
        "네이티브 CLI를 사용할 수 없습니다.",
      );
    }
    const privateServer = await fixture(t, {
      run: async () => {
        throw new Error(`${TOKEN} CLI stderr 본문 비밀`);
      },
    });
    const response = await chat(privateServer, input({ stream: true }));
    assert.equal(response.status, 502);
    assert.equal(json(response).error.code, "upstream_error");
    assert.equal(response.text.includes(TOKEN), false);
    assert.equal(response.text.includes("CLI stderr"), false);
  },
);

test(
  "첫 텍스트 뒤 실패는 성공 DONE 대신 SSE 오류를 보내고 닫는다",
  { timeout: 5000 },
  async (t) => {
    const server = await fixture(t, {
      run: async (_normalized, { onText }) => {
        onText("부분 결과");
        throw new GatewayError(
          502,
          "cli_failed",
          "네이티브 실행이 중단되었습니다.",
        );
      },
    });
    const response = await chat(server, input({ stream: true }));
    assert.equal(response.status, 200);
    const parsed = events(response);
    assert.equal(parsed[1].data.choices[0].delta.content, "부분 결과");
    assert.equal(parsed.at(-1).event, "error");
    assert.equal(parsed.at(-1).data.error.code, "cli_failed");
    assert.equal(
      parsed.some((entry) => entry.data === "[DONE]"),
      false,
    );
    await waitActive(server, 0);
  },
);

test(
  "동시 입장은 maxWorkers까지만 허용하고 포화는 429와 Retry-After이다",
  { timeout: 5000 },
  async (t) => {
    const release = deferred();
    const bothStarted = deferred();
    let calls = 0;
    const server = await fixture(t, {
      maxWorkers: 2,
      run: async () => {
        calls += 1;
        if (calls === 2) bothStarted.resolve();
        await release.promise;
        return result();
      },
    });
    t.after(() => release.resolve());
    const first = chat(server);
    const second = chat(server);
    try {
      await bothStarted.promise;
      assert.equal(json(await request(server)).active, 2);
      const rejected = await chat(server);
      assert.equal(rejected.status, 429);
      assert.equal(rejected.headers["retry-after"], "1");
      assert.equal(json(rejected).error.code, "workers_busy");
      assert.equal(calls, 2);
    } finally {
      release.resolve();
      const accepted = await Promise.all([first, second]);
      assert.deepEqual(
        accepted.map((entry) => entry.status),
        [200, 200],
      );
    }
    await waitActive(server, 0);
    assert.equal((await chat(server)).status, 200);
    assert.equal(calls, 3);
  },
);

test(
  "시간 초과는 즉시 504·abort이며 runner 정리 전에는 슬롯을 해제하지 않는다",
  { timeout: 5000 },
  async (t) => {
    const cleanup = deferred();
    const started = deferred();
    const aborted = deferred();
    let calls = 0;
    let observedSignal;
    let observedOnText;
    const server = await fixture(t, {
      maxWorkers: 1,
      timeoutMs: 150,
      run: async (_normalized, { signal, onText }) => {
        calls += 1;
        if (calls > 1) return result();
        observedSignal = signal;
        observedOnText = onText;
        started.resolve();
        const reason = await waitForAbort(signal);
        aborted.resolve(reason);
        await cleanup.promise;
        return result("제한 시간 뒤 결과");
      },
    });
    t.after(() => cleanup.resolve());
    const pending = chat(server, input({ stream: true }));
    await started.promise;
    const response = await pending;
    assert.equal(response.status, 504);
    assert.equal(json(response).error.code, "request_timeout");
    const reason = await aborted.promise;
    assert.equal(reason.status, 504);
    assert.equal(observedSignal.aborted, true);
    assert.throws(
      () => observedOnText("늦은 파트"),
      (error) => error.status === 504,
    );
    assert.equal(json(await request(server)).active, 1);
    assert.equal((await chat(server)).status, 429);
    cleanup.resolve();
    await waitActive(server, 0);
    assert.equal((await chat(server)).status, 200);
    assert.equal(calls, 2);
  },
);

test(
  "스트림 도중 시간 초과는 SSE 오류와 abort를 보낸다",
  { timeout: 5000 },
  async (t) => {
    const aborted = deferred();
    const server = await fixture(t, {
      timeoutMs: 150,
      run: async (_normalized, { signal, onText }) => {
        onText("부분 결과");
        const reason = await waitForAbort(signal);
        aborted.resolve(reason);
        throw reason;
      },
    });
    const response = await chat(server, input({ stream: true }));
    assert.equal(response.status, 200);
    const parsed = events(response);
    assert.equal(parsed.at(-1).event, "error");
    assert.equal(parsed.at(-1).data.error.code, "request_timeout");
    assert.equal(
      parsed.some((entry) => entry.data === "[DONE]"),
      false,
    );
    assert.equal((await aborted.promise).status, 504);
    await waitActive(server, 0);
  },
);

test(
  "연결 종료는 비스트림·스트림 모두 abort하고 정리 후에만 워커가 복구된다",
  { timeout: 5000 },
  async (t) => {
    for (const stream of [false, true]) {
      await t.test(
        stream ? "스트림 연결 종료" : "비스트림 연결 종료",
        async (t) => {
          const started = deferred();
          const aborted = deferred();
          const cleanup = deferred();
          const responseStarted = deferred();
          let calls = 0;
          let observedSignal;
          const server = await fixture(t, {
            maxWorkers: 1,
            run: async (_normalized, { signal, onText }) => {
              calls += 1;
              if (calls > 1) return result();
              observedSignal = signal;
              if (stream) onText("부분 응답");
              started.resolve();
              const reason = await waitForAbort(signal);
              aborted.resolve(reason);
              await cleanup.promise;
              return result("연결 종료 뒤 결과");
            },
          });
          t.after(() => cleanup.resolve());
          const payload = JSON.stringify(input({ stream }));
          const client = httpRequest(
            {
              host: "127.0.0.1",
              port: server.address().port,
              path: "/v1/chat/completions",
              method: "POST",
              agent: false,
              headers: {
                authorization: `Bearer ${TOKEN}`,
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              },
            },
            (res) => {
              res.on("error", () => {});
              responseStarted.resolve(res);
            },
          );
          client.on("error", () => {});
          t.after(() => client.destroy());
          client.end(payload);
          await started.promise;
          if (stream) {
            const response = await responseStarted.promise;
            assert.equal(response.statusCode, 200);
            response.destroy();
          }
          client.destroy();
          assert.equal((await aborted.promise).code, "client_disconnected");
          assert.equal(observedSignal.aborted, true);
          assert.equal(json(await request(server)).active, 1);
          assert.equal((await chat(server)).status, 429);
          cleanup.resolve();
          await waitActive(server, 0);
          assert.equal((await chat(server)).status, 200);
        },
      );
    }
  },
);

test(
  "느린 SSE 소비자에는 유한 송신 상한을 적용하고 onText 예외도 정리한다",
  { timeout: 5000 },
  async (t) => {
    const overflowed = deferred();
    let observedSignal;
    const server = await fixture(t, {
      run: async (_normalized, { signal, onText }) => {
        observedSignal = signal;
        try {
          for (let index = 0; index < 64; index += 1)
            onText("가".repeat(32768));
          assert.fail("송신 버퍼 상한을 적용하지 않았습니다.");
        } catch (error) {
          overflowed.resolve(error);
          throw error;
        }
      },
    });
    const payload = JSON.stringify(input({ stream: true }));
    const client = httpRequest(
      {
        host: "127.0.0.1",
        port: server.address().port,
        path: "/v1/chat/completions",
        method: "POST",
        agent: false,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.on("error", () => {});
        res.pause();
      },
    );
    client.on("error", () => {});
    t.after(() => client.destroy());
    client.end(payload);
    const error = await overflowed.promise;
    assert.equal(error.code, "stream_backpressure");
    assert.equal(observedSignal.aborted, true);
    await waitActive(server, 0);
  },
);
