import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { GatewayError } from "./errors.mjs";
import { createToolBridge } from "./tool-bridge.mjs";
import { stableJson, mcpFunctionName } from "./tools.mjs";

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const HELPER = fileURLToPath(new URL("./mcp-bridge.mjs", import.meta.url));
const forbidden = () =>
  new GatewayError(
    403,
    "native_tool_denied",
    "호출자가 선언하지 않은 네이티브 도구 실행은 허용하지 않습니다.",
  );
const settings = (request) =>
  stableJson({
    modelId: request.modelId,
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature ?? null,
    topP: request.topP ?? null,
    tools: request.tools,
  });

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function createCliRunner({
  executable,
  stateDir,
  cacheDir,
  maxWorkers = 4,
  toolTtlMs = 300000,
  spawnProcess = spawn,
  createBridge = createToolBridge,
}) {
  const sessions = new Set();
  const callIndex = new Map();
  let stopped = false;
  if (
    !Number.isInteger(maxWorkers) ||
    maxWorkers < 1 ||
    !Number.isInteger(toolTtlMs) ||
    toolTtlMs < 1
  )
    throw new TypeError("유효한 워커 수와 도구 대기 시간이 필요합니다.");

  function kill(session, signal) {
    if (!session.child?.pid) return;
    try {
      process.kill(-session.child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") session.child.kill(signal);
    }
  }

  async function cleanup(session) {
    if (session.cleanup) return session.cleanup;
    session.cleanup = (async () => {
      clearTimeout(session.ttl);
      await session.initializing?.catch(() => {});
      if (session.child && !session.nativeClosed) {
        kill(session, "SIGTERM");
        const force = setTimeout(() => kill(session, "SIGKILL"), 2000);
        force.unref();
        await session.childClosed.promise;
        clearTimeout(force);
      }
      kill(session, "SIGKILL");
      await session.bridge?.close();
      if (session.work)
        await rm(session.work, { recursive: true, force: true });
    })().finally(() => {
      sessions.delete(session);
      for (const id of session.calls.keys()) callIndex.delete(id);
    });
    return session.cleanup;
  }

  function terminate(session, reason) {
    if (session.closing) return session.cleanup;
    session.closing = true;
    session.failure =
      reason instanceof Error
        ? reason
        : new GatewayError(499, "request_aborted", "요청이 취소되었습니다.");
    kill(session, "SIGTERM");
    const turn = session.turn;
    return cleanup(session)
      .then(() => {
        if (turn) {
          turn.signal?.removeEventListener("abort", turn.onAbort);
          if (!turn.settled) {
            turn.settled = true;
            turn.reject(session.failure);
          }
        }
      })
      .catch(() => {
        turn?.signal?.removeEventListener("abort", turn.onAbort);
        if (turn && !turn.settled) {
          turn.settled = true;
          turn.reject(session.failure);
        }
      });
  }

  function allowedChoice(request, name) {
    return (
      request.toolChoice !== "none" &&
      (typeof request.toolChoice !== "object" ||
        request.toolChoice.function.name === name)
    );
  }

  function usage(session) {
    if (session.steps === session.reportedSteps) return null;
    const current = session.usage;
    const prior = session.reportedUsage;
    const result = {
      prompt_tokens: current.prompt - prior.prompt,
      completion_tokens: current.completion - prior.completion,
      total_tokens:
        current.prompt + current.completion - prior.prompt - prior.completion,
      prompt_tokens_details: { cached_tokens: current.cached - prior.cached },
      completion_tokens_details: {
        reasoning_tokens: current.reasoning - prior.reasoning,
      },
    };
    session.reportedUsage = { ...current };
    session.reportedSteps = session.steps;
    return result;
  }

  function flushCalls(session) {
    const turn = session.turn;
    if (session.closing || !turn || turn.settled) return;
    const queued = [...session.calls.values()].filter(
      (call) => call.status === "queued",
    );
    if (!queued.length) return;
    if (
      queued.some(
        (call) => !allowedChoice(turn.request, call.wire.function.name),
      )
    ) {
      void terminate(
        session,
        new GatewayError(
          502,
          "tool_choice_violated",
          "네이티브 호출이 tool_choice와 일치하지 않습니다.",
        ),
      );
      return;
    }
    const batch = turn.request.parallelToolCalls ? queued : queued.slice(0, 1);
    for (const call of batch) call.status = "delivered";
    const toolCalls = batch.map((call) => call.wire);
    const text = turn.text;
    session.history = [
      ...session.history,
      { role: "assistant", content: text, tool_calls: toolCalls },
    ];
    session.awaiting = new Set(toolCalls.map((call) => call.id));
    turn.settled = true;
    const commit = () => {
      if (session.turn !== turn || session.closing) return;
      turn.signal?.removeEventListener("abort", turn.onAbort);
      session.turn = null;
      session.ttl = setTimeout(() => {
        void terminate(
          session,
          new GatewayError(
            410,
            "tool_session_expired",
            "도구 결과 대기 시간이 만료되었습니다.",
          ),
        );
      }, toolTtlMs);
      session.ttl.unref();
    };
    turn.resolve({
      text,
      toolCalls,
      finishReason: "tool_calls",
      usage: usage(session),
      cost: session.cost,
      commit,
      cancel: () =>
        terminate(
          session,
          new GatewayError(
            499,
            "client_disconnected",
            "도구 호출 응답이 전달되지 않았습니다.",
          ),
        ),
    });
  }

  function nativeCall(session, call) {
    if (
      session.closing ||
      !session.current.tools.some((tool) => tool.function.name === call.name) ||
      !allowedChoice(session.current, call.name)
    )
      throw new GatewayError(
        502,
        "tool_choice_violated",
        "네이티브 호출이 tool_choice와 일치하지 않습니다.",
      );
    const id = "call_gw_" + randomUUID().replaceAll("-", "");
    const record = {
      requestId: call.requestId,
      status: "queued",
      wire: {
        id,
        type: "function",
        function: { name: call.name, arguments: stableJson(call.arguments) },
      },
    };
    session.calls.set(id, record);
    callIndex.set(id, { session, record });
    queueMicrotask(() => flushCalls(session));
  }

  function attach(session, request, options) {
    if (session.turn || session.closing)
      throw new GatewayError(
        409,
        "tool_session_busy",
        "같은 네이티브 세션의 요청이 이미 진행 중입니다.",
      );
    const turn = {
      ...deferred(),
      request,
      signal: options.signal,
      onText: options.onText ?? (() => {}),
      text: session.bufferedText,
      settled: false,
    };
    session.bufferedText = "";
    session.turn = turn;
    session.current = request;
    turn.onAbort = () => {
      void terminate(session, turn.signal.reason);
    };
    turn.signal?.addEventListener("abort", turn.onAbort, { once: true });
    if (turn.signal?.aborted) turn.onAbort();
    else if (turn.text) {
      try {
        turn.onText(turn.text);
      } catch (error) {
        void terminate(session, error);
      }
    }
    return turn;
  }

  async function finishNative(session, code) {
    if (session.closing) return;
    const turn = session.turn;
    const hasPending = [...session.calls.values()].some(
      (call) => call.status !== "consumed",
    );
    if (
      code !== 0 ||
      !session.finishReason ||
      !turn ||
      turn.settled ||
      !turn.text ||
      hasPending
    ) {
      return terminate(
        session,
        new GatewayError(
          502,
          "incomplete_cli_output",
          "네이티브 실행이 완료되지 않았거나 도구 결과 연결이 종료되었습니다.",
        ),
      );
    }
    if (
      turn.request.toolChoice === "required" ||
      typeof turn.request.toolChoice === "object"
    ) {
      return terminate(
        session,
        new GatewayError(
          502,
          "tool_choice_unsatisfied",
          "함수 호출이 필수인 요청에 네이티브 모델이 텍스트만 반환했습니다.",
        ),
      );
    }
    session.closing = true;
    try {
      await cleanup(session);
    } catch {
      turn.settled = true;
      turn.reject(
        new GatewayError(
          502,
          "cleanup_failed",
          "네이티브 실행의 상태 정리가 실패했습니다.",
        ),
      );
      return;
    } finally {
      turn.signal?.removeEventListener("abort", turn.onAbort);
    }
    turn.settled = true;
    turn.resolve({
      text: turn.text,
      toolCalls: [],
      finishReason: session.finishReason,
      usage: usage(session),
      cost: session.cost,
    });
  }

  async function launch(session) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    session.work = await mkdtemp(join(stateDir, "request-"));
    if (session.closing) return;
    const request = session.current;
    const enabled = request.tools.length > 0 && request.toolChoice !== "none";
    session.nativeTools = new Set(
      enabled
        ? request.tools.map(
            (_tool, index) => "caller_" + mcpFunctionName(index),
          )
        : [],
    );
    if (enabled) {
      session.bridge = await createBridge({
        work: session.work,
        tools: request.tools,
        onCall: (call) => nativeCall(session, call),
        onError: (error) => {
          if (
            session.finishReason &&
            [...session.calls.values()].every(
              (call) => call.status === "consumed",
            )
          )
            return;
          void terminate(session, error);
        },
      });
    }
    if (session.closing) return;
    const permission = {
      "*": "ask",
      ...(enabled ? { "caller_*": "allow" } : {}),
    };
    const config = {
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      formatter: false,
      lsp: false,
      permission,
      agent: {
        build: {
          permission,
          ...(request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
          ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        },
        title: { disable: true },
        summary: { disable: true },
      },
      ...(enabled
        ? {
            mcp: {
              caller: {
                type: "local",
                command: [process.execPath, HELPER, session.bridge.configPath],
                enabled: true,
                timeout: toolTtlMs + 300000,
              },
            },
          }
        : {}),
    };
    const child = spawnProcess(
      executable,
      [
        "run",
        "--pure",
        "--agent",
        "build",
        "--model",
        `opencode/${request.modelId}`,
        "--format",
        "json",
        "--title",
        "gateway-request",
      ],
      {
        cwd: session.work,
        detached: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: session.work,
          LANG: "C.UTF-8",
          TMPDIR: session.work,
          XDG_CONFIG_HOME: join(session.work, "config"),
          XDG_DATA_HOME: join(session.work, "data"),
          XDG_STATE_HOME: join(session.work, "state"),
          XDG_CACHE_HOME: cacheDir,
          OPENCODE_DISABLE_PROJECT_CONFIG: "true",
          OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
          OPENCODE_DISABLE_CLAUDE_CODE: "true",
          OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
          OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(
            request.maxOutputTokens,
          ),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        },
      },
    );
    session.child = child;
    let bytes = 0,
      buffer = "";
    const decoder = new StringDecoder("utf8");
    const parts = new Map(),
      steps = new Set();
    const number = (value) =>
      Number.isFinite(value) && value >= 0 ? value : 0;
    function line(value) {
      if (session.closing || !value.trim()) return;
      let event;
      try {
        event = JSON.parse(value);
      } catch {
        return;
      }
      if (event.type === "error") {
        const data = event.error?.data;
        const status = Number(data?.statusCode);
        void terminate(
          session,
          new GatewayError(
            [400, 401, 403, 404, 408, 429, 503].includes(status) ? status : 502,
            "upstream_error",
            String(data?.message ?? "OpenCode CLI failed").slice(0, 1000),
          ),
        );
        return;
      }
      if (event.type === "tool_use") {
        if (!session.nativeTools.has(event.part?.tool)) {
          void terminate(session, forbidden());
          return;
        }
        if (event.part.state?.status === "error")
          void terminate(
            session,
            new GatewayError(
              502,
              "native_mcp_failed",
              "네이티브 MCP 도구 결과 처리가 실패했습니다.",
            ),
          );
        return;
      }
      if (event.type === "text" && typeof event.part?.text === "string") {
        const previous = parts.get(event.part.id) ?? "";
        const next = event.part.text;
        if (!next.startsWith(previous)) {
          void terminate(
            session,
            new GatewayError(
              502,
              "invalid_cli_output",
              "네이티브 텍스트 파트가 일관되지 않습니다.",
            ),
          );
          return;
        }
        parts.set(event.part.id, next);
        const delta = next.slice(previous.length);
        const turn = session.turn;
        if (turn && !turn.settled) {
          turn.text += delta;
          if (delta) {
            try {
              turn.onText(delta);
            } catch (error) {
              void terminate(session, error);
            }
          }
        } else session.bufferedText += delta;
      }
      if (event.type === "step_finish" && !steps.has(event.part?.id)) {
        const part = event.part;
        if (!part || !["stop", "length", "tool-calls"].includes(part.reason)) {
          void terminate(
            session,
            new GatewayError(
              502,
              "incomplete_cli_output",
              "잘못된 네이티브 단계 종료입니다.",
            ),
          );
          return;
        }
        steps.add(part.id);
        session.steps += 1;
        if (part.reason !== "tool-calls") session.finishReason = part.reason;
        const tokens = part.tokens ?? {};
        session.usage.prompt +=
          number(tokens.input) +
          number(tokens.cache?.read) +
          number(tokens.cache?.write);
        session.usage.completion +=
          number(tokens.output) + number(tokens.reasoning);
        session.usage.cached += number(tokens.cache?.read);
        session.usage.reasoning += number(tokens.reasoning);
        session.cost += number(part.cost);
      }
    }
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) {
        void terminate(
          session,
          new GatewayError(
            502,
            "cli_output_too_large",
            "CLI 출력 크기 상한을 초과했습니다.",
          ),
        );
        return;
      }
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const next = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        line(next);
      }
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE")
        void terminate(
          session,
          new GatewayError(502, "cli_input_failed", "CLI 입력에 실패했습니다."),
        );
    });
    child.on("error", () => {
      void terminate(
        session,
        new GatewayError(502, "cli_start_failed", "CLI 실행에 실패했습니다."),
      );
    });
    child.on("close", (code) => {
      session.nativeClosed = true;
      session.childClosed.resolve();
      buffer += decoder.end();
      line(buffer);
      void finishNative(session, code).catch((error) => {
        void terminate(session, error);
      });
    });
    const prompt = [
      "다음 JSON 배열은 클라이언트의 전체 대화 기록입니다. 역할과 맥락을 참고해 마지막 요청에 답하세요.",
      enabled
        ? "클라이언트 함수는 caller_ 접두사의 MCP 도구로 제공됩니다. 필요한 함수만 호출하세요. 함수는 클라이언트가 실행하고 실제 결과를 회신할 때까지 기다립니다. 결과를 추측하거나 이미 결과가 있는 호출을 반복하지 마세요. 다른 네이티브 도구나 파일 접근은 허용되지 않습니다."
        : "도구 실행이나 파일 접근 없이 답변 텍스트만 출력하세요.",
      enabled
        ? request.tools
            .map(
              (tool, index) =>
                `클라이언트 함수 ${tool.function.name} = caller_${mcpFunctionName(index)}`,
            )
            .join("\n")
        : "",
      request.toolChoice === "required"
        ? "이번 응답에는 적어도 하나의 클라이언트 함수 호출이 필요합니다."
        : typeof request.toolChoice === "object"
          ? `이번 응답에는 caller_${mcpFunctionName(request.tools.findIndex((tool) => tool.function.name === request.toolChoice.function.name))} 함수를 호출해야 합니다.`
          : "",
      JSON.stringify(request.messages),
    ]
      .filter(Boolean)
      .join("\n\n");
    child.stdin.end(prompt);
  }

  async function run(request, options = {}) {
    if (stopped)
      throw new GatewayError(503, "server_stopping", "서버가 종료 중입니다.");
    options.signal?.throwIfAborted();
    const tail = [];
    for (
      let i = request.messages.length - 1;
      i >= 0 && request.messages[i].role === "tool";
      i--
    )
      tail.unshift(request.messages[i]);
    const references = tail.map((message) =>
      callIndex.get(message.tool_call_id),
    );
    let session;
    if (references.some(Boolean)) {
      session = references.find(Boolean).session;
      if (
        references.some(
          (ref) =>
            !ref ||
            ref.session !== session ||
            ref.record.status !== "delivered",
        )
      )
        throw new GatewayError(
          409,
          "tool_result_replayed",
          "서로 다른 세션·중복·미전달 호출의 결과는 회신할 수 없습니다.",
        );
      if (session.turn || session.closing)
        throw new GatewayError(
          409,
          "tool_session_busy",
          "같은 도구 세션의 요청이 진행 중입니다.",
        );
      if (
        settings(request) !== session.settings ||
        stableJson(request.messages.slice(0, -tail.length)) !==
          stableJson(session.history) ||
        tail.length !== session.awaiting.size ||
        tail.some((message) => !session.awaiting.has(message.tool_call_id))
      )
        throw new GatewayError(
          409,
          "tool_context_mismatch",
          "도구 결과는 동일한 대화·함수 정의·생성 설정과 모든 호출 ID로 회신해야 합니다.",
        );
      clearTimeout(session.ttl);
      session.history = structuredClone(request.messages);
      const turn = attach(session, request, options);
      for (const message of tail) {
        const record = callIndex.get(message.tool_call_id).record;
        record.status = "consumed";
        try {
          session.bridge.reply(record.requestId, message.content);
        } catch (error) {
          void terminate(session, error);
          break;
        }
      }
      session.awaiting.clear();
      queueMicrotask(() => flushCalls(session));
      return turn.promise;
    }
    if (tail.some((message) => message.tool_call_id.startsWith("call_gw_")))
      throw new GatewayError(
        410,
        "tool_session_expired",
        "도구 호출 세션이 없거나 이미 종료되었습니다.",
      );
    if (sessions.size >= maxWorkers)
      throw new GatewayError(
        429,
        "workers_busy",
        "모든 네이티브 워커가 실행 또는 도구 결과 대기 중입니다.",
      );
    session = {
      calls: new Map(),
      history: structuredClone(request.messages),
      settings: settings(request),
      current: request,
      turn: null,
      bufferedText: "",
      awaiting: new Set(),
      childClosed: deferred(),
      nativeClosed: false,
      closing: false,
      usage: { prompt: 0, completion: 0, cached: 0, reasoning: 0 },
      reportedUsage: { prompt: 0, completion: 0, cached: 0, reasoning: 0 },
      steps: 0,
      reportedSteps: 0,
      cost: 0,
    };
    sessions.add(session);
    const turn = attach(session, request, options);
    session.initializing = launch(session);
    void session.initializing.catch((error) => terminate(session, error));
    return turn.promise;
  }

  return {
    run,
    stats: () => ({
      active: sessions.size,
      waitingForTools: [...sessions].filter(
        (session) => !session.turn && session.awaiting.size > 0,
      ).length,
      maxWorkers,
    }),
    async close() {
      stopped = true;
      await Promise.all(
        [...sessions].map((session) =>
          terminate(
            session,
            new GatewayError(503, "server_stopping", "서버가 종료 중입니다."),
          ),
        ),
      );
    },
  };
}
