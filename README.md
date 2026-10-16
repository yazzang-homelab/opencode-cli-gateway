# opencode-cli-gateway

정식 **OpenCode CLI**를 요청마다 한 번 실행해 OpenAI Chat Completions API로 제공합니다. 모델은 `deepseek-v4.1-flash-free`, CLI는 `opencode-ai@1.19.0`으로 고정합니다.

**비공식·독립 프로젝트입니다.** OpenCode·Anthropic·OpenAI·Gajae-Code의 공식 제품이나 완전한 호환성을 주장하지 않습니다. 다른 클라이언트로 위장하는 헤더나 비공개 엔드포인트를 쓰지 않으며, 상류 요청은 고정 CLI가 직접 보냅니다. 무료 모델의 제공 기간·한도·가격·가용성은 상류 정책에 달려 있습니다.

## 동작 방식: 요청 하나 = 모델 단계 하나

```text
클라이언트 ─ Chat Completions(전체 이력) ─▶ 게이트웨이
  게이트웨이: 요청 파일 작성 → 격리된 `opencode run` 1회 실행
  opencode-plugin.mjs (OpenCode 공식 플러그인 훅)
    experimental.chat.system.transform   → 시스템 프롬프트를 호출자 system·developer로 교체
    experimental.chat.messages.transform → 이력을 호출자의 user·assistant·tool_calls·tool 결과로 교체
    tool / tool.definition / chat.message → 함수 목록을 호출자 함수(원래 이름·JSON Schema)로 교체
    chat.params                           → temperature·top_p·max_tokens·stop·seed 등 적용
    event                                 → 텍스트·추론 델타, 함수 호출, 단계 종료를 게이트웨이로 전달
  모델 단계가 끝나면 다음 상류 요청 전에 CLI 프로세스를 종료
클라이언트 ◀─ 텍스트 또는 tool_calls(원래 ID·이름·인자) ─ 게이트웨이
클라이언트가 도구를 실제 실행하고 결과를 이력에 붙여 다음 요청
```

- **게이트웨이는 무상태입니다.** 도구 결과를 기다리며 유지하는 CLI·세션·TTL이 없습니다. 매 요청의 이력이 진실의 원천이므로 요청마다 도구 목록·스키마가 바뀌어도, 이력을 압축·편집해도, 게이트웨이를 재시작해도, 다른 인스턴스로 라우팅해도 동작합니다.
- **도구 실행은 클라이언트 소유입니다.** 플러그인 도구는 모델이 낸 호출을 보고만 하며, 결과가 모델로 다시 가기 전에 프로세스가 끝납니다. 게이트웨이 호스트는 파일 읽기·쓰기·셸을 실행하지 않습니다.
- **OpenCode 자체 프롬프트가 섞이지 않습니다.** 모의 상류로 실제 전송 본문을 캡처해 확인했습니다. `messages`는 호출자 system과 원래 역할 순서의 대화·`tool_calls`·`tool` 결과뿐이고, `tools`는 호출자 함수의 원래 이름·설명·스키마입니다. 예외는 아래 상류 제한 때문에 남기는 OpenCode `read` 정의 하나입니다. OpenCode 에이전트 지시와 환경 블록(작업 경로·날짜)은 전송되지 않습니다.
- `tool_choice: "required"`와 특정 함수 강제는 상류 `tool_choice: "required"`로 전송합니다. 함수 강제는 해당 함수만 선언합니다. 텍스트만 반환하면 성공으로 위장하지 않고 502로 실패합니다.
- 상류가 출력 전에 재시도하면 그대로 이어집니다. 일부 출력을 이미 보낸 뒤 같은 단계를 재시도하면, 중복 출력을 피하려고 실패 처리합니다.

### 상류 제한과 OpenCode `read` 도구

OpenCode 무료 상류는 고정 CLI로 보낸 요청이라도 **함수 목록에 `read`가 없으면** 403 `FreeTierError`("free tier can only be used from within OpenCode")를 반환합니다. 실측 결과는 다음과 같습니다.

| 함수 목록                                                        | 결과 |
| ---------------------------------------------------------------- | ---- |
| `read` 포함(단독·다른 함수와 함께)                               | 성공 |
| `lookup`, `write`, `bash`, `generate_image` 단독, 또는 함수 없음 | 403  |

