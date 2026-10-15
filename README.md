# opencode-cli-gateway

정식 **OpenCode CLI를 실행**해 텍스트 생성과 **클라이언트 소유 함수 도구의 호출·결과 왕복**을 OpenAI Chat Completions API로 중계합니다. 모델은 `deepseek-v4.1-flash-free`, CLI는 `opencode-ai@1.19.0`으로 고정합니다.

**비공식·독립 프로젝트입니다.** OpenCode·Anthropic·OpenAI·Gajae-Code의 공식 제품이나 완전한 호환성을 주장하지 않습니다. 다른 클라이언트로 위장하는 헤더를 사용하지 않습니다. 무료 모델의 제공 기간·한도·가격·가용성은 상류 정책에 달려 있습니다.

## 실행과 도구 소유권

```text
클라이언트 → Chat Completions → 정식 OpenCode CLI → 모델
                                  ↕ 공식 MCP
                             대기 중인 함수 호출
                                  ↕
클라이언트 ← tool_calls + 호출 ID ← 게이트웨이
클라이언트가 실제 도구 실행
클라이언트 → tool_call_id + 실제 결과 → 같은 MCP 호출 → 같은 CLI의 후속 추론
```

- **파일 읽기·쓰기·셸 실행은 클라이언트가 수행합니다.** 게이트웨이는 클라이언트 함수의 이름·인자를 반환하고 실제 결과를 기다립니다. 게이트웨이 호스트에서 해당 함수를 실행하지 않습니다.
- 네이티브 OpenCode의 기본 도구는 `ask`로 두며, 고정 버전의 비대화형 CLI가 권한을 자동 거절합니다. 요청별로 등록한 `caller_*` MCP 도구만 허용합니다. 네이티브 기본 도구 이벤트가 나오면 실패 처리해 클라이언트가 이중 실행하지 않게 합니다.
- MCP 어댑터는 실제 결과가 오기 전까지 Promise를 완료하지 않습니다. 위임 오류나 가짜 결과를 반환해 모델을 재시작하는 방식이 아닙니다.
- MCP 이름 길이에 맞춘 짧은 내부 이름을 사용하지만, 외부 API의 함수 이름·인자는 그대로 보존합니다. 64자 원래 함수 이름의 실제 MCP SDK 왕복도 검증했습니다.
- 도구 결과 대기 중에는 **CLI·MCP 프로세스와 요청 디렉터리를 유지**합니다. 완료·진행 중 요청 취소·대기 TTL 만료·서버 종료 시 정리합니다. 게이트웨이를 재시작하면 보류 중 세션은 복구되지 않습니다.
- `system`·`developer` 메시지는 첫 CLI에 전달하는 대화 기록입니다. 네이티브 에이전트의 시스템 지시나 역할 우선순위를 교체하는 API는 아닙니다.

이 경계는 GJC Cursor 공급자가 호출 ID·이름·인자를 전달한 뒤 실제 실행 결과를 기다리는 계약을 참고했습니다. 네이티브 도구를 이미 실행한 뒤 표시만 하는 agent-level 공급자와는 다릅니다.

## 지원 범위

