import argparse
import concurrent.futures
import contextlib
import importlib.util
import io
import json
import re
import secrets
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


benchmark = load("public_benchmark", "benchmark.py")
register = load("public_register", "register-oci.py")


class PublicScriptTests(unittest.TestCase):
    def test_urls_reject_credentials_queries_and_invalid_ports(self):
        for module in [benchmark, register]:
            for url in [
                "file:///etc/passwd",
                "http://user:password@localhost/v1",
                "http://localhost/v1?secret=value",
                "http://localhost/v1#fragment",
                "http://localhost:invalid/v1",
            ]:
                with self.subTest(module=module.__name__, url=url):
                    with self.assertRaises(argparse.ArgumentTypeError):
                        module.api_url(url)

    def test_worker_bounds(self):
        for value in ["0", "65", "-1"]:
            with self.assertRaises(argparse.ArgumentTypeError):
                benchmark.worker_count(value)

    def test_registration_keeps_token_off_process_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            token = secrets.token_urlsafe(40)
            path = Path(directory) / "gateway.token"
            path.write_text(token)
            with patch.object(
                register.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0, stdout='{"success":true}\n'),
            ) as run:
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    code = register.main(
                        [
                            "--ssh-host",
                            "test-host",
                            "--gateway-base-url",
                            "http://127.0.0.1:8940/v1",
                            "--token-file",
                            str(path),
                        ]
                    )
                self.assertEqual(code, 0)
                arguments = run.call_args.args[0]
                self.assertNotIn(token, " ".join(arguments))
                self.assertNotIn(token, output.getvalue())
                payload = json.loads(run.call_args.kwargs["input"])
                self.assertEqual(payload["registration"]["provider"]["apiKey"], token)
                self.assertEqual(
                    payload["registration"]["provider"]["baseUrl"], "http://127.0.0.1:8940/v1"
                )
                self.assertFalse(payload["registration"]["setDefault"])
                self.assertEqual(payload["adminTokenFile"], "~/.opencodex/admin-api-token")

    def test_registration_refuses_non_loopback_admin_destination(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                register.main(
                    [
                        "--ssh-host",
                        "test-host",
                        "--gateway-base-url",
                        "http://127.0.0.1:8940/v1",
                        "--management-url",
                        "https://example.com",
                    ]
                )

    def endpoint(self, api, *, failed=False):
        key = secrets.token_urlsafe(32)
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append((self.path, self.headers.get("Authorization")))
                messages = body["messages"] if api == "chat" else body["input"]
                nonce = re.search(r'nonce는 "([a-z0-9]+)"', messages[0]["content"]).group(1)
                text = json.dumps({"nonce": nonce, "squares": [n * n for n in range(1, 17)]})
                if api == "chat":
                    events = [
                        {"choices": [{"delta": {"content": text}, "finish_reason": None}]},
                        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
                        {
                            "choices": [],
                            "usage": {
                                "prompt_tokens": 11,
                                "completion_tokens": 12,
                                "total_tokens": 23,
                            },
                        },
                    ]
                else:
                    events = [
                        {"type": "response.output_text.delta", "delta": text},
                        {
                            "type": "response.completed",
                            "response": {
                                "status": "completed",
                                "usage": {
                                    "input_tokens": 11,
                                    "output_tokens": 12,
                                    "total_tokens": 23,
                                },
                            },
                        },
                    ]
                if failed:
                    events.append({"error": {"message": "fixture failure"}})
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for event in events:
                    self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}/v1", key, requests

    def test_chat_and_responses_benchmark_streams(self):
        for api in ["chat", "responses"]:
            with self.subTest(api=api):
                url, key, requests = self.endpoint(api)
                barrier = threading.Barrier(2)
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(
                        pool.map(
                            lambda index: benchmark.call(
                                index,
                                barrier,
                                base_url=url,
                                model="fixture",
                                api=api,
                                key=key,
                                timeout=5,
                            ),
                            range(2),
                        )
                    )
                self.assertTrue(all(row["success"] for row in results))
                self.assertTrue(all(row["usage"]["total_tokens"] == 23 for row in results))
                self.assertEqual(len(requests), 2)
                path = "/v1/chat/completions" if api == "chat" else "/v1/responses"
                self.assertTrue(all(request == (path, "Bearer " + key) for request in requests))

    def test_stream_error_is_not_success_even_after_text(self):
        url, key, _requests = self.endpoint("chat", failed=True)
        result = benchmark.call(
            0, threading.Barrier(1), base_url=url, model="fixture", api="chat", key=key, timeout=5
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["error"]["message"], "fixture failure")


if __name__ == "__main__":
    unittest.main()