정식 OpenCode 클라이언트는 항상 자기 `read` 도구를 보냅니다. 이 게이트웨이도 같은 방식을 씁니다. **호출자 함수에 `read`가 없으면 OpenCode 자체의 `read` 도구 정의를 함께 보냅니다.** 가짜 함수를 새로 만들지 않고, 그 외 OpenCode 기본 도구는 모두 숨깁니다.

- 모델이 OpenCode `read`를 호출하면 비대화형 CLI가 권한을 거절합니다. 모델은 같은 실행에서 이어서 답하거나 호출자 함수를 부릅니다. 이 호출은 클라이언트에 전달되지 않습니다.
- 호출자 함수에 `read`가 있으면 그 정의가 OpenCode `read`를 대체하므로, 상류에는 호출자 함수만 전송됩니다.
- OpenCode `read` 정의 때문에 프롬프트가 수백 토큰 늘어납니다. 거절 단계를 포함해 최대 4단계 안에 끝나지 않으면 502입니다.
- GJC에 이미지 역할만 설정된 경우처럼, `--no-tools`여도 `generate_image` 하나만 보내는 클라이언트를 이 방식으로 처리합니다.

## 지원 범위

| 항목      | 지원과 제한                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API       | `POST /v1/chat/completions`, `GET /v1/models`: Bearer 인증. `GET /healthz`: 인증 없음, 상류 검사 아님                                                                                                  |
| 메시지    | 앞부분의 `system`·`developer`(합쳐서 시스템 프롬프트), `user`, `assistant`(`tool_calls`, `reasoning_content`), `tool`                                                                                  |
| 입력 형식 | 텍스트 문자열·텍스트 파트. **사용자 이미지**: PNG·JPEG·GIF·WebP base64 data URL(원격 URL은 미지원)                                                                                                     |
| 함수      | OpenAI `type: function` 최대 512개(한도는 사실상 모델 컨텍스트), 이름 1~64자, 설명 32768자, object 루트 JSON Schema 64KiB. 스키마는 변형 없이 상류로 전달. 한 응답의 호출은 최대 64개                  |
| 도구 선택 | `auto`, `none`, `required`, 특정 함수 강제                                                                                                                                                             |
| 병렬 호출 | 한 단계의 호출을 모두 반환. `parallel_tool_calls`는 상류로 전달하고, `false`일 때는 첫 호출만 반환                                                                                                     |
| 생성 옵션 | `temperature`, `top_p`, `max_tokens`/`max_completion_tokens`(1~32000, 기본 1024), `stop`, `seed`, `frequency_penalty`, `presence_penalty`, `reasoning_effort`(low·high·max), `response_format`, `user` |
| SSE       | 상류 토큰 델타를 즉시 전달. `content`와 `reasoning_content`를 구분                                                                                                                                     |
| 응답      | `reasoning_content`, `tool_calls`, 실제 상류 `usage`(캐시·추론 토큰 포함)                                                                                                                              |
| 미지원    | 오디오·파일 입력, 도구 결과 이미지, legacy `function` 역할, custom/freeform 도구, `n>1`, `logprobs`, `store: true`                                                                                     |
| 프로토콜  | Responses·Messages는 직접 제공하지 않음. 별도 프로토콜 프록시 필요                                                                                                                                     |

함수 정의는 매 요청마다 프롬프트 토큰을 씁니다. MCP 서버가 붙은 GJC의 함수 155개는 약 43K 토큰이었습니다. 실측으로 상류는 함수 310개까지 받았습니다.

JSON Schema의 `format`은 주석입니다. 클라이언트도 자체 인자 검증·권한 정책·실행 격리를 적용해야 합니다.

### 추론 강도(effort)

모델의 기본 단계는 `low`·`high`·`max` 세 가지입니다. `reasoning_effort`로 지정하며, 그 밖의 값은 400입니다. `GET /v1/models`는 `supports_reasoning: true`와 `reasoning_efforts`를 광고합니다.

- 고정 CLI의 AI SDK는 snake_case `reasoning_effort` 옵션을 버리므로, 게이트웨이는 camelCase `reasoningEffort`로 넘깁니다. 모의 상류에서 실제 본문의 `reasoning_effort` 전송을 확인했습니다.
- 지정하지 않으면 상류 기본값을 따릅니다.
- 클라이언트 단계(`minimal`·`medium`·`xhigh` 등)는 프록시나 클라이언트 설정에서 매핑합니다. `register-oci.py`는 OpenCodex에 다음을 등록합니다.
  - 단계 목록: `low`·`high`·`max`
  - 매핑: `minimal→low`, `medium→high`, `xhigh→max`
  - 기본값: `high`
  - 이력의 `reasoning_content` 보존
