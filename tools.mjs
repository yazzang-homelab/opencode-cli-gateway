import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { GatewayError } from "./errors.mjs";

const ajv = new Ajv({
  strict: false,
  allErrors: false,
  validateFormats: false,
});
const ajv2020 = new Ajv2020({
  strict: false,
  allErrors: false,
  validateFormats: false,
});
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
// Definitions are bounded by the model context rather than a count: GJC with
// MCP servers sends 150+ functions, and the upstream accepted 310 in testing.
const MAX_TOOLS = 512;
const MAX_CALLS = 64;
const MAX_DESCRIPTION = 32768;
const MAX_SCHEMA_BYTES = 65536;

function invalid(message) {
  return new GatewayError(400, "invalid_tools", message);
}
export const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (isRecord(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stableJson(value[key]))
        .join(",") +
      "}"
    );
  if (typeof value === "number" && !Number.isFinite(value))
    throw invalid("유한한 JSON 숫자만 허용합니다.");
  return JSON.stringify(value);
}

export function normalizeTools(value = []) {
  if (!Array.isArray(value) || value.length > MAX_TOOLS)
    throw invalid(`tools는 ${MAX_TOOLS}개 이하의 함수 배열이어야 합니다.`);
  const names = new Set();
  return value.map((tool) => {
    if (
      !isRecord(tool) ||
      tool.type !== "function" ||
      Object.keys(tool).some((key) => !["type", "function"].includes(key))
    )
      throw invalid("function 도구만 지원합니다.");
    const fn = tool.function;
    if (
      !isRecord(fn) ||
      Object.keys(fn).some(
        (key) => !["name", "description", "parameters", "strict"].includes(key),
      )
    )
      throw invalid("함수 정의 형식이 잘못되었습니다.");
    if (
      typeof fn.name !== "string" ||
      !NAME.test(fn.name) ||
      names.has(fn.name)
    )
      throw invalid(
        "함수 이름은 중복 없는 영숫자·밑줄·하이픈 1~64자여야 합니다.",
      );
    names.add(fn.name);
    if (
      fn.description !== undefined &&
      (typeof fn.description !== "string" ||
        fn.description.length > MAX_DESCRIPTION)
    )
      throw invalid(
        `함수 설명은 ${MAX_DESCRIPTION}자 이하 문자열이어야 합니다.`,
      );
    if (fn.strict !== undefined && typeof fn.strict !== "boolean")
      throw invalid("strict는 불리언이어야 합니다.");
    const parameters = fn.parameters ?? { type: "object", properties: {} };
    if (
      !isRecord(parameters) ||
      parameters.type !== "object" ||
      Buffer.byteLength(stableJson(parameters)) > MAX_SCHEMA_BYTES
    )
      throw invalid(
        "함수 매개변수는 64KiB 이하의 object JSON Schema여야 합니다.",
      );
    compileParameters(parameters);
    return {
      type: "function",
      function: {
        name: fn.name,
        ...(fn.description !== undefined
          ? { description: fn.description }
          : {}),
        parameters,
        ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
      },
    };
  });
}

function compileParameters(schema) {
  const compiler =
    typeof schema.$schema === "string" && schema.$schema.includes("2020-12")
      ? ajv2020
      : ajv;
  try {
    compiler.compile(schema);
    compiler.removeSchema(schema);
  } catch {
    throw invalid(
      "지원하지 않거나 잘못된 함수 JSON Schema입니다. 외부 참조는 허용하지 않습니다.",
    );
  }
}

export function normalizeToolChoice(value, tools) {
  const choice = value === undefined ? (tools.length ? "auto" : "none") : value;
  if (["auto", "none", "required"].includes(choice)) {
    if (choice === "required" && !tools.length)
      throw invalid("required에는 함수 도구가 필요합니다.");
    return choice;
  }
  if (
    !isRecord(choice) ||
    choice.type !== "function" ||
    Object.keys(choice).some((key) => !["type", "function"].includes(key)) ||
    !isRecord(choice.function) ||
    Object.keys(choice.function).some((key) => key !== "name") ||
    !tools.some((tool) => tool.function.name === choice.function.name)
  )
    throw invalid(
      "tool_choice는 auto·none·required 또는 선언된 함수여야 합니다.",
    );
  return { type: "function", function: { name: choice.function.name } };
}

export function normalizeHistoryCalls(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_CALLS)
    throw invalid("assistant.tool_calls는 1~64개 호출 배열이어야 합니다.");
  return value.map((call) => {
    if (
      !isRecord(call) ||
      call.type !== "function" ||
      typeof call.id !== "string" ||
      !ID.test(call.id) ||
      Object.keys(call).some((key) => !["id", "type", "function"].includes(key))
    )
      throw invalid("함수 호출 ID 또는 형식이 잘못되었습니다.");
    const fn = call.function;
    if (
      !isRecord(fn) ||
      typeof fn.name !== "string" ||
      !NAME.test(fn.name) ||
      typeof fn.arguments !== "string" ||
      Object.keys(fn).some((key) => !["name", "arguments"].includes(key))
    )
      throw invalid("함수 호출에는 이름과 JSON 인자 문자열이 필요합니다.");
    let args;
    try {
      args = JSON.parse(fn.arguments);
    } catch {
      throw invalid("함수 인자는 올바른 JSON이어야 합니다.");
    }
    if (!isRecord(args)) throw invalid("함수 인자는 JSON 객체여야 합니다.");
    return {
      id: call.id,
      type: "function",
      function: { name: fn.name, arguments: stableJson(args) },
    };
  });
}

export function validateHistory(messages) {
  const pending = new Map();
  const seen = new Set();
  for (const message of messages) {
    if (message.role === "tool") {
      if (
        typeof message.tool_call_id !== "string" ||
        !pending.has(message.tool_call_id)
      )
        throw invalid("결과에 대응하는 미완료 tool_call_id가 없습니다.");
      if (
        message.name !== undefined &&
        message.name !== pending.get(message.tool_call_id)
      )
        throw invalid("도구 결과 이름이 호출 이름과 다릅니다.");
      pending.delete(message.tool_call_id);
      continue;
    }
    if (pending.size)
      throw invalid("모든 함수 호출 결과를 반환한 뒤 대화를 계속해야 합니다.");
    for (const call of message.tool_calls ?? []) {
      if (seen.has(call.id))
        throw invalid("대화 내 함수 호출 ID는 고유해야 합니다.");
      seen.add(call.id);
      pending.set(call.id, call.function.name);
    }
  }
  if (pending.size) throw invalid("미완료 함수 호출의 결과가 필요합니다.");
}
