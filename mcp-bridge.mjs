import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpToolSchema, mcpFunctionName } from "./tools.mjs";

const configuration = JSON.parse(await readFile(process.argv[2], "utf8"));
const socket = connect(configuration.socketPath);
const pending = new Map();
const functions = new Map(
  configuration.tools.map((tool, index) => [
    mcpFunctionName(index),
    tool.function,
  ]),
);
let buffer = "";
let readyResolve;
let readyReject;
let closing = false;
const ready = new Promise((resolve, reject) => {
  readyResolve = resolve;
  readyReject = reject;
});
const decoder = new StringDecoder("utf8");
const server = new Server(
  { name: "gateway-caller-tools", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

function send(value) {
  const line = JSON.stringify(value) + "\n";
  if (
    socket.destroyed ||
    socket.writableLength + Buffer.byteLength(line) > 2 * 1024 * 1024
  )
    throw new Error("Tool bridge unavailable");
  socket.write(line);
}

function terminate() {
  if (closing) return;
  closing = true;
  readyReject(new Error("Tool bridge closed"));
  for (const entry of pending.values())
    entry.reject(new Error("Tool bridge closed"));
  pending.clear();
  socket.destroy();
  void server.close().catch(() => {});
}

socket.on("connect", () => send({ type: "hello", token: configuration.token }));
socket.on("error", terminate);
socket.on("close", terminate);
socket.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) return terminate();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return terminate();
    }
    if (message.type === "ready") {
      readyResolve();
      continue;
    }
    if (message.type !== "result" || typeof message.content !== "string")
      return terminate();
    const entry = pending.get(message.requestId);
    if (!entry) return terminate();
    pending.delete(message.requestId);
    entry.resolve({ content: [{ type: "text", text: message.content }] });
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: configuration.tools.map((tool, index) => ({
    name: mcpFunctionName(index),
    description: `Client function ${tool.function.name}. ${tool.function.description ?? ""}`,
    inputSchema: mcpToolSchema(tool.function.parameters),
  })),
}));
server.setRequestHandler(CallToolRequestSchema, (request) => {
  const fn = functions.get(request.params.name);
  if (!fn || pending.size >= 64)
    throw new Error("Unknown tool or too many pending calls");
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try {
      send({
        type: "call",
        requestId,
        name: fn.name,
        arguments: request.params.arguments?.arguments,
      });
    } catch (error) {
      pending.delete(requestId);
      reject(error);
    }
  });
});

await ready;
await server.connect(
  new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 2 * 1024 * 1024,
  }),
);
process.stdin.once("end", terminate);