- 같은 어려운 문제를 직접 호출로 비교한 실측에서 추론 토큰이 약 2.1K(`low`)에서 약 5.7K(`max`)로 늘었습니다. 다른 실행에서는 차이가 거의 없거나 역전되기도 했으므로, 실행 1회 결과로 효과를 판단하지 않습니다.

## 설치와 로컬 실행

Linux, Node.js 20 이상, npm, 상류 네트워크 연결이 필요합니다. 벤치·SSH 등록 스크립트에는 Python 3이 필요하며 추가 Python 패키지는 없습니다. 다른 OS·CLI 버전은 검증하지 않았습니다. 플러그인 훅과 기본 도구 ID는 1.19.0 기준이며, 알 수 없는 네이티브 도구가 나타나면 실패 처리합니다.

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

### 도구 왕복

일반 Chat Completions 규칙과 같습니다. 응답의 assistant 메시지(`tool_calls` 포함)를 이력에 추가하고, 각 호출의 실제 결과를 `{"role":"tool","tool_call_id":...,"content":...}`로 붙여 다시 요청합니다. 다음 요청의 도구 목록·생성 설정은 바뀌어도 됩니다. 이력에서 모든 호출에는 결과가 정확히 한 번 대응해야 하며, 그렇지 않으면 400입니다.

검증 클라이언트는 모델이 `read`를 호출한 **뒤에** 클라이언트에서 무작위 값을 만들어 결과로 돌려주고, 최종 답에 그 값이 들어 있는지 확인합니다. 임의 셸 명령을 실행하는 벤치가 아닙니다.

```bash
python3 benchmark.py --base-url http://127.0.0.1:8940/v1 \
  --api chat --workload tools --key-file "$GATEWAY_TOKEN_FILE" --workers 1 2 4
```

## 환경변수와 자원 상한

| 변수                     | 기본값                                | 의미                                               |
| ------------------------ | ------------------------------------- | -------------------------------------------------- |
| `GATEWAY_TOKEN_FILE`     | 필수                                  | 공백 없는 32자 이상 Bearer 토큰 파일               |
| `GATEWAY_HOST`           | `127.0.0.1`                           | 수신 주소                                          |
| `GATEWAY_PORT`           | `8940`                                | 1~65535                                            |
| `GATEWAY_WORKERS`        | `4`                                   | 동시 CLI 실행 상한, 1~8                            |
| `GATEWAY_TIMEOUT_MS`     | `120000`                              | 요청 하나의 제한, 1000~300000ms                    |
| `GATEWAY_MAX_BODY_BYTES` | `8388608`                             | 요청 본문 상한(전체 이력·이미지 포함), 64KiB~32MiB |
| `GATEWAY_STATE_DIR`      | `/var/lib/opencode-cli-gateway`       | 요청별 임시 작업 디렉터리. 응답 후 삭제            |
| `GATEWAY_CACHE_DIR`      | `/var/cache/opencode-cli-gateway`     | CLI 공용 캐시(모델 목록 등)                        |
| `OPENCODE_EXECUTABLE`    | 프로젝트 `node_modules/.bin/opencode` | 고정 버전 정식 실행 파일                           |

요청마다 CLI를 새로 기동하므로 상류 응답 외에 약 2~3초의 기동 비용이 듭니다. 플러그인 SDK 의존성은 요청 디렉터리에 설치 완료로 선언해, 요청마다 npm에 접속하지 않게 했습니다. 플러그인 이벤트와 CLI 출력은 각각 줄당 4MiB, SSE 송신 버퍼는 1MiB로 제한합니다.

| 상태 | 대표 원인                                                                        |
| ---- | -------------------------------------------------------------------------------- |
| 400  | 잘못된 스키마·이력·미지원 필드·이미지 형식, 중간 위치의 system 메시지            |
| 401  | Bearer 불일치                                                                    |
| 403  | 상류 거절(예: 함수 목록에 `read` 없음)                                           |
| 404  | 잘못된 모델·경로                                                                 |
| 413  | 본문 상한 초과                                                                   |
| 429  | 동시 실행 포화 또는 상류 한도                                                    |
| 502  | 선언되지 않은 함수·잘못된 인자 호출, 필수 호출 누락, 출력 후 재시도, 불완전 응답 |
| 504  | 요청 제한 시간 초과                                                              |

