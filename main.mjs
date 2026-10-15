import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { createCliRunner } from "./cli.mjs";
import { createGateway } from "./server.mjs";

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}

const tokenFile = process.env.GATEWAY_TOKEN_FILE;
if (!tokenFile) throw new Error("GATEWAY_TOKEN_FILE is required");
const token = (await readFile(tokenFile, "utf8")).trim();
if (token.length < 32)
  throw new Error("Gateway token must contain at least 32 characters");
const executable = resolve(
  process.env.OPENCODE_EXECUTABLE ??
    new URL("node_modules/.bin/opencode", import.meta.url).pathname,
);
await access(executable, constants.X_OK);
const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
const port = integer("GATEWAY_PORT", 8940, 1, 65535);
const maxWorkers = integer("GATEWAY_WORKERS", 4, 1, 8);
const timeoutMs = integer("GATEWAY_TIMEOUT_MS", 120000, 1000, 300000);
const maxBodyBytes = integer(
  "GATEWAY_MAX_BODY_BYTES",
  8388608,
  65536,
  33554432,
);
const modelId = "deepseek-v4.1-flash-free";
const runner = createCliRunner({
  executable,
  maxWorkers,
  stateDir: process.env.GATEWAY_STATE_DIR ?? "/var/lib/opencode-cli-gateway",
  cacheDir: process.env.GATEWAY_CACHE_DIR ?? "/var/cache/opencode-cli-gateway",
});
const server = createGateway({
  token,
  modelId,
  run: runner.run,
  workerStats: runner.stats,
  maxWorkers,
  timeoutMs,
  maxBodyBytes,
});
server.on("error", (error) => {
  console.error(
    JSON.stringify({ event: "server_error", code: error.code ?? "unknown" }),
  );
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      event: "listening",
      host,
      port,
      modelId,
      maxWorkers,
      transport: "official-opencode-cli",
    }),
  );
});
let stopping = false;
for (const name of ["SIGINT", "SIGTERM"]) {
  process.on(name, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    void runner.close();
  });
}
