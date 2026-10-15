import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { GatewayError } from "./errors.mjs";

const DEFAULT_MODEL_ID = "deepseek-v4.1-flash-free";
const MAX_STREAM_BUFFER_BYTES = 1024 * 1024;
const ROLES = new Set(["system", "developer", "user", "assistant"]);
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);
const MESSAGE_FIELDS = new Set(["role", "content"]);
const TEXT_PART_FIELDS = new Set(["type", "text"]);
const STREAM_FIELDS = new Set(["include_usage"]);
const REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stream",
  "stream_options",
  "store",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "n",
]);
const METADATA = Object.freeze({
  gateway: "opencode-cli-agent-text-relay",
  system_message_semantics:
    "system·developer 메시지는 네이티브 OpenCode 에이전트에게 전달되는 대화 기록이며 에이전트의 시스템 지시를 대체하지 않습니다.",
  streaming: "completed_text_parts",
  supports_tool_use: false,
  supports_vision: false,
});

function invalid(message, code = "invalid_request") {
  return new GatewayError(400, code, message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function has(object, key) {
  return Object.hasOwn(object, key);
}

function onlyFields(object, fields, label) {
  if (Object.keys(object).some((key) => !fields.has(key))) {
    throw invalid(
      `${label}에 지원하지 않는 필드가 있습니다.`,
      "unsupported_parameter",
    );
  }
}

function tokenLimit(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 8192) {
    throw invalid(`${label}은 1부터 8192 사이의 정수여야 합니다.`);
  }
  return value;
}

function sampling(value, min, max, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw invalid(`${label} 값의 타입이나 범위가 잘못되었습니다.`);
  }
  return value;
}

function normalizeMessage(message) {
  if (!isObject(message) || !ROLES.has(message.role)) {
    throw invalid(
      "메시지 역할은 system, developer, user, assistant만 지원합니다.",
    );
  }
  onlyFields(message, MESSAGE_FIELDS, "메시지");
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  if (!Array.isArray(message.content)) {
    throw invalid("메시지 내용은 문자열 또는 텍스트 파트 배열이어야 합니다.");
  }
  const content = message.content
    .map((part) => {
      if (
        !isObject(part) ||
        !TEXT_PART_TYPES.has(part.type) ||
        typeof part.text !== "string"
      ) {
        throw invalid(
          "이미지·오디오·도구 호출은 지원하지 않으며 텍스트 파트만 허용합니다.",
          "unsupported_content",
        );
      }
      onlyFields(part, TEXT_PART_FIELDS, "텍스트 파트");
      return part.text;
    })
    .join("");
  return { role: message.role, content };
}

