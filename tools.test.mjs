import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTools,
  normalizeToolChoice,
  normalizeHistoryCalls,
  validateHistory,
  stableJson,
} from "./tools.mjs";

const tool = {
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
};
const call = {
  id: "call_one",
  type: "function",
  function: { name: "lookup", arguments: '{"key":"alpha"}' },
};

test("함수 정의는 원래 스키마를 그대로 보존하고 이름·정의·초안 오류를 거절한다", () => {
  assert.deepEqual(normalizeTools([tool]), [tool]);
  for (const tools of [
    null,
    {},
    [tool, tool],
    [{ type: "custom" }],
    [{ type: "function", function: { name: "has.dot" } }],
    [{ ...tool, extra: true }],
    [
      {
        type: "function",
        function: { name: "bad", parameters: { type: "array" } },
      },
    ],
    [
      {
        type: "function",
        function: {
          name: "bad",
          parameters: { type: "object", $ref: "https://example.com/schema" },
        },
      },
    ],
    [
      {
        type: "function",
        function: { name: "bad", parameters: { type: "object", $schema: 42 } },
      },
    ],
    Array(65).fill(tool),
  ]) {
    assert.throws(
      () => normalizeTools(tools),
      (error) => error.status === 400,
    );
  }
});

test("draft-07와 2020-12 및 로컬 참조를 허용하고 사용자 스키마 ID를 전역 캐시에 남기지 않는다", () => {
  for (const $schema of [
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2020-12/schema",
  ]) {
    const parameters = {
      $schema,
      $id: "urn:fixture:tool",
      type: "object",
      $defs: { key: { type: "integer", minimum: 2 } },
      properties: { value: { $ref: "#/$defs/key" } },
      required: ["value"],
    };
    for (let i = 0; i < 3; i++) {
      const [normalized] = normalizeTools([
        {
          type: "function",
          function: {
            name: "fixture",
            parameters: structuredClone(parameters),
          },
        },
      ]);
      assert.deepEqual(normalized.function.parameters, parameters);
    }
  }
});

test("tool_choice 강제 함수는 선언된 이름만 허용한다", () => {
  assert.deepEqual(
    normalizeToolChoice({ type: "function", function: { name: "lookup" } }, [
      tool,
    ]),
    { type: "function", function: { name: "lookup" } },
  );
  assert.equal(normalizeToolChoice("required", [tool]), "required");
  for (const choice of [
    null,
    "required",
    { type: "function", function: { name: "unknown" } },
  ])
    assert.throws(
      () => normalizeToolChoice(choice, []),
      (error) => error.status === 400,
    );
});

test("호출 인자의 원래 타입을 보존하고 잘못된 JSON을 복구하거나 텍스트로 치환하지 않는다", () => {
  assert.equal(
    normalizeHistoryCalls([call])[0].function.arguments,
    '{"key":"alpha"}',
  );
  for (const changed of [
    { ...call, function: { name: "lookup", arguments: "broken" } },
    { ...call, function: { name: "lookup", arguments: "[]" } },
    { ...call, function: { name: 123, arguments: "{}" } },
    { ...call, id: "" },
  ])
    assert.throws(
      () => normalizeHistoryCalls([changed]),
      (error) => error.status === 400,
    );
});

test("모든 호출 ID는 고유하고 실제 결과와 한 번씩 대응해야 한다", () => {
  const assistant = { role: "assistant", content: "", tool_calls: [call] };
  const result = { role: "tool", tool_call_id: call.id, content: "actual" };
  validateHistory([assistant, result]);
  for (const messages of [
    [result],
    [assistant],
    [assistant, result, result],
    [assistant, { ...result, tool_call_id: "other" }],
    [assistant, { ...result, name: "wrong" }],
    [assistant, { role: "user", content: "skip" }, result],
    [assistant, result, assistant, result],
  ])
    assert.throws(
      () => validateHistory(messages),
      (error) => error.status === 400,
    );
});

test("대화 비교는 JSON 객체 키 순서에 의존하지 않는다", () => {
  assert.equal(
    stableJson({ b: [1, { z: 3, a: 4 }], a: 2 }),
    stableJson({ a: 2, b: [1, { a: 4, z: 3 }] }),
  );
  assert.notEqual(stableJson({ a: [1, 2] }), stableJson({ a: [2, 1] }));
  assert.throws(
    () => stableJson({ a: Infinity }),
    (error) => error.status === 400,
  );
});