| 항목               | 지원과 제한                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                | `POST /v1/chat/completions`, `GET /v1/models`: Bearer 인증 필요                                                                                                             |
| 상태               | `GET /healthz`: 인증 없이 HTTP `active`와 네이티브 `workers` 상태 제공. 상류 생성 검사는 아님                                                                               |
| 도구               | OpenAI `type: function`, 함수 정의 최대 64개, 이름은 영숫자·밑줄·하이픈 1~64자                                                                                              |
| 입력               | `system`, `developer`, `user`, `assistant`, `tool`. 텍스트 문자열·텍스트 파트 배열                                                                                          |
| 도구 이력          | `assistant.tool_calls`와 `tool.tool_call_id`; 모든 호출에 정확히 한 번씩 결과를 회신                                                                                        |
| 도구 선택          | `auto`, `none`, `required`, 선언된 함수 강제 선택. 모델이 선택 제약을 위반하면 명시적 오류이며 호출을 합성하지 않음                                                         |
| 병렬 도구          | 보류 호출을 모두 보존. `parallel_tool_calls: false`는 한 번에 하나씩 전달; 나머지는 다음 결과 왕복에서 전달                                                                 |
| JSON Schema        | object 루트, 함수당 16KiB. draft-07·2020-12, 로컬 JSON Pointer 참조. 외부 참조·중첩 `$id`·동적 참조 미지원                                                                  |
| 인자 검증          | 원래 호출자 스키마로 검증. 정식 MCP의 루트 속성 제한이 스키마를 바꾸지 않도록 내부 포장을 사용하고, 클라이언트에는 원래 인자만 반환                                         |
| SSE                | 완성된 텍스트 파트와 완성된 함수 호출을 청크로 전송. 모델 토큰별 실시간 스트림은 아님                                                                                       |
| 출력 한도          | `max_tokens` 또는 `max_completion_tokens` 1~8192, 기본 1024. 둘 다 있으면 값이 같아야 함                                                                                    |
| 샘플링             | `temperature` 0~2, `top_p` 0~1                                                                                                                                              |
| 사용량             | 도구 호출 직후 아직 네이티브 사용량이 없으면 `usage: null`. 이후 보고된 단계 사용량을 중복 없이 반환                                                                        |
| 미지원             | 이미지·오디오·동영상·이미지 도구 결과, legacy `function` 역할, custom/freeform 도구의 직접 입력, `response_format`, `stop`, `seed`, `reasoning_effort` 등 허용 목록 밖 필드 |
| 응답 저장          | `store: false`만 허용. 상태·캐시·상류까지 무기록임을 보장하는 옵션은 아님                                                                                                   |
| Responses·Messages | 직접 제공하지 않음. 별도 프로토콜 프록시 필요                                                                                                                               |

일반 함수 도구는 실제 왕복을 지원하지만, 모든 코딩 클라이언트의 모든 요청 필드·도구 종류까지 호환된다는 뜻은 아닙니다. JSON Schema의 `format`은 주석으로 취급하며 URI·날짜 등의 의미 검증을 강제하지 않습니다. 클라이언트도 자체 인자 검증·권한 정책·실행 격리를 적용해야 합니다.

## 설치와 로컬 실행

Linux, Node.js 20 이상, npm, 상류 네트워크 연결이 필요합니다. 벤치·SSH 등록 스크립트에는 Python 3이 필요하며 추가 Python 패키지는 없습니다. 다른 OS·CLI 버전은 검증하지 않았습니다.

```bash
git clone https://github.com/yazzang-homelab/opencode-cli-gateway.git
cd opencode-cli-gateway
npm ci
umask 077
export GATEWAY_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-cli-gateway"
export GATEWAY_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/opencode-cli-gateway"
mkdir -p "$GATEWAY_STATE_DIR" "$GATEWAY_CACHE_DIR"
chmod 700 "$GATEWAY_STATE_DIR" "$GATEWAY_CACHE_DIR"
export GATEWAY_TOKEN_FILE="$GATEWAY_STATE_DIR/token"
if [[ ! -e "$GATEWAY_TOKEN_FILE" ]]; then
  node --input-type=module -e '
    import { randomBytes } from "node:crypto";
    import { writeFileSync } from "node:fs";
    writeFileSync(process.env.GATEWAY_TOKEN_FILE, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  '
fi
chmod 600 "$GATEWAY_TOKEN_FILE"
GATEWAY_HOST=127.0.0.1 GATEWAY_PORT=8940 npm start
```

토큰을 화면에 출력하거나 소스에 저장하지 마세요. 별도 터미널에서 같은 토큰 파일을 읽습니다.

```bash
export GATEWAY_TOKEN_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-cli-gateway/token"
IFS= read -r GATEWAY_API_KEY < "$GATEWAY_TOKEN_FILE"
export GATEWAY_API_KEY
export GATEWAY_BASE_URL=http://127.0.0.1:8940/v1
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $GATEWAY_API_KEY" "$GATEWAY_BASE_URL/models"
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $GATEWAY_API_KEY" -H 'Content-Type: application/json' \
  "$GATEWAY_BASE_URL/chat/completions" --data-binary '{
    "model":"deepseek-v4.1-flash-free",
    "messages":[{"role":"user","content":"17의 제곱을 숫자로만 답하세요."}],
    "max_tokens":256
  }'
```

