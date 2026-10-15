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
const MAX_TOOLS = 64;

function invalid(message) {
  return new GatewayError(400, "invalid_tools", message);
}
export const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const mcpFunctionName = (index) => "fn" + index;

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
    throw invalid("tools는 64개 이하의 함수 배열이어야 합니다.");
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
      (typeof fn.description !== "string" || fn.description.length > 8192)
    )
      throw invalid("함수 설명은 8192자 이하 문자열이어야 합니다.");
    if (fn.strict !== undefined && typeof fn.strict !== "boolean")
      throw invalid("strict는 불리언이어야 합니다.");
    const parameters = fn.parameters ?? { type: "object", properties: {} };
    if (
      !isRecord(parameters) ||
      parameters.type !== "object" ||
      Buffer.byteLength(stableJson(parameters)) > 16384
    )
      throw invalid(
        "함수 매개변수는 16KiB 이하의 object JSON Schema여야 합니다.",
      );
    compileParameters(parameters);
    mcpToolSchema(parameters);
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

export function compileParameters(schema) {
  const compiler =
    typeof schema.$schema === "string" && schema.$schema.includes("2020-12")
      ? ajv2020
      : ajv;
  try {
    const validate = compiler.compile(schema);
    compiler.removeSchema(schema);
    return validate;
  } catch {
    throw invalid(
      "지원하지 않거나 잘못된 함수 JSON Schema입니다. 외부 참조는 허용하지 않습니다.",
    );
  }
}

// OpenCode forces additionalProperties:false on the MCP root. An envelope keeps
// the caller's original object schema intact rather than silently narrowing it.
export function mcpToolSchema(parameters) {
  const original = structuredClone(parameters);
  const visit = (schema, root = false) => {
    if (!isRecord(schema)) return;
    if (!root && typeof schema.$id === "string")
      throw invalid("중첩 $id는 지원하지 않습니다.");
    if (schema.$dynamicRef !== undefined || schema.$recursiveRef !== undefined)
      throw invalid("동적 스키마 참조는 지원하지 않습니다.");
    if (typeof schema.$ref === "string") {
      if (schema.$ref !== "#" && !schema.$ref.startsWith("#/"))
        throw invalid("로컬 JSON Pointer 스키마 참조만 지원합니다.");
      schema.$ref = "#/properties/arguments" + schema.$ref.slice(1);
    }
    delete schema.$id;
    delete schema.$schema;
    for (const key of [
      "properties",
      "patternProperties",
      "$defs",
      "definitions",
      "dependentSchemas",
      "dependencies",
    ]) {
      if (isRecord(schema[key]))
        for (const child of Object.values(schema[key]))
          if (!Array.isArray(child)) visit(child);
    }
    for (const key of [
      "items",
      "prefixItems",
      "additionalProperties",
      "unevaluatedProperties",
      "contains",
      "not",
      "if",
      "then",
      "else",
      "propertyNames",
      "additionalItems",
      "unevaluatedItems",
      "contentSchema",
      "allOf",
      "anyOf",
      "oneOf",
    ]) {
      if (Array.isArray(schema[key]))
        schema[key].forEach((child) => visit(child));
      else visit(schema[key]);
    }
  };
  visit(original, true);
  return {
    ...(parameters.$schema ? { $schema: parameters.$schema } : {}),
    type: "object",
    properties: { arguments: original },
    required: ["arguments"],
    additionalProperties: false,
  };
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
  if (!Array.isArray(value) || !value.length || value.length > MAX_TOOLS)
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
