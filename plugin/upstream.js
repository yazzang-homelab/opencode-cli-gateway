// Pure helpers for the OpenCode V2 plugin: they rewrite the Chat Completions
// body the official CLI is about to send and read the upstream stream back.
// Kept free of OpenCode APIs so the gateway tests can exercise them in Node.

// Generation fields the gateway owns. OpenCode's own values are removed and
// the caller's values, when present, take their place.
const OWNED_FIELDS = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stop",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "reasoning_effort",
  "response_format",
  "user",
];

// The free upstream only serves requests that carry OpenCode's own system
// instructions and its `read` tool, so both stay in front of the caller's
// system text and functions. A caller function named `read` replaces it.
export function rewriteBody(native, spec) {
  if (!Array.isArray(native.messages))
    throw new Error("native request has no messages");
  const system = [];
  for (const message of native.messages) {
    if (message.role !== "system") break;
    system.push(message);
  }
  if (!system.length) throw new Error("native request has no system prompt");
  const callerTools = new Set(spec.tools.map((tool) => tool.function.name));
  const read = (native.tools ?? []).find(
    (tool) => tool?.function?.name === "read",
  );
  if (!read && !callerTools.has("read"))
    throw new Error("native request has no read tool");
  const body = { ...native };
  for (const field of OWNED_FIELDS) delete body[field];
  body.messages = [...system, ...spec.messages];
  body.tools = callerTools.has("read") ? spec.tools : [...spec.tools, read];
  body.tool_choice = spec.toolChoice;
  if (spec.tools.length) body.parallel_tool_calls = spec.parallelToolCalls;
  Object.assign(body, spec.params);
  return body;
}

// Splits a server-sent event stream into the JSON payloads of `data:` lines.
export function createEventParser() {
  let buffer = "";
  const parse = (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data)];
  };
  return {
    push(text) {
      buffer += text;
      const events = [];
      let index;
      while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, "");
        events.push(...parse(block));
      }
      return events;
    },
    end() {
      const rest = buffer;
      buffer = "";
      return rest.trim() ? parse(rest) : [];
    },
  };
}

// Folds Chat Completions chunks into deltas, tool calls, finish reason and
// usage. Returned deltas are what the caller may see immediately.
export function createAccumulator() {
  const calls = [];
  const state = { finishReason: null, usage: null, error: null };
  let text = "";
  return {
    state,
    calls,
    get text() {
      return text;
    },
    apply(chunk) {
      if (chunk?.error) {
        state.error = chunk.error;
        return [];
      }
      if (chunk?.usage) state.usage = chunk.usage;
      const deltas = [];
      for (const choice of chunk?.choices ?? []) {
        if (choice.index !== undefined && choice.index !== 0) continue;
        const delta = choice.delta ?? {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning)
          deltas.push({ kind: "reasoning", text: reasoning });
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          deltas.push({ kind: "text", text: delta.content });
        }
        for (const call of delta.tool_calls ?? []) {
          const slot = (calls[call.index ?? calls.length] ??= {
            id: "",
            name: "",
            arguments: "",
          });
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.name += call.function.name;
          if (typeof call.function?.arguments === "string")
            slot.arguments += call.function.arguments;
        }
        if (choice.finish_reason) state.finishReason = choice.finish_reason;
      }
      return deltas;
    },
  };
}

// Converts Chat Completions usage into OpenCode's token shape, in which
// input excludes cached tokens and output excludes reasoning tokens.
export function tokens(usage) {
  const number = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const cached = number(usage?.prompt_tokens_details?.cached_tokens);
  const reasoning = number(usage?.completion_tokens_details?.reasoning_tokens);
  return {
    input: Math.max(number(usage?.prompt_tokens) - cached, 0),
    output: Math.max(number(usage?.completion_tokens) - reasoning, 0),
    reasoning,
    cache: { read: cached, write: 0 },
  };
}

// Splits the model's calls into the caller's functions and anything else.
// Arguments that are not a JSON object make the call invalid.
export function classifyCalls(calls, callerTools) {
  const caller = [];
  const native = [];
  for (const call of calls) {
    if (!call) continue;
    if (!callerTools.has(call.name)) {
      native.push(call.name);
      continue;
    }
    let args;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      args = undefined;
    }
    if (args === null || typeof args !== "object" || Array.isArray(args))
      return { invalid: true, caller, native };
    caller.push({ id: call.id, name: call.name, arguments: args });
  }
  return { invalid: false, caller, native };
}

// A stream that ends the native OpenCode turn without text or tool calls, so
// the CLI never executes a tool or sends a follow-up request.
export const TERMINAL_STREAM =
  'data: {"id":"gateway","object":"chat.completion.chunk","created":0,"model":"gateway","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\ndata: [DONE]\n\n';