### 도구 왕복 규칙

1. `tools`에 JSON Schema 함수 정의를 제공해 요청합니다.
2. 응답의 `finish_reason: "tool_calls"`, `message.tool_calls[].id/name/arguments`를 읽습니다. 인자는 JSON 문자열입니다.
3. **그 assistant 메시지를 그대로 대화에 추가**하고 클라이언트에서 허용된 도구만 실행합니다.
4. 각 호출의 실제 결과를 `{"role":"tool","tool_call_id":"반환된 ID","content":"실제 결과"}`로 추가합니다.
5. **동일한 대화 이력·도구 정의·모델·출력 한도·샘플링 설정**으로 요청합니다. 같은 네이티브 CLI의 보류 호출에 결과가 회신됩니다. 추가 호출이 나오면 반복합니다.

원래 이력을 바꾸거나 결과를 누락·중복·다른 세션 ID로 회신하면 거절합니다. 도구 결과 순서는 바꿀 수 있지만 직전 응답의 모든 호출 결과가 필요합니다. 같은 세션을 동시에 재개할 수 없습니다. 새로운 사용자 턴은 완료된 이전 도구 이력을 포함해 새 CLI에서 시작할 수 있습니다.

실행 가능한 검증 클라이언트도 제공합니다. 모델이 도구를 호출한 **뒤에** 클라이언트가 무작위 값을 생성해 실제 결과로 반환하고 최종 답과 비교합니다. 임의 셸 명령을 실행하는 벤치가 아닙니다.

```bash
python3 benchmark.py --base-url http://127.0.0.1:8940/v1 \
  --api chat --workload tools --key-file "$GATEWAY_TOKEN_FILE" --workers 1 2 4
```

## 환경변수와 자원 상한

| 변수                  | 기본값                                | 의미                                                     |
| --------------------- | ------------------------------------- | -------------------------------------------------------- |
| `GATEWAY_TOKEN_FILE`  | 필수                                  | 공백 없는 32자 이상 Bearer 토큰 파일                     |
| `GATEWAY_HOST`        | `127.0.0.1`                           | 수신 주소                                                |
| `GATEWAY_PORT`        | `8940`                                | 1~65535                                                  |
| `GATEWAY_WORKERS`     | `4`                                   | 네이티브 CLI 상한, 1~8. **도구 결과 대기도 워커를 점유** |
| `GATEWAY_TIMEOUT_MS`  | `120000`                              | HTTP 한 단계 제한, 1000~300000ms                         |
| `GATEWAY_TOOL_TTL_MS` | `300000`                              | 응답 전달 후 외부 결과 대기 제한, 1000~3600000ms         |
| `GATEWAY_STATE_DIR`   | `/var/lib/opencode-cli-gateway`       | 요청별 작업·IPC·네이티브 상태 디렉터리                   |
| `GATEWAY_CACHE_DIR`   | `/var/cache/opencode-cli-gateway`     | 공용 캐시                                                |
| `OPENCODE_EXECUTABLE` | 프로젝트 `node_modules/.bin/opencode` | 고정 버전 정식 실행 파일                                 |

`/healthz`의 `active`는 처리 중 HTTP 수, `workers.active`는 실행·도구 대기 중 CLI 수, `workers.waitingForTools`는 결과 대기 수입니다. HTTP가 끝나도 외부 도구를 기다리는 CLI는 유지됩니다.

본문은 1MiB, 네이티브 세션 전체 stdout은 2MiB, 개별 함수 인자는 64KiB로 제한합니다. 보류 호출은 최대 64개, 네이티브 세션의 총 호출은 최대 256개입니다. SSE 파트·송신 버퍼는 1MiB 상한입니다. 큰 파일·많은 도구 출력·긴 명령에서는 한도와 TTL을 고려하세요. 대기 TTL을 초과한 결과는 되살리거나 다른 세션에 적용하지 않습니다.

