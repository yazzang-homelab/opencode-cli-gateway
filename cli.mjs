import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { GatewayError } from "./errors.mjs";

const OUTPUT_LIMIT = 2 * 1024 * 1024;

export function createCliRunner({
  executable,
  stateDir,
  cacheDir,
  spawnProcess = spawn,
}) {
  return async function run(request, { signal, onText = () => {} } = {}) {
    if (signal?.aborted) throw signal.reason;
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const work = await mkdtemp(join(stateDir, "request-"));
    try {
      return await execute(work, request, signal, onText);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };

  function execute(work, request, signal, onText) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const config = {
        share: "disabled",
        autoupdate: false,
        snapshot: false,
        formatter: false,
        lsp: false,
        permission: { "*": "ask" },
        agent: {
          build: {
            permission: { "*": "ask" },
            ...(request.temperature !== undefined
              ? { temperature: request.temperature }
              : {}),
            ...(request.topP !== undefined ? { top_p: request.topP } : {}),
          },
          title: { disable: true },
          summary: { disable: true },
        },
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
          cwd: work,
          detached: true,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: work,
            LANG: "C.UTF-8",
            TMPDIR: work,
            XDG_CONFIG_HOME: join(work, "config"),
            XDG_DATA_HOME: join(work, "data"),
            XDG_STATE_HOME: join(work, "state"),
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
      let failure;
      let killTimer;
      let bytes = 0;
      let buffer = "";
      let text = "";
      let finished = false;
      let finishReason = "stop";
      let cost = 0;
      let promptTokens = 0;
      let completionTokens = 0;
      let cachedTokens = 0;
      let reasoningTokens = 0;
      const parts = new Map();
      const steps = new Set();
      const decoder = new StringDecoder("utf8");
      const number = (value) =>
        Number.isFinite(value) && value >= 0 ? value : 0;
      const kill = (sig) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, sig);
        } catch (error) {
          if (error.code !== "ESRCH") child.kill(sig);
        }
      };
      const fail = (error) => {
        if (failure) return;
        failure =
          error instanceof Error
            ? error
            : new GatewayError(499, "request_aborted", "Request aborted");
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 2000);
        killTimer.unref();
      };
      const onAbort = () => fail(signal.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      function line(value) {
        if (failure || !value.trim()) return;
        let event;
        try {
          event = JSON.parse(value);
        } catch {
          // The official CLI can print a permission auto-rejection notice in JSON mode.
          return;
        }
        if (event.type === "error") {
          const data = event.error?.data;
          const status = Number(data?.statusCode);
          const publicStatus = [400, 401, 403, 404, 408, 429, 503].includes(
            status,
          )
            ? status
            : 502;
          return fail(
            new GatewayError(
              publicStatus,
              "upstream_error",
              String(data?.message ?? "OpenCode CLI failed").slice(0, 1000),
            ),
          );
        }
        if (event.type === "tool_use") {
          return fail(
            new GatewayError(
              403,
              "native_tool_denied",
              "Native tool execution is not allowed by this text gateway",
            ),
          );
        }
        if (event.type === "text" && typeof event.part?.text === "string") {
          const key = event.part.id;
          const previous = parts.get(key) ?? "";
          const next = event.part.text;
          if (!next.startsWith(previous))
            return fail(
              new GatewayError(
                502,
                "invalid_cli_output",
                "Non-monotonic CLI text part",
              ),
            );
          parts.set(key, next);
          const delta = next.slice(previous.length);
          text += delta;
          if (delta) {
            try {
              onText(delta);
            } catch (error) {
              fail(error);
            }
          }
        }
        if (event.type === "step_finish" && !steps.has(event.part?.id)) {
          const part = event.part;
          if (!part || !["stop", "length"].includes(part.reason)) {
            return fail(
              new GatewayError(
                502,
                "incomplete_cli_output",
                "OpenCode did not finish a text generation",
              ),
            );
          }
          steps.add(part.id);
          finished = true;
          if (part.reason === "length") finishReason = "length";
          const tokens = part.tokens ?? {};
          cachedTokens += number(tokens.cache?.read);
          promptTokens +=
            number(tokens.input) +
            number(tokens.cache?.read) +
            number(tokens.cache?.write);
          reasoningTokens += number(tokens.reasoning);
          completionTokens += number(tokens.output) + number(tokens.reasoning);
          cost += number(part.cost);
        }
      }

      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT)
          return fail(
            new GatewayError(
              502,
              "cli_output_too_large",
              "CLI output limit exceeded",
            ),
          );
        buffer += decoder.write(chunk);
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const next = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          line(next);
        }
      });
      // Consume diagnostics without exposing filesystem paths, prompts, or credentials.
      child.stderr.on("data", () => {});
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE")
          fail(
            new GatewayError(
              502,
              "cli_input_failed",
              "Could not send input to OpenCode",
            ),
          );
      });
      child.on("error", () =>
        fail(
          new GatewayError(
            502,
            "cli_start_failed",
            "Could not start OpenCode CLI",
          ),
        ),
      );
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        buffer += decoder.end();
        line(buffer);
        if (killTimer) clearTimeout(killTimer);
        if (failure) kill("SIGKILL");
        if (failure) return reject(failure);
        if (code !== 0 || !finished || !text) {
          return reject(
            new GatewayError(
              502,
              "incomplete_cli_output",
              "OpenCode exited without a complete text response",
            ),
          );
        }
        resolve({
          text,
          finishReason,
          cost,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            prompt_tokens_details: { cached_tokens: cachedTokens },
            completion_tokens_details: { reasoning_tokens: reasoningTokens },
          },
        });
      });
      const prompt = [
        "다음 JSON 배열은 클라이언트의 대화 기록입니다. 역할과 대화 맥락을 참고해 마지막 요청에 답하세요.",
        "도구 실행이나 파일 접근 없이 답변 텍스트만 출력하세요. 도구가 꼭 필요한 작업은 실행할 수 없다고 설명하세요.",
        JSON.stringify(request.messages),
      ].join("\n\n");
      child.stdin.end(prompt);
    });
  }
}
