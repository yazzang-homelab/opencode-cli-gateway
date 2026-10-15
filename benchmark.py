#!/usr/bin/env python3
"""Chat Completions 또는 Responses 경유의 실제 생성·병렬 요청 벤치."""

import argparse
import concurrent.futures
import datetime
import json
import os
import statistics
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import urlsplit


def api_url(value):
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError()
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError()
        parsed.port
    except ValueError as error:
        raise argparse.ArgumentTypeError("자격증명·쿼리 없는 HTTP(S) URL이 필요합니다.") from error
    return value.rstrip("/")


def worker_count(value):
    number = int(value)
    if number < 1 or number > 64:
        raise argparse.ArgumentTypeError("워커 수는 1부터 64 사이여야 합니다.")
    return number


def call(index, barrier, *, base_url, model, api, key, timeout):
    nonce = uuid.uuid4().hex[:12]
    prompt = f'설명이나 코드 펜스 없이 JSON 객체만 출력해: nonce는 "{nonce}", squares는 1부터 16까지 정수의 제곱 배열.'
    messages = [{"role": "user", "content": prompt}]
    payload = {"model": model, "stream": True}
    if api == "chat":
        path = "/chat/completions"
        payload.update(messages=messages, max_tokens=1024, stream_options={"include_usage": True})
    else:
        path = "/responses"
        payload.update(input=messages, max_output_tokens=1024)
    request = urllib.request.Request(
        base_url + path,
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    barrier.wait()
    started = time.monotonic()
    record = {
        "worker": index,
        "success": False,
        "http": None,
        "text": "",
        "usage": {},
        "first_visible_text_s": None,
    }
    completed = False
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            record["http"] = response.status
            for raw in response:
                line = raw.decode().strip()
                if not line.startswith("data: ") or line[6:] == "[DONE]":
                    continue
                event = json.loads(line[6:])
                if api == "chat":
                    for choice in event.get("choices", []):
                        delta = choice.get("delta", {}).get("content", "")
                        if delta:
                            if record["first_visible_text_s"] is None:
                                record["first_visible_text_s"] = round(
                                    time.monotonic() - started, 3
                                )
                            record["text"] += delta
                        if choice.get("finish_reason") == "stop":
                            completed = True
                    if event.get("usage") is not None:
                        record["usage"] = event["usage"]
                else:
                    kind = event.get("type")
                    if kind == "response.output_text.delta":
                        if record["first_visible_text_s"] is None:
                            record["first_visible_text_s"] = round(time.monotonic() - started, 3)
                        record["text"] += event.get("delta", "")
                    if kind == "response.completed":
                        native = event.get("response", {})
                        completed = native.get("status") == "completed"
                        record["usage"] = native.get("usage", {})
                if "error" in event or event.get("type") == "response.failed":
                    completed = False
                    record["error"] = event.get("error", event.get("response", {}).get("error"))
                    break
        try:
            record["success"] = completed and json.loads(record["text"]) == {
                "nonce": nonce,
                "squares": [n * n for n in range(1, 17)],
            }
        except ValueError:
            pass
    except urllib.error.HTTPError as error:
        record["http"] = error.code
        try:
            record["error"] = json.load(error).get("error")
        except ValueError:
            record["error"] = "non-json error"
    except Exception as error:
        record["error"] = str(error)
    record["elapsed_s"] = round(time.monotonic() - started, 3)
    return record


def call_tools(index, barrier, *, base_url, model, api, key, timeout):
    """모델이 미리 알 수 없는 결과를 클라이언트 함수에서 생성해 같은 호출로 회신한다."""
    function = {
        "name": "lookup",
        "description": "외부 클라이언트 값 조회",
        "parameters": {
            "type": "object",
            "properties": {"key": {"type": "string"}},
            "required": ["key"],
            "additionalProperties": False,
        },
    }
    history = [
        {
            "role": "user",
            "content": 'lookup(key="alpha")를 반드시 호출하고 실제 반환된 value 문자열만 그대로 답하세요. 값을 추측하지 마세요.',
        }
    ]
    record = {
        "worker": index,
        "success": False,
        "http": None,
        "text": "",
        "usage": {},
        "tool_calls": 0,
        "http_requests": 0,
    }
    barrier.wait()
    started = time.monotonic()
    actual = None
    try:
        for _round in range(8):
            payload = {"model": model, "stream": False}
            if api == "chat":
                path = "/chat/completions"
                payload.update(
                    messages=history,
                    tools=[{"type": "function", "function": function}],
                    max_tokens=1024,
                )
            else:
                path = "/responses"
                payload.update(
                    input=history, tools=[{"type": "function", **function}], max_output_tokens=1024
                )
            request = urllib.request.Request(
                base_url + path,
                data=json.dumps(payload, ensure_ascii=False).encode(),
                headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            )
            record["http_requests"] += 1
            with urllib.request.urlopen(request, timeout=timeout) as response:
                record["http"] = response.status
                result = json.load(response)
            if api == "chat":
                choice = result["choices"][0]
                message = choice["message"]
                calls = message.get("tool_calls", [])
                text = message.get("content") or ""
                completed = choice["finish_reason"] == "stop"
            else:
                output = result.get("output", [])
                calls = [
                    {
                        "id": item["call_id"],
                        "function": {"name": item["name"], "arguments": item["arguments"]},
                    }
                    for item in output
                    if item.get("type") == "function_call"
                ]
                text = "".join(
                    part.get("text", "")
                    for item in output
                    for part in item.get("content", [])
                    if part.get("type") == "output_text"
                )
                completed = result.get("status") == "completed"
            if not calls:
                record["text"] = text
                record["usage"] = result.get("usage")
                record["success"] = (
                    completed and record["tool_calls"] > 0 and text.strip() == actual
                )
                break
            if actual is None:
                actual = "actual-client-" + uuid.uuid4().hex
            history.extend([message] if api == "chat" else output)
            for call in calls:
                fn = call["function"]
                if fn["name"] != "lookup" or json.loads(fn["arguments"]) != {"key": "alpha"}:
                    raise ValueError("함수 이름 또는 인자가 선언과 다릅니다.")
                record["tool_calls"] += 1
                content = json.dumps({"value": actual})
                history.append(
                    {"role": "tool", "tool_call_id": call["id"], "content": content}
                    if api == "chat"
                    else {"type": "function_call_output", "call_id": call["id"], "output": content}
                )
    except urllib.error.HTTPError as error:
        record["http"] = error.code
        try:
            record["error"] = json.load(error).get("error")
        except ValueError:
            record["error"] = "non-json error"
    except Exception as error:
        record["error"] = str(error)
    record["elapsed_s"] = round(time.monotonic() - started, 3)
    return record


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", type=api_url, default="http://127.0.0.1:8940/v1")
    parser.add_argument("--api", choices=["chat", "responses"], default="chat")
    parser.add_argument("--workload", choices=["text", "tools"], default="text")
    parser.add_argument("--model", default="deepseek-v4.1-flash-free")
    parser.add_argument("--key-file", type=Path, help="없으면 GATEWAY_API_KEY 환경변수 사용")
    parser.add_argument("--workers", nargs="+", type=worker_count, default=[1, 2, 4])
    parser.add_argument("--timeout", type=float, default=135)
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 600:
        parser.error("timeout은 0초 초과 600초 이하여야 합니다.")
    try:
        key = (
            args.key_file.read_text().strip()
            if args.key_file
            else os.environ.get("GATEWAY_API_KEY", "").strip()
        )
    except OSError:
        parser.error("키 파일을 읽을 수 없습니다.")
    if not key or any(character.isspace() for character in key):
        parser.error("GATEWAY_API_KEY 또는 --key-file로 공백 없는 인증 키를 제공하세요.")
    records = []
    print(
        json.dumps(
            {
                "timestamp": datetime.datetime.now().astimezone().isoformat(),
                "model": args.model,
                "api": args.api,
                "workload": args.workload,
                "client_retries": 0,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    for workers in args.workers:
        barrier = threading.Barrier(workers)
        started = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            batch = list(
                pool.map(
                    lambda index: (call_tools if args.workload == "tools" else call)(
                        index,
                        barrier,
                        base_url=args.base_url,
                        model=args.model,
                        api=args.api,
                        key=key,
                        timeout=args.timeout,
                    ),
                    range(workers),
                )
            )
        duration = time.monotonic() - started
        records.extend(batch)
        for row in batch:
            print(
                "RECORD " + json.dumps({"workers": workers, **row}, ensure_ascii=False), flush=True
            )
        print(
            "SUMMARY "
            + json.dumps(
                {
                    "workers": workers,
                    "requests": len(batch),
                    "success": sum(row["success"] for row in batch),
                    "http": [row["http"] for row in batch],
                    "wall_s": round(duration, 3),
                    "mean_s": round(statistics.mean(row["elapsed_s"] for row in batch), 3),
                    "requests_per_s": round(workers / duration, 3),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    print(
        "TOTAL "
        + json.dumps(
            {"requests": len(records), "success": sum(row["success"] for row in records)},
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0 if all(row["success"] for row in records) else 1


if __name__ == "__main__":
    raise SystemExit(main())
