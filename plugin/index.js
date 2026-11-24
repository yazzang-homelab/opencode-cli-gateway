// Loaded by the pinned official OpenCode V2 CLI as a local plugin. It turns
// one `opencode run` into exactly one upstream model call for a stateless
// Chat Completions request: the caller's messages, functions and generation
// settings replace OpenCode's history and tools in the outgoing request, the
// upstream stream is relayed to the gateway, and OpenCode itself only sees a
// terminal empty answer, so it never runs a tool or sends a follow-up call.
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import {
  TERMINAL_STREAM,
  classifyCalls,
  createAccumulator,
  createEventParser,
  rewriteBody,
  tokens,
} from "./upstream.js";

// Model calls per request. Extra attempts only happen when the model called
// nothing but OpenCode's own `read` and no output reached the caller yet.
const MAX_ATTEMPTS = 3;
// Waits before asking again after an upstream 429. OpenCode's free tier
// answers single requests from one host with intermittent 429s whose
// Retry-After is hours away, while the next request usually succeeds.
const RATE_RETRY_DELAYS_MS = [1000, 2000, 4000];
const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  id: "opencode-cli-gateway",
  async setup(ctx) {
    const spec = JSON.parse(readFileSync(ctx.options.request, "utf8"));
    const channel = await new Promise((resolve, reject) => {
      const socket = connect(ctx.options.socket, () => resolve(socket));
      socket.once("error", reject);
    });
    const emit = (event) =>
      channel.write(
        JSON.stringify({ ...event, type: `gateway.${event.type}` }) + "\n",
      );
    const callerTools = new Set(spec.tools.map((tool) => tool.function.name));
    const rateRetryDelays =
      ctx.options.rateRetryDelaysMs ?? RATE_RETRY_DELAYS_MS;
    let request;
    let answered = false;

    // OpenCode generates a session title with a second model call.
    await ctx.session.hook("title", (event) => {
      event.result = "gateway";
    });

    // The gateway reports upstream failures itself instead of waiting for
    // OpenCode's backoff.
    await ctx.session.hook("retry", (event) => {
      event.decision = { retry: false };
    });

    // Never reached: OpenCode only sees an answer without tool calls.
    await ctx.tool.hook("execute.before", (event) => {
      emit({
        type: "fatal",
        code: "native_tool_execution",
        message: event.tool,
      });
      throw new Error("Tool execution is disabled by the gateway.");
    });

    await ctx.session.hook("http.request", async (event) => {
      if (event.kind !== "primary") return;
      if (request) {
        emit({ type: "fatal", code: "unexpected_follow_up", message: "" });
        await never();
      }
      let body;
      try {
        body = rewriteBody(
          JSON.parse(await event.request.clone().text()),
          spec,
        );
      } catch (error) {
        emit({ type: "fatal", code: "native_request", message: error.message });
        await never();
      }
      request = {
        url: event.request.url,
        method: event.request.method,
        headers: new Headers(event.request.headers),
        body: JSON.stringify(body),
      };
      request.headers.delete("content-length");
      event.request = new Request(request.url, request);
    });

    await ctx.session.hook("http.response", async (event) => {
      if (event.kind !== "primary" || answered) return;
      answered = true;
      let response = event.response;
      let streamed = false;
      let attempt = 1;
      let rateRetries = 0;
      const ask = async () => {
        try {
          return await fetch(request.url, request);
        } catch (error) {
          emit({
            type: "upstream_error",
            status: 502,
            message: String(error.message ?? error),
          });
          return never();
        }
      };
      for (;;) {
        // Nothing reached the caller before a status line, so a rate-limited
        // call can be repeated with the same request.
        if (response.status === 429 && rateRetries < rateRetryDelays.length) {
          const delayMs = rateRetryDelays[rateRetries];
          rateRetries += 1;
          emit({
            type: "retry",
            status: 429,
            retry: rateRetries,
            delayMs,
            retryAfter: response.headers.get("retry-after"),
          });
          await response.body?.cancel();
          await sleep(delayMs);
          response = await ask();
          continue;
        }
        emit({ type: "attempt", step: 0 });
        if (response.status !== 200) {
          const text = await response.clone().text();
          let message = text.slice(0, 1000);
          try {
            message = JSON.parse(text).error?.message ?? message;
          } catch {}
          emit({ type: "upstream_error", status: response.status, message });
          return;
        }
        const parser = createEventParser();
        const result = createAccumulator();
        const decoder = new TextDecoder();
        const relay = (chunks) => {
          for (const chunk of chunks)
            for (const delta of result.apply(chunk)) {
              streamed = true;
              emit({ type: "delta", ...delta });
            }
        };
        try {
          for await (const bytes of response.body)
            relay(parser.push(decoder.decode(bytes, { stream: true })));
          relay(parser.push(decoder.decode()));
          relay(parser.end());
        } catch (error) {
          emit({
            type: "upstream_error",
            status: 502,
            message: String(error.message ?? error),
          });
          await never();
        }
        if (result.state.error) {
          emit({
            type: "upstream_error",
            status: 502,
            message: String(
              result.state.error.message ?? "upstream stream error",
            ),
          });
          await never();
        }
        const calls = classifyCalls(result.calls, callerTools);
        if (calls.invalid) {
          emit({ type: "native_call", name: "invalid" });
          await never();
        }
        let reason = result.state.finishReason;
        if (calls.caller.length) reason = "tool_calls";
        else if (calls.native.length) {
          // The model reached for OpenCode's `read`, which the caller does
          // not own. Ask again while nothing was shown; keep a text answer.
          if (!streamed && attempt < MAX_ATTEMPTS) {
            attempt += 1;
            response = await ask();
            continue;
          }
          if (!result.text) {
            emit({ type: "native_call", name: calls.native[0] });
            await never();
          }
          reason = "stop";
        }
        for (const call of calls.caller) emit({ type: "call", ...call });
        emit({ type: "step", reason, tokens: tokens(result.state.usage) });
        break;
      }
      event.response = new Response(TERMINAL_STREAM, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    return () => channel.end();
  },
};