## 보안과 systemd

**공개 인터넷에 평문 HTTP로 노출하지 마세요.** 루프백, SSH 터널, 접근 제한 사설망 또는 인증·접근 제어가 있는 TLS 프록시를 사용하세요. 자체 TLS·사용자별 계정·할당량은 없으며 하나의 공유 토큰을 씁니다.

토큰 파일은 `0600`, 비밀 디렉터리는 `0700`으로 관리하고 curl 추적 로그를 켜지 마세요. 입력·함수 정의·결과는 상류 모델로 전달됩니다. 요청 파일은 처리 중에만 상태 디렉터리에 존재하며, 강제 종료 시에는 남을 수 있습니다. HOME/XDG 분리와 권한 설정은 완전한 OS 샌드박스가 아닙니다. 전용 비특권 서비스와 고정 CLI를 사용하세요.

서비스 예제는 `DynamicUser`, `LoadCredential`, `ProtectHome`, `ProtectSystem`, 프로세스 그룹 정리와 2GiB 메모리 상한을 사용합니다. 아래는 **신규 설치 예시**이며 기존 토큰·설치를 덮어쓰는 업그레이드 절차가 아닙니다.

```bash
sudo install -d -m 0755 /opt/opencode-cli-gateway
sudo install -m 0644 main.mjs server.mjs cli.mjs errors.mjs tools.mjs \
  opencode-plugin.mjs package.json package-lock.json /opt/opencode-cli-gateway/
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

Node 테스트는 HTTP·SSE·이미지·생성 옵션·이력 검증·러너 이벤트 처리·재시도·취소·정리를 검증합니다. 회귀 테스트에는 모델 대신 대체 CLI 프로세스를 사용하므로, 실제 상류 검증과는 구분됩니다.

별도의 실제 모델 검증(고정 CLI 1.19.0, 실제 무료 상류):

- **전송 본문 캡처**: 로컬 모의 상류로 확인했습니다. system은 호출자 문구 하나, messages는 원래 역할 순서, `tool_calls`·`tool` 결과는 네이티브 형식, tools는 호출자 함수만, `tool_choice`·`parallel_tool_calls`·`seed`·`max_tokens`·`temperature`는 그대로 전달됐습니다.
- **시스템 프롬프트 준수**: "ARRR로 시작" 지시를 따랐습니다.
- **기본 기능**: 텍스트 답변(`289`), 이미지 색상 인식(`blue`), 한 단계 병렬 `read` 두 건(원래 ID 보존), 동적 도구 목록 요청에 성공했습니다.
- **GJC 0.18.11 종단 검증**(`--tools read,write`): 클라이언트 전용 무작위 파일을 읽어 다른 파일에 기록했습니다. 두 호출의 ID와 결과가 일치했고 파일 내용도 확인했습니다.
- **GJC 다단계 코딩 작업**(`--tools read,edit,write,bash,find,search`): 테스트 실행 → 버그 2개 수정 → 재실행까지 6회 도구 호출, 30.5초에 성공했습니다. 테스트 파일은 변경되지 않았습니다.
- **동시성 벤치**(워커 1·2·4):

  | 작업                       | 결과    | 비고              |
  | -------------------------- | ------- | ----------------- |
  | 텍스트                     | **7/7** | 4워커 평균 9.36초 |
  | `read` 도구 왕복(HTTP 2회) | **7/7** | 4워커 평균 18.0초 |

  측정 후 활성 워커와 임시 디렉터리는 모두 0이었습니다.

- **클라이언트 중단**: 스트림 도중 연결이 끊긴 뒤 CLI 프로세스와 임시 디렉터리가 남지 않음을 확인했습니다.

소규모 관측이며 장시간 안정성·최대 처리량·다른 장비에서의 성능 보장이 아닙니다. 응답 품질과 지시 준수는 모델 자체의 특성입니다.

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

이 서버는 Chat Completions만 제공합니다. [OpenCodex (`ocx`)](https://github.com/lidge-jun/opencodex) 같은 별도 프록시가 Messages·Responses를 변환할 수 있습니다. 프록시가 함수 이름·호출 ID·인자·결과를 보존해야 합니다. 게이트웨이는 무상태이므로 어느 인스턴스로 라우팅해도 됩니다.

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

이미 등록한 공급자의 모델 메타데이터(effort 단계·매핑·기본값, 컨텍스트, 출력 한도, 이미지 입력)를 바꾸려면 `--update`를 붙입니다. 같은 이름의 공급자를 이 스크립트의 등록 내용으로 덮어쓰며, 기본 공급자는 바꾸지 않습니다. OpenCodex의 공급자 `PATCH`는 effort 필드를 무시하므로 쓰지 않습니다.

루프백은 각 프로세스의 호스트 자신입니다. 다른 호스트는 보호된 연결을 구성하세요. OpenCodex의 설치·Codex 설정 동기화 동작은 [해당 프로젝트 문서](https://opencodex.me/)를 확인하세요. 모델 목록의 표기만으로 이 서버의 제한이 바뀌지 않습니다.

## 부록 A. Claude Code

**참고**: Claude Code의 읽기 함수 이름은 `Read`(대문자)이므로 OpenCode `read` 정의가 함께 전송됩니다. Claude Code 자체는 검증하지 않았습니다.

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

**참고**: Codex CLI는 `read` 함수를 보내지 않으므로 OpenCode `read` 정의가 함께 전송됩니다. Codex CLI 자체는 검증하지 않았습니다.

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
      supportsReasoningEffort: true
      reasoningEffortMap:
        {
          minimal: low,
          low: low,
          medium: high,
          high: high,
          xhigh: max,
          max: max,
        }
    models:
      - id: deepseek-v4.1-flash-free
        name: OpenCode CLI 무상태 단일 단계
        reasoning: true
        thinking:
          mode: effort
          minLevel: low
          maxLevel: max
          levels: [low, high, max]
          defaultLevel: high
        input: [text, image]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 200000
        maxTokens: 8192
```

