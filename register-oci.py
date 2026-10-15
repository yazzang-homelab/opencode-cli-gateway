#!/usr/bin/env python3
"""SSH 안의 인증된 OpenCodex 관리 API에 CLI 중계 공급자를 등록한다."""

import argparse
import json
import re
import shlex
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

MODEL = "deepseek-v4.1-flash-free"
REMOTE_SCRIPT = r"""
import json,sys,urllib.request,urllib.error
from pathlib import Path
request=json.load(sys.stdin)
admin=Path(request['adminTokenFile']).expanduser().read_text().strip()
base=request['managementUrl']
headers={'Authorization':'Bearer '+admin,'Content-Type':'application/json'}
try:
 req=urllib.request.Request(base+'/api/providers',headers=headers)
 with urllib.request.urlopen(req,timeout=20) as response: existing=json.load(response)
 if any(provider.get('name')==request['registration']['name'] for provider in existing):
  print(json.dumps({'error':'기존 공급자는 덮어쓰지 않습니다.'},ensure_ascii=False))
  raise SystemExit(1)
 req=urllib.request.Request(base+'/api/providers',data=json.dumps(request['registration'],ensure_ascii=False).encode(),headers=headers,method='POST')
 with urllib.request.urlopen(req,timeout=60) as response:
  result=json.load(response)
  print(json.dumps({'http':response.status,'success':result.get('success'),'name':result.get('name')},ensure_ascii=False))
except urllib.error.HTTPError as error:
 print(json.dumps({'http':error.code,'error':'공급자 등록 요청이 거절되었습니다.'},ensure_ascii=False))
 raise SystemExit(1)
except (OSError,ValueError):
 print(json.dumps({'error':'관리 API 연결이나 자격증명 파일을 확인하세요.'},ensure_ascii=False))
 raise SystemExit(1)
"""


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


def provider_name(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise argparse.ArgumentTypeError(
            "공급자 이름은 영숫자로 시작하고 영숫자·점·밑줄·하이픈만 허용합니다."
        )
    return value


def registration(name, gateway_url, token):
    return {
        "name": name,
        "setDefault": False,
        "provider": {
            "adapter": "openai-chat",
            "baseUrl": gateway_url,
            "apiKey": token,
            "authMode": "key",
            "allowPrivateNetwork": True,
            "defaultModel": MODEL,
            "models": [MODEL],
            "liveModels": True,
            "contextWindow": 128000,
            "defaultMaxOutputTokens": 8192,
            "modelMaxOutputTokens": {MODEL: 8192},
            "modelCapabilities": {MODEL: {"inputModalities": ["text"]}},
            "modelDisplayNames": {MODEL: "DeepSeek V4.1 Flash Free · CLI 클라이언트 도구 왕복"},
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ssh-host", required=True, help="관리 호스트에 접속할 SSH 대상 또는 별칭")
    parser.add_argument(
        "--gateway-base-url",
        required=True,
        type=api_url,
        help="관리 호스트에서 접근 가능한 게이트웨이 /v1 URL",
    )
    parser.add_argument("--token-file", type=Path, default=Path("/etc/opencode-cli-gateway/token"))
    parser.add_argument("--name", type=provider_name, default="opencode-cli")
    parser.add_argument(
        "--admin-token-file",
        default="~/.opencodex/admin-api-token",
        help="원격 호스트의 관리자 토큰 경로",
    )
    parser.add_argument("--management-url", type=api_url, default="http://127.0.0.1:10101")
    args = parser.parse_args(argv)
    if args.ssh_host.startswith("-"):
        parser.error("SSH 대상은 옵션으로 시작할 수 없습니다.")
    if urlsplit(args.management_url).hostname not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("관리 자격증명은 SSH 호스트의 루프백 API로만 전송합니다.")
    try:
        token = args.token_file.read_text().strip()
    except OSError:
        parser.error("게이트웨이 토큰 파일을 읽을 수 없습니다.")
    if len(token) < 32 or any(character.isspace() for character in token):
        parser.error("토큰은 공백 없는 32자 이상 문자열이어야 합니다.")
    payload = {
        "registration": registration(args.name, args.gateway_base_url, token),
        "managementUrl": args.management_url,
        "adminTokenFile": args.admin_token_file,
    }
    result = subprocess.run(
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            "--",
            args.ssh_host,
            "python3 -c " + shlex.quote(REMOTE_SCRIPT),
        ],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        timeout=90,
    )
    print(result.stdout, end="")
    if result.returncode:
        print("등록에 실패했습니다. SSH 접속 및 관리 API 설정을 확인하세요.")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