| 상태 | 대표 원인                                                                  |
| ---- | -------------------------------------------------------------------------- |
| 400  | 잘못된 스키마·호출 이력·미지원 필드·이미지                                 |
| 401  | Bearer 불일치                                                              |
| 403  | 네이티브 기본 도구 실행 시도 또는 상류 거절                                |
| 404  | 잘못된 모델·경로                                                           |
| 409  | 다른 대화·도구 정의·생성 설정, 중복 결과, 세션 동시 재개                   |
| 410  | 종료·만료된 도구 세션                                                      |
| 413  | HTTP 본문 초과                                                             |
| 429  | HTTP 또는 네이티브 워커 포화; 대기 세션의 정상 재개는 새 CLI를 만들지 않음 |
| 502  | 상류·MCP·스키마에 맞지 않는 호출·모델의 도구 선택 위반·불완전 응답         |
| 504  | HTTP 단계 시간 초과                                                        |

## 보안과 systemd

**공개 인터넷에 평문 HTTP로 노출하지 마세요.** 루프백, SSH 터널, 접근 제한 사설망 또는 인증·접근 제어가 있는 TLS 프록시를 사용하세요. 자체 TLS·사용자별 계정·할당량은 없습니다. 하나의 공유 토큰과 호출 ID를 사용하는 서비스이며, 호출 ID는 사용자 인증을 대체하지 않습니다.

토큰 파일은 `0600`, 비밀 디렉터리는 `0700`으로 관리하고 curl 추적 로그를 켜지 마세요. 입력·함수 정의·결과는 상류 모델로 전달됩니다. HOME/XDG 분리와 권한 설정은 완전한 OS 샌드박스가 아닙니다. 전용 비특권 서비스와 고정 CLI를 사용하세요. 도구 대기 중 민감한 이력·결과가 메모리·네이티브 상태에 남고, 강제 종료 뒤 작업 파일이 남을 수 있습니다. 클라이언트가 호출 응답을 받은 뒤 결과를 보내지 않고 사라지면 TTL까지 자원이 유지됩니다.

서비스 예제는 `DynamicUser`, `LoadCredential`, `ProtectHome`, `ProtectSystem`, 프로세스 그룹 정리와 2GiB 메모리 상한을 사용합니다. 많은 워커·큰 컨텍스트에서는 메모리 상한과 호스트 여유에 맞춰 동시성을 조정하세요. 아래는 **신규 설치 예시**이며 기존 토큰·설치를 덮어쓰는 업그레이드 절차가 아닙니다.

```bash
sudo install -d -m 0755 /opt/opencode-cli-gateway
sudo install -m 0644 main.mjs server.mjs cli.mjs errors.mjs tools.mjs \
  tool-bridge.mjs mcp-bridge.mjs package.json package-lock.json /opt/opencode-cli-gateway/
sudo npm ci --omit=dev --no-audit --no-fund --prefix /opt/opencode-cli-gateway
sudo install -d -m 0700 /etc/opencode-cli-gateway
sudo install -m 0600 "$GATEWAY_TOKEN_FILE" /etc/opencode-cli-gateway/token
sudo install -m 0644 opencode-cli-gateway.service /etc/systemd/system/opencode-cli-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-cli-gateway.service
curl --fail-with-body --silent --show-error http://127.0.0.1:8940/healthz
```

## 검증과 벤치마크

```bash
npm test
python3 -m unittest -v test_public_scripts.py
```

Node 테스트는 HTTP·SSE·세션 소유권·호출 ID·TTL·취소·스키마·정식 MCP SDK 왕복을 검증합니다. 모델 대신 대체 CLI 프로세스를 사용하는 회귀 테스트와 실제 상류 호출 검증을 구분합니다. 현재 Node **48개**, Python **7개** 통과를 확인했습니다.

별도의 실제 모델 검증:

