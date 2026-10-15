import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createToolBridge } from "./tool-bridge.mjs";
import { normalizeTools, mcpToolSchema } from "./tools.mjs";

const tools = normalizeTools([
  {
    type: "function",
    function: {
      name: "lookup",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
]);

async function fixture(t, suppliedTools = tools) {
  const work = await mkdtemp(join(tmpdir(), "mcp-bridge-test-"));
  const calls = [],
    errors = [];
  let called;
  const callReceived = new Promise((resolve) => {
    called = resolve;
  });
  let closing = false;
  const bridge = await createToolBridge({
    work,
    tools: suppliedTools,
    onCall: (call) => {
      calls.push(call);
      called(call);
    },
    onError: (error) => {
      if (!closing) errors.push(error);
    },
  });
  const client = new Client({ name: "fixture-client", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./mcp-bridge.mjs", import.meta.url)),
      bridge.configPath,
    ],
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  t.after(async () => {
    closing = true;
    await client.close();
    await bridge.close();
    await rm(work, { recursive: true, force: true });
  });
  await client.connect(transport);
  return { bridge, client, calls, errors, callReceived };
}

test(
  "정식 MCP stdio 계약은 실제 결과 회신 전까지 호출을 완료하지 않는다",
  { timeout: 7000 },
  async (t) => {
    const f = await fixture(t);
    const listed = await f.client.listTools();
    assert.equal(listed.tools[0].name, "fn0");
    assert.deepEqual(
      listed.tools[0].inputSchema,
      mcpToolSchema(tools[0].function.parameters),
    );
    let settled = false;
    const promise = f.client
      .callTool({ name: "fn0", arguments: { arguments: { key: "alpha" } } })
      .then((value) => {
        settled = true;
        return value;
      });
    const call = await f.callReceived;
    await delay(20);
    assert.equal(settled, false);
    assert.equal(call.name, "lookup");
    assert.deepEqual(call.arguments, { key: "alpha" });
    const actual = "real-caller-result-" + randomUUID();
    f.bridge.reply(call.requestId, actual);
    const response = await promise;
    assert.deepEqual(response.content, [{ type: "text", text: actual }]);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "MCP 이름과 스키마가 맞지 않는 호출은 실행하거나 인자를 복구하지 않는다",
  { timeout: 7000 },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.client.callTool({ name: "fn0", arguments: { arguments: { key: 7 } } }),
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.errors[0].code, "invalid_tool_call");
  },
);

test(
  "제공하지 않은 MCP 함수는 로컬 명령으로 실행하지 않는다",
  { timeout: 7000 },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.client.callTool({
        name: "bash",
        arguments: { command: "invalid fixture" },
      }),
    );
    assert.equal(f.calls.length, 0);
  },
);

test(
  "원래 64자 함수 이름은 짧은 MCP 이름과 정확하게 왕복한다",
  { timeout: 7000 },
  async (t) => {
    const name = "f".repeat(64);
    const supplied = normalizeTools([
      { ...tools[0], function: { ...tools[0].function, name } },
    ]);
    const f = await fixture(t, supplied);
    const listed = await f.client.listTools();
    assert.equal(listed.tools[0].name, "fn0");
    const pending = f.client.callTool({
      name: "fn0",
      arguments: { arguments: { key: "alpha" } },
    });
    const call = await f.callReceived;
    assert.equal(call.name, name);
    f.bridge.reply(call.requestId, "actual");
    assert.deepEqual((await pending).content, [
      { type: "text", text: "actual" },
    ]);
  },
);
