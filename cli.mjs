import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { GatewayError } from "./errors.mjs";

const PLUGIN = fileURLToPath(new URL("./plugin", import.meta.url));
const LINE_LIMIT = 4 * 1024 * 1024;
const UPSTREAM_STATUS = new Set([400, 401, 403, 404, 408, 413, 429, 503]);
const FINISH = {
  stop: "stop",
  length: "length",
  content_filter: "content_filter",
};

const isNamed = (choice) => typeof choice === "object" && choice !== null;
const failure = (code, message, status = 502) =>
  new GatewayError(status, code, message);
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;

// Chat Completions history for the upstream body. The plugin keeps
// OpenCode's own system prompt in front of these messages.
function chatMessage(message) {
  if (message.role === "system" || message.role === "developer")
    return { role: "system", content: message.content };
  if (message.role === "user") {
    const parts = message.parts ?? [{ type: "text", text: message.content }];
    if (parts.every((part) => part.type === "text"))
      return { role: "user", content: message.content };
    return {
      role: "user",
      content: parts.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image_url", image_url: { url: part.url } },
      ),
    };
  }
  if (message.role === "tool")
    return {
      role: "tool",
      tool_call_id: message.tool_call_id,
      content: message.content,
    };
  return {
    role: "assistant",
    content: message.content || (message.tool_calls ? null : ""),
    ...(message.reasoning_content !== undefined
      ? { reasoning_content: message.reasoning_content }
      : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  };
}

// The request file the plugin turns into the upstream body. Function
// definitions only travel when the caller lets the model call them.
export function pluginRequest(request) {
  const caller = request.tools.length > 0 && request.toolChoice !== "none";
  const params = {
    max_completion_tokens: request.maxOutputTokens,
    ...request.options,
  };
  if (request.temperature !== undefined)
    params.temperature = request.temperature;
  if (request.topP !== undefined) params.top_p = request.topP;
  return {
    messages: request.messages.map(chatMessage),
    tools: caller ? request.tools : [],
    toolChoice: caller ? request.toolChoice : "none",
    parallelToolCalls: request.parallelToolCalls,
    params,
  };
}

function usage(tokens) {
  const cache = tokens.cache ?? {};
  const prompt = count(tokens.input) + count(cache.read) + count(cache.write);
  const completion = count(tokens.output) + count(tokens.reasoning);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: count(cache.read) },
    completion_tokens_details: { reasoning_tokens: count(tokens.reasoning) },
  };
}

function lines(stream, limit, onLine, onOverflow) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > limit) return onOverflow();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  });
}