- 정식 CLI가 MCP 호출을 대기한 뒤, 클라이언트만 알던 무작위 결과를 같은 실행에서 사용해 답변했습니다.
- 실제 네 세션을 모두 도구 결과 대기로 유지해 `active:4`, `waitingForTools:4`를 확인했습니다. 다섯 번째 요청은 429, 잘못된 교차 결과는 거절됐고, 네 세션 모두 각자의 결과로 완료한 뒤 워커·임시 디렉터리가 0으로 정리됐습니다.
- GJC 0.18.11에서 `read`를 **클라이언트가 실제 실행**하고 같은 호출 ID로 회신해 최종 파일 내용을 답하는 왕복을 직접 연결 및 OCI 프록시 경유 모두 검증했습니다.
- 최종 운영본에서도 GJC → OCI → 게이트웨이 → CLI로 **읽기 → 실제 결과 → 쓰기 → 실제 결과 → 최종 답변**을 검증했습니다. 클라이언트 전용 임시 파일의 무작위 본문을 읽어 다른 파일에 기록했고, 두 호출의 ID·성공 결과·실제 파일 내용을 확인했습니다.
- OCI Responses → 게이트웨이 → CLI 경로의 함수 왕복 **7/7 성공**: 워커 1·2·4의 평균 전체 왕복 시간은 각각 **12.02초·13.01초·12.93초**였습니다. 함수 호출과 실제 결과 회신의 두 HTTP 요청을 포함합니다.
- 최종 운영본으로 4워커를 다시 측정해 **4/4 추가 성공**, 전체 17.36초·평균 15.39초를 확인했습니다. 두 벤치 합계는 **11/11**, 클라이언트 재시도는 0회입니다.

소규모 관측이며 장시간 안정성·최대 처리량·다른 장비에서의 성능 보장이 아닙니다. 초기 상류 502 및 기본 도구를 모두 제거한 설정의 403도 관측했습니다. 성공하지 않은 조건을 자동 우회하지 않습니다. 개인 운영정보가 포함된 원본 결과 파일은 공개 저장소에서 제외합니다.

추가 코드 검토 요청에서는 연속 파일 읽기 도중 410, 전체 소스를 제공한 요청에서 502가 관측됐으며 원인은 미확정입니다. 해당 독립 검토는 완료되지 않았습니다. 위의 성공한 짧은 왕복 검증을 장기·대용량 코딩 세션의 안정성 보장으로 해석하지 마세요.

텍스트 벤치는 `--workload text`이며 기본값입니다. 프록시를 통한 Responses 도구 벤치는 다음처럼 별도 프록시 키와 모델 ID를 사용합니다.

```bash
(
  IFS= read -r -s -p '프록시 접속 키: ' GATEWAY_API_KEY
  printf '\n'
  export GATEWAY_API_KEY
  python3 benchmark.py --base-url http://127.0.0.1:10100/v1 \
    --api responses --workload tools \
    --model opencode-cli/deepseek-v4.1-flash-free --workers 1 2 4
)
```

## 부록 공통: 프로토콜 프록시

