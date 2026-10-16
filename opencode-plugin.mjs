// Loaded by the pinned official OpenCode CLI through its documented plugin hooks.
// It turns one OpenCode run into exactly one model step for a stateless Chat
// Completions request: the caller's system text, native message history,
// function definitions and sampling options replace OpenCode's own, and the
// run stops before any tool result could be sent upstream.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

// Built-in tool IDs of opencode-ai 1.19.0. `tool.definition` fails closed if a
// future version exposes an ID that is neither listed here nor caller-owned.
const BUILTIN_TOOLS = [
  "question",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "task",
  "webfetch",
  "todowrite",
  "websearch",
  "skill",
  "apply_patch",
  "execute",
  "lsp",
  "plan_exit",
];

// OpenCode does not route plugin stdout to the CLI's stdout, so events use a
// private UNIX socket created by the gateway inside the request directory.
let channel;
const MAX_NATIVE_STEPS = 4;

function emit(event) {
  channel.write(
    JSON.stringify({ ...event, type: `gateway.${event.type}` }) + "\n",
  );
}

function history(spec, template) {
  const model = template.model;
  let sequence = 0;
  const id = (prefix) =>
    `${prefix}_gateway${String(++sequence).padStart(8, "0")}`;
  const result = [];
  for (const message of spec.messages) {
    const info =
      message.role === "user"
        ? {
            id: id("msg"),
            sessionID: template.sessionID,
            role: "user",
            time: { created: 0 },
            agent: template.agent,
            model,
          }
        : {
            id: id("msg"),
            sessionID: template.sessionID,
            role: "assistant",
            parentID: result.at(-1)?.info.id ?? template.id,
            time: { created: 0, completed: 0 },
            modelID: model.modelID,
            providerID: model.providerID,
            mode: template.agent,
            agent: template.agent,
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            finish: message.toolCalls.length ? "tool-calls" : "stop",
          };
    const part = () => ({
      id: id("prt"),
      sessionID: template.sessionID,
      messageID: info.id,
    });
    const parts = [];
    if (message.role === "user") {
      for (const item of message.parts) parts.push({ ...part(), ...item });
    } else {
      if (message.reasoning)
        parts.push({
          ...part(),
          type: "reasoning",
          text: message.reasoning,
          time: { start: 0, end: 0 },
        });
      if (message.text)
        parts.push({ ...part(), type: "text", text: message.text });
      for (const call of message.toolCalls)
        parts.push({
          ...part(),
          type: "tool",
          callID: call.id,
          tool: call.name,
          state: {
            status: "completed",
            input: call.arguments,
            output: call.output,
            title: "",
            metadata: {},
            time: { start: 0, end: 0 },
          },
        });
    }
    result.push({ info, parts });
  }
  return result;
}