`apiKeyEnv`는 실제 환경변수 이름 참조입니다. YAML에 토큰 값을 저장하거나 `${...}` 보간을 추측하지 않습니다. 비용·컨텍스트 값은 현재 모델과 클라이언트 설정이며 향후 정책·최대 컨텍스트 실측을 보장하지 않습니다. `thinking.levels`는 모델의 실제 단계와 같아야 합니다. GJC는 모델 ID에 `deepseek`가 들어 있으면 DeepSeek 공식 API 기준 매핑(`low→high`)을 적용하므로, `reasoningEffortMap`을 명시해 `low`를 그대로 보내게 합니다. 목록에 없는 단계는 GJC가 아래 단계로 내립니다(`medium→low`, `xhigh→high`). 실제 GJC로 `minimal·low→low`, `high→high`, `max→max` 전송을 확인했습니다. OCI 경유라면 모델 목록의 `reasoning_efforts`에서 단계를 자동으로 읽으며, 공급자 `compat.supportsReasoningEffort: true`가 필요합니다.

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

GJC **0.18.11**에서 `--tools read,write` 읽기·쓰기 왕복과 `--tools read,edit,write,bash,find,search` 다단계 코딩 작업(테스트 실행·수정·재실행)을 검증했습니다. 도구는 **GJC 프로세스가 있는 클라이언트**에서 실행됩니다. 텍스트만 필요하면 `--tools read` 대신 `--no-tools`를 쓰세요. `--mode json`은 CLI 출력 형식이지 모델 JSON 강제 기능이 아닙니다.

OCI 프록시를 쓰려면 별도 공급자의 `baseUrl`을 프록시 `/v1`로, 키를 프록시 키로, 모델 ID를 `opencode-cli/deepseek-v4.1-flash-free`로 바꾸세요. 공급자 이름이 `ocx-cli-tools`라면 선택자는 `ocx-cli-tools/opencode-cli/deepseek-v4.1-flash-free`입니다. `openai-completions`를 유지하세요. GJC가 `read`를 보내면 그 정의가 그대로 쓰이고, 보내지 않으면 OpenCode `read` 정의가 함께 전송됩니다.

공식 자료: [Gajae-Code](https://github.com/Yeachan-Heo/gajae-code), [모델·키·호환 설정](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/models.md).

## 상류 문서

- [OpenCode CLI](https://opencode.ai/docs/cli/), [권한](https://opencode.ai/docs/permissions/)
- [고정 CLI 패키지](https://www.npmjs.com/package/opencode-ai/v/1.19.0)
- [플러그인](https://opencode.ai/docs/plugins/)

상류 문서·서비스는 바뀔 수 있습니다. 고정 버전·실제 요청·실제 오류를 기준으로 지원 범위를 판단하세요.
