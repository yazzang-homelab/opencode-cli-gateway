import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { GatewayError } from "./errors.mjs";

const PLUGIN = fileURLToPath(new URL("./opencode-plugin.mjs", import.meta.url));
const OPENCODE_VERSION = "1.19.0";
const LINE_LIMIT = 4 * 1024 * 1024;
const UPSTREAM_STATUS = new Set([400, 401, 403, 404, 408, 413, 429, 503]);
const FINISH = {
  stop: "stop",
  length: "length",
  "content-filter": "content_filter",
};

const failure = (code, message, status = 502) =>
  new GatewayError(status, code, message);
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;

// Converts the normalized Chat request into the plugin's request file. The
// plugin rebuilds the same roles, tool calls and results as OpenCode messages.
export function pluginRequest(request) {
  let index = 0;
  const system = [];
  while (
    index < request.messages.length &&
    ["system", "developer"].includes(request.messages[index].role)
  )
    system.push(request.messages[index++].content);
  const messages = [];
  for (const message of request.messages.slice(index)) {
    if (message.role === "user") {
      messages.push({ role: "user", parts: message.parts });
    } else if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        text: message.content,
        reasoning: message.reasoning_content ?? "",
        toolCalls: (message.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments),
          output: undefined,
        })),
      });
    } else if (message.role === "tool") {
      const call = messages
        .at(-1)
        .toolCalls.find((item) => item.id === message.tool_call_id);
      call.output = message.content;
    }
  }
  const named =
    typeof request.toolChoice === "object"
      ? request.toolChoice.function.name
      : undefined;
  const caller = request.tools.length > 0 && request.toolChoice !== "none";
  return {
    system: system.length ? system.join("\n\n") : null,
    mode: caller ? "caller" : "native",
    toolChoice:
      caller && (named || request.toolChoice === "required")
        ? "required"
        : "auto",
    tools: caller
      ? request.tools
          .filter((tool) => !named || tool.function.name === named)
          .map((tool) => ({
            name: tool.function.name,
            description: tool.function.description ?? "",
            parameters: tool.function.parameters,
          }))
      : [],
    messages,
    sampling: {
      temperature: request.temperature,
      topP: request.topP,
      maxOutputTokens: request.maxOutputTokens,
    },
    options: {
      ...(caller ? { parallel_tool_calls: request.parallelToolCalls } : {}),
      ...request.options,
    },
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
}) {
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1)
    throw new TypeError("유효한 워커 수가 필요합니다.");
  const runs = new Set();
  let stopped = false;

  async function execute(
    run,
    request,
    { signal, onText = () => {}, onReasoning = () => {} },
  ) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    run.work = await mkdtemp(join(stateDir, "request-"));
    const config = join(run.work, "config", "opencode");
    await mkdir(join(config, "node_modules"), { recursive: true });
    // OpenCode installs its plugin SDK into every config directory before
    // loading plugins. This plugin imports nothing from it, so the pinned
    // dependency is declared as satisfied instead of reaching npm per request.
    const dependency = { "@opencode-ai/plugin": OPENCODE_VERSION };
    await writeFile(
      join(config, "package.json"),
      JSON.stringify({ dependencies: dependency }),
    );
    await writeFile(
      join(config, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": { dependencies: dependency } },
      }),
    );
    const requestFile = join(run.work, "request.json");
    const spec = pluginRequest(request);
    await writeFile(requestFile, JSON.stringify(spec), {
      mode: 0o600,
      flag: "wx",
    });
    const declared = new Set(spec.tools.map((tool) => tool.name));
    const socketPath = join(run.work, "events.sock");

    const state = {
      step: -1,
      streamed: false,
      text: "",
      reasoning: "",
      calls: [],
      ids: new Set(),
      rejected: 0,
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
          // A repeated step index is OpenCode retrying the same model step.
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
        case "gateway.native_rejected":
          state.rejected += 1;
          return;
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
          else if (spec.toolChoice === "required")
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

    const configContent = {
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      formatter: false,
      lsp: false,
      plugin: [`file://${plugin}`],
      // Non-interactive `opencode run` rejects every `ask`; OpenCode tools are
      // hidden for caller-tool requests and rejected for text-only requests.
      permission: { "*": "ask" },
      agent: { title: { disable: true } },
      experimental: { continue_loop_on_deny: true },
    };
    const child = spawnProcess(
      executable,
      [
        "run",
        "--agent",
        "build",
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
          OPENCODE_DISABLE_PROJECT_CONFIG: "true",
          OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
          OPENCODE_DISABLE_CLAUDE_CODE: "true",
          OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
          OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent),
          GATEWAY_REQUEST_FILE: requestFile,
          GATEWAY_EVENT_SOCKET: socketPath,
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
        const data = event.error?.data ?? {};
        const status = Number(data.statusCode);
        fail(
          new GatewayError(
            UPSTREAM_STATUS.has(status) ? status : 502,
            "upstream_error",
            String(data.message ?? "OpenCode CLI failed").slice(0, 1000),
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