export function createCliRunner({
  executable,
  stateDir,
  cacheDir,
  maxWorkers = 4,
  spawnProcess = spawn,
  plugin = PLUGIN,
  rateRetryDelaysMs,
}) {
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1)
    throw new TypeError("유효한 워커 수가 필요합니다.");
  const runs = new Set();
  let stopped = false;

  async function execute(
    run,
    request,
    { signal, onText = () => {}, onReasoning = () => {}, onRetry = () => {} },
  ) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    run.work = await mkdtemp(join(stateDir, "request-"));
    const requestFile = join(run.work, "request.json");
    const spec = pluginRequest(request);
    await writeFile(requestFile, JSON.stringify(spec), {
      mode: 0o600,
      flag: "wx",
    });
    const declared = new Set(spec.tools.map((tool) => tool.function.name));
    const socketPath = join(run.work, "events.sock");
    // OpenCode reads its global config from XDG_CONFIG_HOME; the request and
    // event socket reach the plugin as its options, never through argv.
    const config = join(run.work, "config", "opencode");
    await mkdir(config, { recursive: true });
    await writeFile(
      join(config, "opencode.json"),
      JSON.stringify({
        plugins: [
          {
            package: plugin,
            options: {
              request: requestFile,
              socket: socketPath,
              ...(rateRetryDelaysMs ? { rateRetryDelaysMs } : {}),
            },
          },
        ],
        share: "disabled",
        autoupdate: false,
        snapshot: false,
      }),
      { mode: 0o600 },
    );

    const state = {
      step: -1,
      streamed: false,
      text: "",
      reasoning: "",
      calls: [],
      ids: new Set(),
    };
    let settle;
    const outcome = new Promise((resolve, reject) => {
      settle = (error, value) => {
        if (run.settled) return;
        run.settled = true;
        if (error) reject(error);
        else resolve(value);
      };
    });
    const fail = (error) => settle(error);
    run.fail = fail;

    const handle = (event) => {
      if (run.settled) return;
      switch (event.type) {
        case "gateway.attempt":
          // A repeated step index is the plugin asking the model again.
          // Output already sent to the caller cannot be withdrawn.
          if (event.step === state.step && state.streamed)
            return fail(
              failure(
                "upstream_retry_after_output",
                "출력 일부를 보낸 뒤 상류 재시도가 발생했습니다.",
              ),
            );
          if (event.step === state.step) {
            state.calls = [];
            state.ids.clear();
          }
          state.step = event.step;
          state.streamed = false;
          return;
        case "gateway.retry":
          try {
            onRetry({
              status: Number(event.status),
              retry: Number(event.retry),
              delayMs: Number(event.delayMs),
              retryAfter:
                typeof event.retryAfter === "string"
                  ? event.retryAfter.slice(0, 64)
                  : null,
            });
          } catch (error) {
            fail(error);
          }
          return;
        case "gateway.upstream_error": {
          const status = Number(event.status);
          return fail(
            new GatewayError(
              UPSTREAM_STATUS.has(status) ? status : 502,
              "upstream_error",
              String(event.message ?? "OpenCode upstream failed").slice(
                0,
                1000,
              ),
            ),
          );
        }
        case "gateway.delta":
          if (
            typeof event.text !== "string" ||
            !["text", "reasoning"].includes(event.kind)
          )
            return fail(
              failure(
                "invalid_cli_output",
                "네이티브 델타 형식이 잘못되었습니다.",
              ),
            );
          state.streamed = true;
          try {
            if (event.kind === "text") {
              state.text += event.text;
              onText(event.text);
            } else {
              state.reasoning += event.text;
              onReasoning(event.text);
            }
          } catch (error) {
            fail(error);
          }
          return;
        case "gateway.call": {
          if (
            !declared.has(event.name) ||
            typeof event.id !== "string" ||
            !event.id ||
            state.ids.has(event.id) ||
            event.arguments === null ||
            typeof event.arguments !== "object" ||
            Array.isArray(event.arguments)
          )
            return fail(
              failure(
                "invalid_tool_call",
                "모델의 함수 호출 이름·ID·인자가 올바르지 않습니다.",
              ),
            );
          state.ids.add(event.id);
          state.calls.push({
            id: event.id,
            type: "function",
            function: {
              name: event.name,
              arguments: JSON.stringify(event.arguments),
            },
          });
          return;
        }
        case "gateway.native_call":
          return fail(
            failure(
              "native_tool_call",
              event.name === "invalid"
                ? "모델이 선언되지 않은 함수나 잘못된 JSON 인자로 호출했습니다."
                : "모델이 클라이언트에 없는 OpenCode 내장 도구를 호출했습니다.",
            ),
          );
        case "gateway.fatal":
          return fail(
            failure(
              "plugin_failed",
              `OpenCode 플러그인 검증에 실패했습니다: ${String(event.code)}`,
            ),
          );
        case "gateway.step": {
          const calls = request.parallelToolCalls
            ? state.calls
            : state.calls.slice(0, 1);
          let finishReason;
          if (calls.length) finishReason = "tool_calls";
          else if (spec.toolChoice === "required" || isNamed(spec.toolChoice))
            return fail(
              failure(
                "tool_choice_unsatisfied",
                "함수 호출이 필수인 요청에 모델이 텍스트만 반환했습니다.",
              ),
            );
          else finishReason = FINISH[event.reason];
          if (!finishReason)
            return fail(
              failure(
                "incomplete_cli_output",
                "네이티브 단계가 정상 종료되지 않았습니다.",
              ),
            );
          return settle(null, {
            text: state.text,
            reasoning: state.reasoning,
            toolCalls: calls,
            finishReason,
            usage: usage(event.tokens ?? {}),
          });
        }
        default:
          return fail(
            failure("invalid_cli_output", "알 수 없는 플러그인 이벤트입니다."),
          );
      }
    };

    run.server = createServer((socket) => {
      if (run.socket) return socket.destroy();
      run.socket = socket;
      socket.on("error", () => {});
      lines(
        socket,
        LINE_LIMIT,
        (line) => {
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return fail(
              failure(
                "invalid_cli_output",
                "플러그인 이벤트가 JSON이 아닙니다.",
              ),
            );
          }
          handle(event);
        },
        () =>
          fail(
            failure(
              "cli_output_too_large",
              "플러그인 이벤트 크기 상한을 초과했습니다.",
            ),
          ),
      );
    });
    await new Promise((resolve, reject) => {
      run.server.once("error", reject);
      run.server.listen(socketPath, resolve);
    });
    if (run.settled) return outcome;

    const child = spawnProcess(
      executable,
      [
        "run",
        "--standalone",
        "--model",
        `opencode/${request.modelId}`,
        "--format",
        "json",
        "Continue.",
      ],
      {
        cwd: run.work,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: run.work,
          LANG: "C.UTF-8",
          TMPDIR: run.work,
          XDG_CONFIG_HOME: join(run.work, "config"),
          XDG_DATA_HOME: join(run.work, "data"),
          XDG_STATE_HOME: join(run.work, "state"),
          XDG_CACHE_HOME: cacheDir,
        },
      },
    );
    run.child = child;
    run.closed = new Promise((resolve) => child.once("close", resolve));
    child.stderr.resume();
    child.once("error", () =>
      fail(failure("cli_start_failed", "CLI 실행에 실패했습니다.")),
    );
    lines(
      child.stdout,
      LINE_LIMIT,
      (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type !== "error") return;
        const status = Number(event.error?.status);
        fail(
          new GatewayError(
            UPSTREAM_STATUS.has(status) ? status : 502,
            "upstream_error",
            String(event.error?.message ?? "OpenCode CLI failed").slice(
              0,
              1000,
            ),
          ),
        );
      },
      () =>
        fail(
          failure("cli_output_too_large", "CLI 출력 크기 상한을 초과했습니다."),
        ),
    );
    child.once("close", () =>
      fail(
        failure(
          "incomplete_cli_output",
          "네이티브 실행이 모델 단계를 완료하지 않고 종료되었습니다.",
        ),
      ),
    );
    const onAbort = () =>
      fail(
        signal.reason ??
          failure("request_aborted", "요청이 취소되었습니다.", 499),
      );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    return outcome.finally(() => signal?.removeEventListener("abort", onAbort));
  }

  async function cleanup(run) {
    if (run.child?.pid) {
      try {
        process.kill(-run.child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") run.child.kill("SIGKILL");
      }
      if (run.child.exitCode === null && run.child.signalCode === null)
        await run.closed;
    }
    run.socket?.destroy();
    if (run.server?.listening)
      await new Promise((resolve) => run.server.close(resolve));
    if (run.work) await rm(run.work, { recursive: true, force: true });
  }

  async function runRequest(request, options = {}) {
    if (stopped) throw failure("server_stopping", "서버가 종료 중입니다.", 503);
    options.signal?.throwIfAborted();
    if (runs.size >= maxWorkers)
      throw failure("workers_busy", "모든 네이티브 워커가 사용 중입니다.", 429);
    const run = { settled: false };
    runs.add(run);
    try {
      return await execute(run, request, options);
    } finally {
      run.settled = true;
      try {
        await cleanup(run);
      } finally {
        runs.delete(run);
      }
    }
  }

  return {
    run: runRequest,
    stats: () => ({ active: runs.size, maxWorkers }),
    async close() {
      stopped = true;
      for (const run of runs)
        run.fail?.(failure("server_stopping", "서버가 종료 중입니다.", 503));
      while (runs.size) await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}