function normalizeRequest(body, modelId) {
  if (!isObject(body)) throw invalid("요청 본문은 JSON 객체여야 합니다.");
  onlyFields(body, REQUEST_FIELDS, "요청");
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw invalid("model은 비어 있지 않은 문자열이어야 합니다.");
  }
  if (body.model !== modelId) {
    throw new GatewayError(
      404,
      "model_not_found",
      "요청한 모델을 제공하지 않습니다.",
    );
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalid("messages는 비어 있지 않은 배열이어야 합니다.");
  }
  if (
    has(body, "tools") &&
    (!Array.isArray(body.tools) || body.tools.length !== 0)
  ) {
    throw invalid("외부 함수 tools는 지원하지 않습니다.", "unsupported_tools");
  }
  if (
    has(body, "tool_choice") &&
    body.tool_choice !== "auto" &&
    body.tool_choice !== "none"
  ) {
    throw invalid("강제 도구 선택은 지원하지 않습니다.", "unsupported_tools");
  }
  if (has(body, "parallel_tool_calls") && body.parallel_tool_calls !== false) {
    throw invalid(
      "병렬 도구 호출은 지원하지 않으며 false만 허용합니다.",
      "unsupported_tools",
    );
  }
  if (has(body, "n") && body.n !== 1) {
    throw invalid("n은 정수 1만 지원합니다.", "unsupported_parameter");
  }
  if (has(body, "store") && body.store !== false) {
    throw invalid(
      "응답 저장은 지원하지 않으며 store: false만 허용합니다.",
      "unsupported_parameter",
    );
  }
  if (has(body, "stream") && typeof body.stream !== "boolean") {
    throw invalid("stream은 불리언이어야 합니다.");
  }
  const stream = body.stream === true;
  let includeUsage = false;
  if (has(body, "stream_options")) {
    if (!stream || !isObject(body.stream_options)) {
      throw invalid(
        "stream_options는 stream: true일 때만 객체로 지정할 수 있습니다.",
      );
    }
    onlyFields(body.stream_options, STREAM_FIELDS, "stream_options");
    if (has(body.stream_options, "include_usage")) {
      if (typeof body.stream_options.include_usage !== "boolean") {
        throw invalid("stream_options.include_usage는 불리언이어야 합니다.");
      }
      includeUsage = body.stream_options.include_usage;
    }
  }
  if (has(body, "max_tokens")) tokenLimit(body.max_tokens, "max_tokens");
  if (has(body, "max_completion_tokens"))
    tokenLimit(body.max_completion_tokens, "max_completion_tokens");
  if (
    has(body, "max_tokens") &&
    has(body, "max_completion_tokens") &&
    body.max_tokens !== body.max_completion_tokens
  ) {
    throw invalid("max_tokens와 max_completion_tokens의 값이 서로 충돌합니다.");
  }
  const normalized = {
    modelId,
    messages: body.messages.map(normalizeMessage),
    maxOutputTokens: body.max_completion_tokens ?? body.max_tokens ?? 1024,
  };
  if (has(body, "temperature"))
    normalized.temperature = sampling(body.temperature, 0, 2, "temperature");
  if (has(body, "top_p")) normalized.topP = sampling(body.top_p, 0, 1, "top_p");
  return { normalized, stream, includeUsage };
}