export const GatewayPlugin = async () => {
  const spec = JSON.parse(
    readFileSync(process.env.GATEWAY_REQUEST_FILE, "utf8"),
  );
  channel = await new Promise((resolve, reject) => {
    const socket = connect(process.env.GATEWAY_EVENT_SOCKET, () =>
      resolve(socket),
    );
    socket.once("error", reject);
  });
  const callerTools = new Map(spec.tools.map((tool) => [tool.name, tool]));
  const caller = spec.mode === "caller";
  const partTypes = new Map();
  const tokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  let finished = 0;
  let stepCalls = 0;
  let stepFinished = false;
  let cost = 0;

  return {
    tool: Object.fromEntries(
      spec.tools.map((tool) => [
        tool.name,
        {
          description: tool.description,
          args: {},
          // Never reaches the model: `chat.params` blocks the follow-up request.
          async execute(args, context) {
            stepCalls += 1;
            emit({
              type: "call",
              id: context.callID,
              name: tool.name,
              arguments: args,
            });
            return "";
          },
        },
      ]),
    ),

    async event({ event }) {
      const properties = event.properties ?? {};
      if (event.type === "message.part.updated" && properties.part) {
        const part = properties.part;
        partTypes.set(part.id, part.type);
        if (
          part.type === "step-finish" &&
          !stepFinished &&
          partTypes.get(`done:${part.id}`) === undefined
        ) {
          partTypes.set(`done:${part.id}`, true);
          finished += 1;
          const step = part.tokens ?? {};
          tokens.input += step.input ?? 0;
          tokens.output += step.output ?? 0;
          tokens.reasoning += step.reasoning ?? 0;
          tokens.cache.read += step.cache?.read ?? 0;
          tokens.cache.write += step.cache?.write ?? 0;
          cost += part.cost ?? 0;
          // A step that only called OpenCode's own (rejected) `read` has
          // nothing for the caller; the CLI continues with another step.
          if (stepCalls > 0 || part.reason !== "tool-calls") {
            stepFinished = true;
            emit({ type: "step", reason: part.reason, tokens, cost });
          }
          stepCalls = 0;
        }
        return;
      }
      if (
        event.type === "message.part.delta" &&
        properties.field === "text" &&
        typeof properties.delta === "string"
      ) {
        const kind = partTypes.get(properties.partID);
        if ((kind === "text" || kind === "reasoning") && properties.delta)
          emit({ type: "delta", kind, text: properties.delta });
      }
    },

    async "chat.message"(_input, output) {
      // Hide OpenCode's own tools; a caller function with the same name
      // replaces the built-in entry in OpenCode's tool registry instead.
      // OpenCode's own `read` stays when the caller has none: the free
      // upstream rejects requests without it. The non-interactive CLI denies
      // it if the model calls it, and the model continues in the same run.
      output.message.tools = Object.fromEntries(
        BUILTIN_TOOLS.filter(
          (name) => name !== "read" && !callerTools.has(name),
        ).map((name) => [name, false]),
      );
    },

    async "tool.definition"(input, output) {
      const tool = callerTools.get(input.toolID);
      if (tool) {
        output.description = tool.description;
        output.jsonSchema = tool.parameters;
      } else if (
        input.toolID !== "invalid" &&
        !BUILTIN_TOOLS.includes(input.toolID)
      ) {
        emit({
          type: "fatal",
          code: "unexpected_native_tool",
          message: input.toolID,
        });
      }
    },

    async "tool.execute.before"(input) {
      if (callerTools.has(input.tool)) return;
      if (!caller || input.tool === "read")
        emit({ type: "native_rejected", name: input.tool });
      else emit({ type: "native_call", name: input.tool });
    },

    async "experimental.chat.system.transform"(_input, output) {
      output.system.splice(
        0,
        output.system.length,
        ...(spec.system ? [spec.system] : []),
      );
    },

    async "experimental.chat.messages.transform"(_input, output) {
      const template = output.messages.findLast(
        (message) => message.info.role === "user",
      )?.info;
      if (!template) {
        emit({
          type: "fatal",
          code: "missing_native_prompt",
          message: "OpenCode prompt message is missing",
        });
        return;
      }
      // OpenCode reads this in-memory field after the transform and sends
      // tool_choice "required"; it is never persisted or used for output.
      if (spec.toolChoice === "required")
        template.format = {
          type: "json_schema",
          schema: { type: "object" },
          retryCount: 0,
        };
      output.messages.splice(
        0,
        output.messages.length,
        ...history(spec, template),
      );
    },

    async "chat.params"(_input, output) {
      if (stepFinished) await new Promise(() => {});
      if (finished >= MAX_NATIVE_STEPS) {
        emit({
          type: "fatal",
          code: "native_tool_loop",
          message: "model kept calling OpenCode tools the caller does not own",
        });
        await new Promise(() => {});
      }
      // Each LLM request is either a retry of the current step or a new step.
      emit({ type: "attempt", step: finished });
      output.temperature = spec.sampling.temperature;
      output.topP = spec.sampling.topP;
      output.topK = undefined;
      output.maxOutputTokens = spec.sampling.maxOutputTokens;
      Object.assign(output.options, spec.options);
    },
  };
};