이 서버는 Chat Completions만 제공합니다. [OpenCodex (`ocx`)](https://github.com/lidge-jun/opencodex) 같은 별도 프록시가 Messages·Responses를 변환할 수 있습니다. 프록시가 함수 이름·호출 ID·인자·결과를 보존해야 하며, 초기 요청과 결과 회신은 **같은 게이트웨이 인스턴스**로 라우팅해야 합니다. 재시도·다른 인스턴스 전환으로 보류 세션을 복구할 수 없습니다.

| 위치                     | 값                                                            |
| ------------------------ | ------------------------------------------------------------- |
| 공급자 이름 예시         | `opencode-cli`                                                |
| 상류 어댑터·URL          | `openai-chat`, 같은 호스트면 `http://127.0.0.1:8940/v1`       |
| 상류 자격증명            | 게이트웨이 토큰, `key` 인증                                   |
| 상류 모델                | `deepseek-v4.1-flash-free`                                    |
| 클라이언트용 프록시 모델 | `opencode-cli/deepseek-v4.1-flash-free`                       |
| Messages 기본 URL        | `http://127.0.0.1:10100`                                      |
| Responses·Chat 기본 URL  | `http://127.0.0.1:10100/v1`                                   |
| 클라이언트 키            | **프록시 접속 키**. 게이트웨이 토큰·관리자 키와 혼동하지 않음 |

등록 스크립트는 기존 이름을 덮어쓰거나 기본 공급자를 바꾸지 않습니다. SSH 대상의 관리자 키는 원격에서 읽고 게이트웨이 키는 표준입력으로 전달합니다. 관리 API는 SSH 대상의 루프백만 허용합니다.

```bash
python3 register-oci.py --ssh-host your-relay \
  --gateway-base-url http://127.0.0.1:8940/v1 --token-file "$GATEWAY_TOKEN_FILE"
```

루프백은 각 프로세스의 호스트 자신입니다. 다른 호스트는 보호된 연결을 구성하세요. OpenCodex의 설치·Codex 설정 동기화 동작은 [해당 프로젝트 문서](https://opencodex.me/)를 확인하세요. 모델 목록의 추론된 영상·기능 표기만으로 이 서버의 제한이 바뀌지 않습니다.

## 부록 A. Claude Code

Claude Code는 Anthropic Messages를 쓰므로 8940 직접 연결은 불가합니다. 별도 Messages 프록시가 필요하며, 함수 왕복 지원과 특정 Claude Code 버전의 모든 요청 호환성은 다릅니다.

Claude Code 2.1.292의 이전 텍스트 전용 호출에서는 프록시 경유 400 `unsupported_parameter`를 관측했습니다. 도구 왕복 추가만으로 이 추가 필드 문제가 해결됐다고 주장하지 않습니다. 아래는 **접속 위치를 보여 주는 설정 참고**이며 정식 Claude Code의 코딩 동작을 검증한 명령이 아닙니다.

```bash
(
  export ANTHROPIC_BASE_URL=http://127.0.0.1:10100
  IFS= read -r -s -p '프록시 접속 키: ' ANTHROPIC_AUTH_TOKEN
  printf '\n'
  export ANTHROPIC_AUTH_TOKEN
  export MAX_THINKING_TOKENS=0
  export CLAUDE_CODE_MAX_OUTPUT_TOKENS=1024
  claude -p --model opencode-cli/deepseek-v4.1-flash-free \
    --tools Read --strict-mcp-config --setting-sources "" \
    --disable-slash-commands --no-session-persistence --max-turns 3 \
    'Read 도구로 작업 폴더의 sample.txt를 읽고 내용을 답하세요.'
)
```

`--tools Read`는 클라이언트에서 읽기 도구만 제공하는 예시입니다. 편집·셸·MCP 권한은 클라이언트에서 별도로 통제하세요. 추가 요청 필드가 400이면 도구를 텍스트로 숨기거나 무시하지 말고 실제 변환 필드를 확인해야 합니다. 비-Claude 모델을 Claude Code에서 사용하는 공식 지원 약속도 아닙니다.

공식 자료: [CLI 옵션](https://code.claude.com/docs/en/cli-reference), [게이트웨이](https://code.claude.com/docs/en/llm-gateway).

## 부록 B. Codex CLI

Codex CLI는 Responses가 필요하므로 별도 프록시를 사용합니다. **일반 Responses 함수 왕복은 실제 검증했지만, Codex CLI 0.153.4 자체의 모든 도구·코딩 동작을 검증한 것은 아닙니다.** custom/freeform·웹 검색 등은 프록시가 지원되는 함수 형태로 변환해야 하며 이 서버가 직접 수용하지 않습니다.

기존 `~/.codex/config.toml`을 덮어쓰지 말고 다음 두 섹션만 병합하세요. 기존 기본 모델은 바꾸지 않습니다.

```toml
[model_providers.ocx-cli-tools]
name = "OpenCodex CLI 함수 중계"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
env_key = "OCX_API_KEY"
requires_openai_auth = false

[profiles.opencode-cli-tools]
model = "opencode-cli/deepseek-v4.1-flash-free"
model_provider = "ocx-cli-tools"
web_search = "disabled"
```

```bash
(
  IFS= read -r -s -p '프록시 접속 키: ' OCX_API_KEY
  printf '\n'
  export OCX_API_KEY
  codex exec --profile opencode-cli-tools --sandbox read-only \
    '작업 폴더의 sample.txt를 읽고 내용만 답하세요.'
)
```

위 명령은 **미검증 설정 예시**입니다. `read-only`는 클라이언트 파일 변경을 제한하는 설정이지 모든 외부 기능을 격리하는 서버 정책이 아닙니다. 허용하지 않는 요청 필드·도구 종류·인자 형식은 명시적 오류로 처리됩니다.

공식 자료: [CLI 옵션](https://developers.openai.com/codex/cli/reference/), [설정](https://developers.openai.com/codex/config-advanced/).

## 부록 C. GJC — 실제 도구 왕복 검증

기존 `~/.gjc/agent/models.yml`의 `providers:`에 아래 항목을 병합하세요. 루트 키를 중복 생성하거나 기존 공급자·역할 바인딩을 덮어쓰지 마세요. `GJC_CODING_AGENT_DIR`을 쓰면 그 디렉터리의 파일이 대상입니다.

```yaml
providers:
  opencode-cli-tools:
    baseUrl: http://127.0.0.1:8940/v1
    apiKeyEnv: GATEWAY_API_KEY
    api: openai-completions
    auth: apiKey
    compat:
      supportsReasoningEffort: false
    models:
      - id: deepseek-v4.1-flash-free
        name: OpenCode CLI 클라이언트 도구 왕복
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 128000
        maxTokens: 8192
```

`apiKeyEnv`는 실제 환경변수 이름 참조입니다. YAML에 토큰 값을 저장하거나 `${...}` 보간을 추측하지 않습니다. 비용·컨텍스트 값은 현재 모델과 클라이언트 설정이며 향후 정책·최대 컨텍스트 실측을 보장하지 않습니다. `reasoning: false`는 별도 추론 제어를 전송하지 않는 설정이지 모델 내부 추론이 없다는 뜻이 아닙니다.

```bash
(
  IFS= read -r GATEWAY_API_KEY < "$GATEWAY_TOKEN_FILE"
  export GATEWAY_API_KEY
  gjc --model opencode-cli-tools/deepseek-v4.1-flash-free \
    --tools read --no-mcp --no-lsp --no-title --no-rules --no-session \
    --thinking off --mode json \
    -p 'read 도구로 작업 폴더의 sample.txt를 읽고 내용을 그대로 답하세요.'
)
```

GJC **0.18.11**에서 임시 파일을 실제로 읽는 도구 호출, `toolUse` 종료, 동일 `toolCallId`의 실제 `toolResult`, 후속 `stop` 답변을 검증했습니다. 직접 연결과 OCI 프록시 경유 모두 성공했습니다. 최종 운영본은 OCI 경유 `--tools read,write`의 다단계 실제 파일 읽기·쓰기도 통과했습니다. 도구는 **GJC 프로세스가 있는 클라이언트**에서 실행됩니다. 텍스트만 필요하면 `--tools read` 대신 `--no-tools`를 쓰세요. `--mode json`은 CLI 출력 형식이지 모델 JSON 강제 기능이 아닙니다.

OCI 프록시를 쓰려면 별도 공급자의 `baseUrl`을 프록시 `/v1`로, 키를 프록시 키로, 모델 ID를 `opencode-cli/deepseek-v4.1-flash-free`로 바꾸세요. 공급자 이름이 `ocx-cli-tools`라면 선택자는 `ocx-cli-tools/opencode-cli/deepseek-v4.1-flash-free`입니다. 출력 한도 8192와 `openai-completions`를 유지하세요.

공식 자료: [Gajae-Code](https://github.com/Yeachan-Heo/gajae-code), [모델·키·호환 설정](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/models.md).

## 상류 문서

- [OpenCode CLI](https://opencode.ai/docs/cli/), [권한](https://opencode.ai/docs/permissions/)
- [고정 CLI 패키지](https://www.npmjs.com/package/opencode-ai/v/1.19.0)
- [MCP](https://modelcontextprotocol.io/)

상류 문서·서비스는 바뀔 수 있습니다. 고정 버전·실제 요청·실제 오류를 기준으로 지원 범위를 판단하세요.