function readJson(req, maxBodyBytes, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  const length = req.headers["content-length"];
  if (length !== undefined && Number(length) > maxBodyBytes) {
    req.resume();
    return Promise.reject(
      new GatewayError(
        413,
        "body_too_large",
        "요청 본문 크기 상한을 초과했습니다.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error) => {
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        fail(
          new GatewayError(
            413,
            "body_too_large",
            "요청 본문 크기 상한을 초과했습니다.",
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, size),
        );
        resolve(JSON.parse(text));
      } catch {
        reject(invalid("올바른 UTF-8 JSON 본문이 필요합니다.", "invalid_json"));
      }
    };
    const onError = () => fail(invalid("요청 본문을 읽을 수 없습니다."));
    const onAborted = () =>
      fail(
        new GatewayError(
          499,
          "client_disconnected",
          "클라이언트 연결이 종료되었습니다.",
        ),
      );
    const onAbort = () => fail(signal.reason);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function publicError(error) {
  if (
    error instanceof GatewayError &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
  ) {
    return error;
  }
  return new GatewayError(
    502,
    "upstream_error",
    "네이티브 OpenCode 실행에 실패했습니다.",
  );
}

function errorBody(error) {
  let type = "invalid_request_error";
  if (error.status === 401) type = "authentication_error";
  else if (error.status === 429) type = "rate_limit_error";
  else if (error.status >= 500) type = "server_error";
  return {
    error: { message: error.message, type, param: null, code: error.code },
  };
}

function sendJson(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}

function checkResult(result) {
  if (
    !isObject(result) ||
    typeof result.text !== "string" ||
    !["stop", "length"].includes(result.finishReason)
  ) {
    throw new GatewayError(
      502,
      "invalid_runner_result",
      "네이티브 실행 결과 형식이 잘못되었습니다.",
    );
  }
  if (
    !isObject(result.usage) ||
    ["prompt_tokens", "completion_tokens", "total_tokens"].some(
      (key) =>
        !Number.isSafeInteger(result.usage[key]) || result.usage[key] < 0,
    )
  ) {
    throw new GatewayError(
      502,
      "invalid_runner_result",
      "네이티브 토큰 사용량 형식이 잘못되었습니다.",
    );
  }
}

export function createGateway({
  token,
  modelId = DEFAULT_MODEL_ID,
  run,
  maxWorkers = 4,
  timeoutMs = 120000,
  maxBodyBytes = 1048576,
}) {
  if (typeof token !== "string" || token.length === 0 || /\s/.test(token)) {
    throw new TypeError(
      "token은 공백 없는 비어 있지 않은 문자열이어야 합니다.",
    );
  }
  if (
    typeof modelId !== "string" ||
    modelId.trim().length === 0 ||
    typeof run !== "function"
  ) {
    throw new TypeError("유효한 modelId와 run 함수가 필요합니다.");
  }
  if (
    !Number.isSafeInteger(maxWorkers) ||
    maxWorkers < 1 ||
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1
  ) {
    throw new TypeError(
      "maxWorkers와 maxBodyBytes는 양의 안전한 정수여야 합니다.",
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new TypeError("timeoutMs는 1부터 2147483647 사이의 정수여야 합니다.");
  }
  const expectedToken = createHash("sha256").update(token).digest();
  const modelCreated = Math.floor(Date.now() / 1000);
  let active = 0;

  function authenticated(req) {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "");
    const actualToken = createHash("sha256")
      .update(match?.[1] ?? "")
      .digest();
    return timingSafeEqual(expectedToken, actualToken) && match !== null;
  }

  async function complete(req, res, requestId, created) {
    const controller = new AbortController();
    const { signal } = controller;
    const id = `chatcmpl-${requestId}`;
    let terminal = false;
    let disconnected = false;
    let admitted = false;
    let stream = false;
    let includeUsage = false;
    let streamStarted = false;
    const abort = (reason) => {
      if (!signal.aborted) controller.abort(reason);
    };
    const onDisconnected = () => {
      if (res.writableFinished) return;
      disconnected = true;
      terminal = true;
      abort(
        new GatewayError(
          499,
          "client_disconnected",
          "클라이언트 연결이 종료되었습니다.",
        ),
      );
    };
    const writable = () =>
      !terminal && !disconnected && !res.destroyed && !res.writableEnded;
    const writeFrame = (frame) => {
      if (!writable()) {
        throw (
          signal.reason ??
          new GatewayError(
            499,
            "client_disconnected",
            "응답 대상 연결이 종료되었습니다.",
          )
        );
      }
      if (
        res.writableLength + Buffer.byteLength(frame) >
        MAX_STREAM_BUFFER_BYTES
      ) {
        const error = new GatewayError(
          502,
          "stream_backpressure",
          "스트림 송신 버퍼 상한을 초과했습니다.",
        );
        abort(error);
        terminal = true;
        disconnected = true;
        res.destroy();
        throw error;
      }
      res.write(frame);
    };
    const writeEvent = (event) =>
      writeFrame(`data: ${JSON.stringify(event)}\n\n`);
    const chunk = (choices, extra = {}) => ({
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices,
      ...(includeUsage ? { usage: null } : {}),
      ...extra,
    });
    const beginStream = () => {
      if (streamStarted) return;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      });
      streamStarted = true;
      writeEvent(
        chunk(
          [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: null,
            },
          ],
          { metadata: METADATA },
        ),
      );
    };
    const sendFailure = (original) => {
      if (!writable()) return;
      const error = publicError(original);
      if (streamStarted) {
        try {
          writeFrame(
            `event: error\ndata: ${JSON.stringify(errorBody(error))}\n\n`,
          );
          terminal = true;
          res.end();
        } catch {
          res.destroy();
        }
      } else {
        terminal = true;
        if (error.status === 413 || error.status === 504)
          res.shouldKeepAlive = false;
        sendJson(
          res,
          error.status,
          errorBody(error),
          error.status === 429 ? { "retry-after": "1" } : {},
        );
      }
    };
    const timer = setTimeout(() => {
      const error = new GatewayError(
        504,
        "request_timeout",
        "OpenCode 요청 제한 시간을 초과했습니다.",
      );
      abort(error);
      sendFailure(error);
    }, timeoutMs);
    timer.unref();
    req.once("aborted", onDisconnected);
    req.once("error", onDisconnected);
    res.once("close", onDisconnected);
    res.once("error", onDisconnected);
    try {
      const parsed = normalizeRequest(
        await readJson(req, maxBodyBytes, signal),
        modelId,
      );
      ({ stream, includeUsage } = parsed);
      signal.throwIfAborted();
      if (active >= maxWorkers) {
        throw new GatewayError(
          429,
          "workers_busy",
          "모든 OpenCode 워커가 사용 중입니다.",
        );
      }
      active += 1;
      admitted = true;
      const onText = (text) => {
        signal.throwIfAborted();
        if (typeof text !== "string") {
          throw new GatewayError(
            502,
            "invalid_runner_result",
            "네이티브 텍스트 파트 형식이 잘못되었습니다.",
          );
        }
        if (!stream || text.length === 0) return;
        if (Buffer.byteLength(text) > MAX_STREAM_BUFFER_BYTES) {
          const error = new GatewayError(
            502,
            "stream_backpressure",
            "스트림 텍스트 파트 크기 상한을 초과했습니다.",
          );
          abort(error);
          throw error;
        }
        beginStream();
        writeEvent(
          chunk([{ index: 0, delta: { content: text }, finish_reason: null }]),
        );
      };
      const result = await run(parsed.normalized, { signal, onText });
      signal.throwIfAborted();
      if (!writable()) return;
      checkResult(result);
      if (stream) {
        if (!streamStarted && result.text.length > 0) onText(result.text);
        beginStream();
        writeEvent(
          chunk([{ index: 0, delta: {}, finish_reason: result.finishReason }]),
        );
        if (includeUsage) writeEvent(chunk([], { usage: result.usage }));
        writeFrame("data: [DONE]\n\n");
        terminal = true;
        res.end();
      } else {
        terminal = true;
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.text },
              finish_reason: result.finishReason,
            },
          ],
          usage: result.usage,
          metadata: METADATA,
        });
      }
    } catch (error) {
      sendFailure(error);
    } finally {
      clearTimeout(timer);
      req.off("aborted", onDisconnected);
      req.off("error", onDisconnected);
      res.off("close", onDisconnected);
      res.off("error", onDisconnected);
      if (admitted) active -= 1;
    }
  }

  return createServer((req, res) => {
    const requestId = randomUUID();
    const created = Math.floor(Date.now() / 1000);
    res.setHeader("x-request-id", requestId);
    res.setHeader("cache-control", "no-store");
    req.on("error", () => res.destroy());
    res.on("error", () => res.destroy());
    const handle = async () => {
      let pathname;
      try {
        pathname = new URL(req.url, "http://gateway.invalid").pathname;
      } catch {
        throw invalid("요청 URL 형식이 잘못되었습니다.");
      }
      if (pathname === "/healthz") {
        req.resume();
        if (req.method !== "GET") {
          sendJson(
            res,
            405,
            errorBody(
              new GatewayError(405, "method_not_allowed", "GET만 허용합니다."),
            ),
            { allow: "GET" },
          );
        } else {
          sendJson(res, 200, { status: "ok", active, maxWorkers });
        }
        return;
      }
      if (pathname !== "/v1/models" && pathname !== "/v1/chat/completions") {
        throw new GatewayError(
          404,
          "not_found",
          "요청한 경로를 찾을 수 없습니다.",
        );
      }
      if (!authenticated(req)) {
        throw new GatewayError(
          401,
          "invalid_api_key",
          "올바른 Bearer 인증이 필요합니다.",
        );
      }
      const method = pathname === "/v1/models" ? "GET" : "POST";
      if (req.method !== method) {
        req.resume();
        sendJson(
          res,
          405,
          errorBody(
            new GatewayError(
              405,
              "method_not_allowed",
              `${method}만 허용합니다.`,
            ),
          ),
          { allow: method },
        );
        return;
      }
      if (pathname === "/v1/models") {
        req.resume();
        sendJson(res, 200, {
          object: "list",
          data: [
            {
              id: modelId,
              object: "model",
              created: modelCreated,
              owned_by: "opencode-cli-gateway",
              supports_tool_use: false,
              supports_vision: false,
              metadata: METADATA,
            },
          ],
        });
        return;
      }
      await complete(req, res, requestId, created);
    };
    void handle().catch((original) => {
      req.resume();
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const error = publicError(original);
      sendJson(
        res,
        error.status,
        errorBody(error),
        error.status === 401 ? { "www-authenticate": "Bearer" } : {},
      );
    });
  });
}
