import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { GatewayError } from "./errors.mjs";
import { compileParameters, isRecord } from "./tools.mjs";

const LIMIT = 2 * 1024 * 1024;

export async function createToolBridge({ work, tools, onCall, onError }) {
  const token = randomBytes(32).toString("hex");
  const expected = createHash("sha256").update(token).digest();
  const definitions = new Map(
    tools.map((tool) => [
      tool.function.name,
      compileParameters(tool.function.parameters),
    ]),
  );
  const socketPath = join(work, "bridge.sock");
  const configPath = join(work, "bridge.json");
  const seen = new Set();
  const pending = new Set();
  const connections = new Set();
  let current;
  let closing = false;
  const error = () =>
    new GatewayError(
      502,
      "tool_bridge_failed",
      "도구 결과 중계 연결이 종료되었습니다.",
    );
  const server = createServer((socket) => {
    connections.add(socket);
    let authenticated = false;
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    const fail = (reason) => {
      socket.destroy();
      if (!closing) onError(reason);
    };
    const timeout = setTimeout(() => {
      if (!authenticated) fail(error());
    }, 5000);
    timeout.unref();
    socket.on("error", () => fail(error()));
    socket.on("close", () => {
      clearTimeout(timeout);
      connections.delete(socket);
      if (current === socket) {
        current = undefined;
        if (!closing) onError(error());
      }
    });
    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > LIMIT) return fail(error());
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return fail(error());
        }
        if (!isRecord(message)) return fail(error());
        if (!authenticated) {
          if (
            message.type !== "hello" ||
            typeof message.token !== "string" ||
            current ||
            !timingSafeEqual(
              expected,
              createHash("sha256").update(message.token).digest(),
            )
          )
            return fail(error());
          authenticated = true;
          current = socket;
          clearTimeout(timeout);
          socket.write('{"type":"ready"}\n');
          continue;
        }
        const validator = definitions.get(message.name);
        if (
          message.type !== "call" ||
          typeof message.requestId !== "string" ||
          !/^[A-Za-z0-9-]{1,64}$/.test(message.requestId) ||
          seen.has(message.requestId) ||
          seen.size >= 256 ||
          pending.size >= 64 ||
          !validator ||
          !isRecord(message.arguments) ||
          Buffer.byteLength(JSON.stringify(message.arguments)) > 65536 ||
          !validator(message.arguments)
        ) {
          return fail(
            new GatewayError(
              502,
              "invalid_tool_call",
              "네이티브 함수 호출의 이름·ID·인자가 선언과 일치하지 않습니다.",
            ),
          );
        }
        seen.add(message.requestId);
        pending.add(message.requestId);
        try {
          onCall({
            requestId: message.requestId,
            name: message.name,
            arguments: message.arguments,
          });
        } catch (reason) {
          return fail(reason);
        }
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    await writeFile(configPath, JSON.stringify({ socketPath, token, tools }), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (reason) {
    closing = true;
    server.close();
    throw reason;
  }
  return {
    configPath,
    reply(requestId, content) {
      if (!current || !pending.has(requestId)) throw error();
      const data =
        JSON.stringify({ type: "result", requestId, content }) + "\n";
      if (current.writableLength + Buffer.byteLength(data) > LIMIT)
        throw error();
      pending.delete(requestId);
      current.write(data);
    },
    async close() {
      closing = true;
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
