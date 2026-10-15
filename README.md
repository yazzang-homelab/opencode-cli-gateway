# opencode-cli-gateway

정식 **OpenCode CLI를 자식 프로세스로 실행**하고, 그 텍스트 응답을 OpenAI Chat Completions 형태로 중계하는 작은 HTTP 서버입니다. 제공 모델은 `deepseek-v4.1-flash-free` 하나이며, CLI 의존성은 `opencode-ai@1.19.0`으로 고정합니다.

**비공식·독립 프로젝트입니다.** OpenCode, Anthropic, OpenAI, Gajae-Code의 공식 게이트웨이가 아니며, 해당 프로젝트의 후원·인증·완전한 호환성을 주장하지 않습니다. 여기서 “정식 CLI”란 사용하는 상류 실행 파일을 뜻하며, 이 게이트웨이가 공식 제품이라는 뜻이 아닙니다.

## 구조와 사용 범위

```text
텍스트 API 클라이언트
  → 이 게이트웨이: POST /v1/chat/completions
  → 정식 opencode-ai@1.19.0: opencode run --pure --agent build --format json
  → OpenCode 공급자의 deepseek-v4.1-flash-free
```

- 상류 HTTP API를 재구현하거나 다른 클라이언트인 것처럼 헤더를 위장하지 않습니다.
- 요청마다 CLI 프로세스와 작업 디렉터리를 만들고, 종료 시 작업 디렉터리를 삭제합니다. `HOME`과 설정·데이터·상태용 XDG 디렉터리를 요청별로 분리하며, 캐시 디렉터리는 공유합니다.
- 네이티브 에이전트의 도구 권한은 `ask`로 설정합니다. 고정 버전의 비대화형 실행에서 실제 Bash 도구 요청이 자동 거절되는 것을 확인했습니다. CLI가 `tool_use` 이벤트를 내보내면 게이트웨이도 오류로 종료합니다. 도구 실행을 제공하는 서비스가 아닙니다.
- `system`·`developer` 메시지는 **네이티브 에이전트에게 전달하는 대화 기록**입니다. CLI 자체의 시스템 지시를 교체하거나, 원래 API의 역할 우선순위를 그대로 구현하지 않습니다.
- 무료 모델의 현재 제공 여부·한도·정책은 상류에 달려 있습니다. 무료라는 이름이나 과거 성공 기록은 향후 가용성·가격·성능의 보장이 아닙니다.

파일 수정, 셸 실행, MCP, 외부 함수 호출이 필요한 일반 코딩 에이전트의 백엔드로는 사용할 수 없습니다. 이미 주어진 텍스트에 대한 질문·요약·생성에 맞춘 중계기입니다.

## 지원·미지원

| 항목                        | 상태와 정확한 범위                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions` | Bearer 인증이 필요한 텍스트 전용 API                                                                                                |
| `GET /v1/models`            | Bearer 인증 필요. 정확한 모델 ID와 `supports_tool_use: false`, `supports_vision: false` 제공                                        |
| `GET /healthz`              | 인증 없이 프로세스 상태와 `active`, `maxWorkers` 반환. 상류 모델의 정상 동작을 검사하지 않음                                        |
| 입력 역할                   | `system`, `developer`, `user`, `assistant`. 위의 대화 기록 의미에 한정                                                              |
| 입력 내용                   | 문자열 또는 `text`·`input_text`·`output_text` 타입의 텍스트 파트 배열                                                               |
| 비스트리밍                  | `choices[0].message.content`에 응답 텍스트 제공                                                                                     |
| SSE                         | `stream: true`, 선택적으로 `stream_options.include_usage: true`. **완성된 CLI 텍스트 파트 단위**이며 모델 토큰별 실시간 전송이 아님 |
| 출력 한도                   | `max_tokens` 또는 `max_completion_tokens`: 1~8192, 생략 시 1024. 둘 다 보내면 값이 같아야 함                                        |
| 샘플링                      | `temperature`: 0~2, `top_p`: 0~1. CLI 에이전트 설정으로 전달                                                                        |
| 사용량                      | CLI의 사용량을 변환. 추론·캐시 토큰도 CLI 보고 범위에서 합산                                                                        |
| 외부 함수 도구              | 비어 있지 않은 `tools`는 **400**. `tool_calls`, 도구 결과 메시지, `tool` 역할도 미지원                                              |
| 도구 관련 빈 설정           | `tools: []`, `tool_choice: "none"` 또는 `"auto"`, `parallel_tool_calls: false`는 허용하지만 도구 기능을 제공하지는 않음             |
| 이미지·오디오·동영상        | 입력·출력 모두 미지원. 비텍스트 콘텐츠는 400                                                                                        |
| JSON 강제·구조화 출력       | `response_format`·JSON Schema 미지원. 프롬프트로 JSON을 요청할 수 있으나 형식을 보장하지 않음                                       |
| 응답 저장                   | 저장 기능은 미지원. `store: false`만 수용하며 `true`·문자열·`null`은 400. 이 옵션은 CLI 상태·캐시의 무기록을 보장하지 않음          |
| 그 밖의 요청 필드           | 허용 목록에 없는 필드는 400. 예: `stop`, `seed`, `reasoning_effort`, `metadata`                                                     |
| 복수 후보                   | `n: 1`만 허용                                                                                                                       |
| Responses·Messages API      | `/v1/responses`, `/v1/messages`를 직접 제공하지 않음. 별도 프로토콜 프록시 필요                                                     |

**“도구를 쓰지 말라”는 프롬프트만으로는 충분하지 않습니다.** 클라이언트가 비어 있지 않은 `tools`를 선언하면 실제 호출 여부와 무관하게 400입니다. `tool_choice: "none"`도 이 선언을 허용하게 만들지 않습니다.

## 요구 사항과 설치

- Linux, Node.js **20 이상**, npm
- 실행 환경에 맞는 정식 네이티브 OpenCode CLI. `npm install`로 고정 의존성 **`opencode-ai@1.19.0`**을 설치합니다.
- 상류 OpenCode 서비스로 나갈 수 있는 네트워크
- 아래 예시는 Bash와 curl 사용. 선택 기능인 벤치·원격 등록에는 Python 3, 원격 등록에는 SSH도 필요합니다. Python 추가 패키지는 필요하지 않습니다.
- macOS·Windows 실행이나 다른 OpenCode 버전과의 호환성은 검증하지 않았습니다.

```bash
git clone https://github.com/yazzang-homelab/opencode-cli-gateway.git
cd opencode-cli-gateway
npm install
```

`package.json`과 잠금 파일의 CLI 버전을 임의로 올리지 마세요. 이 구현은 해당 버전의 JSON 이벤트와 비대화형 권한 동작에 의존합니다.

## 로컬 실행

저장소 루트에서 실행합니다. 일반 사용자 실행에서는 반드시 **사용자가 쓸 수 있는 상태·캐시 디렉터리**를 지정합니다. 코드의 `/var/lib`·`/var/cache` 기본값은 뒤의 systemd 배포용입니다.

```bash
umask 077
export GATEWAY_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-cli-gateway"
export GATEWAY_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/opencode-cli-gateway"
mkdir -p "$GATEWAY_STATE_DIR" "$GATEWAY_CACHE_DIR"
chmod 700 "$GATEWAY_STATE_DIR" "$GATEWAY_CACHE_DIR"
export GATEWAY_TOKEN_FILE="$GATEWAY_STATE_DIR/token"

# 기존 토큰은 유지합니다. 새 토큰은 32바이트 난수의 64자리 16진수이며 화면에 출력하지 않습니다.
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

토큰을 소스 코드, 셸 명령의 문자열 리터럴, 저장소 설정 파일에 넣지 마세요. 서버는 토큰 값이 아니라 `GATEWAY_TOKEN_FILE`의 경로만 받습니다. 클라이언트에 토큰을 옮길 때는 보안 비밀 저장소나 별도의 안전한 전달 경로를 사용하세요.

### 환경변수

| 변수                  | 기본값                                  | 의미                                                                                                          |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GATEWAY_TOKEN_FILE`  | 필수                                    | Bearer 토큰 파일. 앞뒤 공백 제거 후 32자 이상이며 내부 공백이 없어야 함. 운영자가 파일 권한을 `0600`으로 설정 |
| `GATEWAY_HOST`        | `127.0.0.1`                             | 수신 주소. 로컬 사용에서는 변경하지 않는 것을 권장                                                            |
| `GATEWAY_PORT`        | `8940`                                  | 포트, 1~65535                                                                                                 |
| `GATEWAY_WORKERS`     | `4`                                     | 동시 CLI 실행 수, 1~8. 초과 요청은 대기열 없이 429                                                            |
| `GATEWAY_TIMEOUT_MS`  | `120000`                                | 요청 전체 제한 시간, 1000~300000밀리초                                                                        |
| `GATEWAY_STATE_DIR`   | `/var/lib/opencode-cli-gateway`         | 요청별 임시 작업 공간의 상위 디렉터리. 일반 사용자 실행은 위 예시처럼 홈 아래 경로로 변경                     |
| `GATEWAY_CACHE_DIR`   | `/var/cache/opencode-cli-gateway`       | CLI 공용 캐시. 일반 사용자 실행은 쓰기 가능한 홈 캐시로 변경                                                  |
| `OPENCODE_EXECUTABLE` | 프로젝트의 `node_modules/.bin/opencode` | 실행 가능한 정식 CLI 경로. 별도 경로도 검증한 1.19.0 사용                                                     |

아래 예시의 `GATEWAY_API_KEY`는 **클라이언트·벤치용 환경변수**입니다. 서버의 필수 설정 `GATEWAY_TOKEN_FILE`을 대신하지 않습니다.

## API 사용 예시

다른 터미널에서 같은 사용자의 토큰 파일을 읽습니다. 값은 출력하지 않습니다.

```bash
export GATEWAY_TOKEN_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-cli-gateway/token"
IFS= read -r GATEWAY_API_KEY < "$GATEWAY_TOKEN_FILE"
export GATEWAY_API_KEY
export GATEWAY_BASE_URL=http://127.0.0.1:8940/v1

curl --fail-with-body --silent --show-error http://127.0.0.1:8940/healthz

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  "$GATEWAY_BASE_URL/models"
```

### 텍스트 응답

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  "$GATEWAY_BASE_URL/chat/completions" \
  --data-binary '{
    "model": "deepseek-v4.1-flash-free",
    "messages": [{"role": "user", "content": "17의 제곱을 숫자로만 답하세요."}],
    "max_tokens": 128,
    "stream": false
  }'
```

### SSE와 사용량

```bash
curl --fail-with-body --silent --show-error --no-buffer \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  "$GATEWAY_BASE_URL/chat/completions" \
  --data-binary '{
    "model": "deepseek-v4.1-flash-free",
    "messages": [{"role": "user", "content": "HTTP를 두 문장으로 설명하세요."}],
    "max_tokens": 256,
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

SSE는 `data:` 프레임과 마지막 `[DONE]`을 사용합니다. 최초 텍스트가 나오기까지 CLI 시작과 파트 생성 시간이 걸립니다. 스트림 시작 후 실패하면 이미 전송한 HTTP 상태를 바꿀 수 없으므로, 클라이언트는 SSE의 `error`도 확인해야 합니다.

### 주요 오류와 상한

| 상태 | 확인할 내용                                                                               |
| ---- | ----------------------------------------------------------------------------------------- |
| 400  | 비어 있지 않은 `tools`, 이미지, 지원하지 않는 필드·역할·파라미터 범위                     |
| 401  | Bearer 인증 누락·불일치. 상류 인증 오류도 전달될 수 있음                                  |
| 403  | 네이티브 도구 이벤트 거절 또는 상류의 접근 거절                                           |
| 404  | 잘못된 모델 ID 또는 제공하지 않는 API 경로                                                |
| 413  | 요청 본문 1MiB 상한 초과                                                                  |
| 429  | 워커 초과 시 `workers_busy`, `Retry-After: 1`. 상류 제한일 수도 있으므로 오류 코드도 확인 |
| 502  | CLI 시작·출력·상류 처리 오류. 불완전 응답을 가짜 성공으로 대체하지 않음                   |
| 504  | 요청 시간 초과                                                                            |

CLI 표준출력은 요청당 2MiB, 단일 SSE 텍스트 파트와 대기 버퍼는 1MiB 상한을 둡니다. 연결 종료·시간 초과 시 자식 프로세스 그룹을 종료하고 요청별 디렉터리를 정리합니다.

## 보안과 systemd 배포

### 반드시 지킬 사항

- **공개 인터넷에 평문 HTTP로 절대 노출하지 마세요.** 기본 루프백 바인딩을 유지하세요. 원격 접속은 SSH 터널, 접근이 제한된 사설망, 또는 인증·접근 제어를 갖춘 TLS 역방향 프록시를 사용하세요.
- 서버 자체에는 TLS, 사용자별 계정·할당량, 상세 접근 제어가 없습니다. 하나의 공유 Bearer 토큰이므로 토큰 보유자는 텍스트 요청을 보낼 수 있습니다.
- 토큰 파일은 `0600`, 상위 비밀 디렉터리는 `0700`으로 관리하세요. 토큰을 출력하거나 커밋하지 말고, curl의 `--verbose`·추적 로그로 인증 헤더가 노출되지 않도록 하세요.
- 입력은 상류 OpenCode 서비스를 거쳐 처리됩니다. 로컬 서버라고 해서 오프라인 추론이나 비밀 데이터의 로컬 보관을 보장하지 않습니다.
- 요청별 `HOME` 분리와 CLI의 권한 정책은 OS 수준 샌드박스와 같지 않습니다. 정식 CLI·고정 버전·상류를 신뢰할 수 있는 환경에서 전용 비특권 서비스로 실행하세요.
- 정상 종료 경로에서는 요청 디렉터리를 지우지만, 강제 종료·전원 장애 뒤에는 흔적이 남을 수 있습니다. 상태·공용 캐시 디렉터리는 민감 데이터로 취급하세요.

### 서비스 설치 예시

[`opencode-cli-gateway.service`](./opencode-cli-gateway.service)는 다음을 전제로 합니다.

- 표준 설치 위치 `/opt/opencode-cli-gateway`, Node.js 실행 파일 `/usr/bin/node`
- `GATEWAY_HOST=127.0.0.1`, 포트 8940
- `DynamicUser=yes`, `StateDirectory`·`CacheDirectory`, `UMask=0077`
- `LoadCredential`로 `/etc/opencode-cli-gateway/token`을 서비스에 전달
- `ProtectSystem=strict`, `ProtectHome=yes`, `NoNewPrivileges=yes` 등 방어 설정
- `After=network-online.target`. 특정 VPN이나 운영 호스트에 종속되지 않음

아래는 **신규 설치 예시**입니다. 기존 설치·토큰·서비스 파일을 덮어쓰는 업그레이드 절차가 아닙니다. 저장소에서 `npm install`을 마친 뒤, 실행 중인 서버와 별개로 필요한 런타임 파일만 배치합니다. 토큰은 앞의 로컬 실행 단계에서 생성한 파일을 사용합니다.

```bash
sudo install -d -m 0755 /opt/opencode-cli-gateway
sudo install -m 0644 main.mjs server.mjs cli.mjs errors.mjs package.json package-lock.json \
  /opt/opencode-cli-gateway/
sudo cp -R node_modules /opt/opencode-cli-gateway/
sudo install -d -m 0700 /etc/opencode-cli-gateway
sudo install -m 0600 "$GATEWAY_TOKEN_FILE" /etc/opencode-cli-gateway/token
sudo install -m 0644 opencode-cli-gateway.service /etc/systemd/system/opencode-cli-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-cli-gateway.service
curl --fail-with-body --silent --show-error http://127.0.0.1:8940/healthz
```

로컬 서버가 이미 8940을 사용 중이면 먼저 정상 종료하세요. 서비스 사용자는 설치 디렉터리와 `node_modules`를 읽고 CLI를 실행할 수 있어야 합니다. `/usr/bin/node`가 Node.js 20 이상인지, 배포판의 systemd가 예제의 자격증명·격리 지시문을 지원하는지도 확인하세요. 건강 상태 확인만으로 상류 생성 성공을 판정하지 말고 인증된 Chat 요청도 보내세요.

## 테스트와 작은 벤치마크

### 자동 테스트

```bash
npm test
python3 -m unittest -v test_public_scripts.py
```

Node.js 내장 테스트 러너를 사용합니다. HTTP 검증·인증·SSE·동시성·연결 종료·시간 초과와 CLI 이벤트 처리·권한 설정·작업 공간 정리를 검사합니다. CLI 테스트에는 대체 자식 프로세스를 사용하므로, 이 테스트가 통과해도 실제 무료 모델의 가용성이나 특정 클라이언트의 호환성을 입증하지는 않습니다. 공개 준비 과정에서 `store: false` 수용과 `true`·문자열·`null` 거절 회귀 검증을 포함해 **27개 통과**를 확인했습니다.

Python 표준 라이브러리 `unittest` 테스트도 **6개 통과**를 확인했습니다. URL·워커 범위 검증, 등록 토큰의 프로세스 인자·출력 비노출, 비루프백 관리 API 거절, Chat·Responses SSE 벤치 처리, 응답 텍스트 이후의 스트림 오류를 실패로 판정하는 동작을 검사합니다. 로컬 대체 HTTP 서버와 모의 SSH 호출을 사용하므로 실제 원격 등록이나 상류 생성의 성공을 입증하지는 않습니다.

### 직접 재측정

`benchmark.py`는 Python 표준 라이브러리만 사용합니다. 각 요청의 난수 `nonce`와 1~16의 제곱 배열을 JSON으로 생성하게 하고, 내용과 완료 이벤트를 검사합니다. 자동 클라이언트 재시도는 하지 않습니다.

```bash
python3 benchmark.py \
  --base-url http://127.0.0.1:8940/v1 \
  --api chat \
  --model deepseek-v4.1-flash-free \
  --key-file "$GATEWAY_TOKEN_FILE" \
  --workers 1 2 4
```

`--key-file` 대신 `GATEWAY_API_KEY`를 환경변수로 전달해도 됩니다. 기본값은 위의 주소·`chat`·모델·워커 배열입니다. 각 배치는 지정한 동시 요청 수만큼 한 번씩 실행됩니다. `--api responses`는 **별도 Responses 프록시의 `/v1` 주소와 그 프록시의 모델 ID·접속 키**를 지정할 때만 사용하세요. 게이트웨이 8940에서 직접 실행하면 404입니다. 결과에는 응답 본문이 포함되므로 공개 전 내용을 검토하세요.

### 관측 결과와 한계

2026-10-15에 기록한 별도 Responses 프록시 → 게이트웨이 Chat Completions → 정식 CLI 경로의 작은 측정입니다. 외부 도구 선언 없는 텍스트 요청을 사용했습니다.

| 동시 요청    | 요청 수 | 내용 검증 성공 | 요청 평균 | 배치 전체 |
| ------------ | ------- | -------------- | --------- | --------- |
| 1            | 1       | 1              | 4.920초   | 4.932초   |
| 2            | 2       | 2              | 6.459초   | 7.060초   |
| 4            | 4       | 4              | 8.546초   | 8.767초   |
| 4, 추가 배치 | 4       | 4              | 11.022초  | 16.058초  |

합계 **11/11 성공**입니다. 별도 점검에서 잘못된 토큰 401, 외부 도구 선언 400, 네 워커 사용 중 다섯 번째 요청 429, 연결 종료 후 워커·요청 디렉터리 정리도 관측했습니다. 반면 초기 점검에서는 상류 오류가 502로 전달된 사례도 있었습니다.

이 수치는 장시간 안정성·최대 처리량·동일 성능의 재현을 보장하지 않습니다. 다른 장비·네트워크·상류 혼잡에서는 달라집니다. 특히 **Responses API 텍스트 요청 성공은 공식 Codex CLI의 코딩 모드 성공이 아닙니다.** 개인 운영정보가 들어 있는 원본 측정 파일은 공개 저장소에 포함하지 않습니다.

## 부록 공통: 직접 연결과 프로토콜 프록시

| 클라이언트        | 필요한 프로토콜                | 8940 직접 연결               | 이 문서의 상태                                                                                      |
| ----------------- | ------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| Claude Code       | Anthropic Messages             | 불가                         | 별도 프록시 경유 텍스트 실호출에서 400 `unsupported_parameter` 관측. 호환 성공 아님                 |
| Codex CLI         | OpenAI Responses               | 불가                         | 별도 프록시가 있어도 기본 외부 도구 선언 때문에 일반 코딩 모드 미지원                               |
| GJC 사용자 공급자 | `openai-completions` 선택 가능 | 도구 없는 텍스트 원샷 실검증 | 0.18.11과 격리 설정에서 응답 본문 `{"gjc_text":true}`, 완료 이유 `stop` 확인. 코딩 모드 검증은 아님 |

여기서 확인한 CLI 도움말 버전은 Claude Code **2.1.292**, Codex CLI **0.153.4**, GJC **0.18.11**입니다. 도움말 확인과 엔드투엔드 성공은 구분합니다. 버전이 바뀌면 요청 필드와 도구 선언을 다시 확인하세요.

### 별도 OpenCodex 프록시를 사용하는 경우

[OpenCodex (`ocx`)](https://github.com/lidge-jun/opencodex)는 별도 프로젝트입니다. Messages·Responses를 Chat Completions로 변환하는 계층으로 사용할 수 있지만, **이 게이트웨이에 도구 실행 기능을 추가해 주지는 않습니다.** 설치·실행·인증은 [OpenCodex 공식 문서](https://opencodex.me/)를 따르세요. OpenCodex의 시작·동기화 작업은 기존 Codex 설정을 변경할 수 있으므로 해당 문서와 적용 대상을 먼저 확인하세요.

프록시 대시보드에 새 사용자 공급자를 등록할 때의 배치는 다음과 같습니다. 기존 공급자나 기본 모델을 대체하지 마세요.

| 위치                              | 설정                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| 프록시의 새 공급자 이름           | 예: `opencode-cli`                                                                       |
| 상류 어댑터                       | `openai-chat`                                                                            |
| 상류 기본 URL                     | 프록시와 게이트웨이가 같은 호스트라면 `http://127.0.0.1:8940/v1`                         |
| 상류 인증                         | `key` 모드. **게이트웨이 토큰**은 프록시의 이 공급자 자격증명 위치에 배치                |
| 상류 모델                         | 정확히 `deepseek-v4.1-flash-free`                                                        |
| 클라이언트가 선택하는 프록시 모델 | `opencode-cli/deepseek-v4.1-flash-free`                                                  |
| Claude Code용 프록시 기본 URL     | `http://127.0.0.1:10100` → `/v1/messages`                                                |
| Codex용 프록시 기본 URL           | `http://127.0.0.1:10100/v1` → `/responses`                                               |
| 클라이언트 인증                   | **프록시가 발급·허용한 접속 키**. 게이트웨이 토큰이나 프록시 관리자 토큰과 혼동하지 않음 |

프록시의 모델 입력은 텍스트 전용, 출력 한도는 최대 8192로 맞추세요. 프록시 목록이 도구·이미지 지원을 과대 표시하더라도 실제 게이트웨이의 지원 범위는 바뀌지 않습니다. 주소의 `127.0.0.1`은 **각 프로세스가 실행되는 호스트 자신**입니다. 서로 다른 호스트라면 보호된 연결을 마련해야 하며 공개 평문 URL로 대체해서는 안 됩니다.

선택적으로 `register-oci.py`를 사용하면 SSH 안에서 인증된 OpenCodex 관리 API에 새 공급자를 등록합니다. 특정 클라우드에 종속된 도구는 아니며, 기존 이름의 공급자는 덮어쓰지 않고 기본 모델도 바꾸지 않습니다.

```bash
read -r -p '관리 호스트 SSH 별칭: ' HOST
python3 register-oci.py \
  --ssh-host "$HOST" \
  --gateway-base-url http://127.0.0.1:8940/v1 \
  --token-file "$GATEWAY_TOKEN_FILE" \
  --name opencode-cli
```

이 주소 예시는 **SSH 대상 호스트에서** 게이트웨이 8940에 접근 가능한 경우입니다. `--ssh-host`와 `--gateway-base-url`은 필수입니다. 로컬 `--token-file` 기본값은 `/etc/opencode-cli-gateway/token`, 원격 `--admin-token-file` 기본값은 `~/.opencodex/admin-api-token`, 원격 `--management-url` 기본값은 `http://127.0.0.1:10101`입니다. 관리 URL은 SSH 대상의 루프백만 허용합니다. 이 스크립트는 인증된 관리 API에 실제 설정을 저장하므로 실행 전 대상과 이름을 확인하세요. 관리자 토큰은 원격에서 읽고, 로컬 게이트웨이 토큰은 SSH 표준입력으로 전달하며 값은 출력하지 않습니다.

## 부록 A. Claude Code

### 직접 연결 불가, 텍스트 전용 시도도 현재 실패

Claude Code는 Anthropic Messages 프로토콜을 사용합니다. `ANTHROPIC_BASE_URL=http://127.0.0.1:8940`으로 지정해도 `/v1/messages`가 없어서 동작하지 않습니다. 앞 절처럼 **별도 Messages → Chat Completions 프록시**가 먼저 필요합니다. Anthropic은 게이트웨이를 통한 비-Claude 모델 사용을 공식 지원하지 않으므로 아래는 독립적인 구성 참고이지 공식 호환 약속이 아닙니다.

**관측한 결과는 실패입니다.** 2.1.292를 격리된 설정 디렉터리에서 실행하고, OpenCodex의 `/v1/messages`에 `--tools ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--setting-sources ""`, `--no-session-persistence`, `--max-turns 1`과 위 프록시 모델을 지정했지만 **400 `unsupported_parameter`**가 발생했습니다. `MAX_THINKING_TOKENS=0`과 `CLAUDE_CODE_MAX_OUTPUT_TOKENS=1024`를 추가해도 동일했고, 게이트웨이가 `store: false`를 수용하도록 수정한 뒤에도 실패했습니다. 이 관측만으로 거절된 정확한 변환 필드를 확정하지는 못했으며, 도구 선언 제거만으로 연결이 성립한다고 볼 수 없습니다.

2.1.292의 `--help`에서 `--tools ""`의 모든 기본 도구 해제, `--strict-mcp-config`, `--mcp-config`, `--disable-slash-commands`는 확인했습니다. 아래는 기본 도구와 MCP를 제외하는 **접속 설정 참고일 뿐, 성공한 사용법이 아닙니다.** 추가 옵션이 포함된 아래 조합 자체도 미검증입니다.

```bash
(
  export ANTHROPIC_BASE_URL=http://127.0.0.1:10100
  IFS= read -r -s -p '별도 프록시 접속 키: ' ANTHROPIC_AUTH_TOKEN
  printf '\n'
  export ANTHROPIC_AUTH_TOKEN
  export ENABLE_TOOL_SEARCH=false
  export MAX_THINKING_TOKENS=0
  export CLAUDE_CODE_MAX_OUTPUT_TOKENS=1024

  claude -p \
    --model opencode-cli/deepseek-v4.1-flash-free \
    --tools "" \
    --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
    --setting-sources "" --disable-slash-commands --no-chrome \
    --no-session-persistence --max-turns 1 \
    --system-prompt '파일 접근과 도구 실행 없이 한국어 텍스트로만 답하세요.' \
    '17의 제곱을 숫자로만 답하세요.'
)
```

기존 관리 설정·플러그인·클라이언트 버전, 프록시의 변환에 따라 추가 필드나 도구가 남을 수 있습니다. 실제 상류 요청이 지원 필드만 사용하는지 확인해야 합니다. 비어 있지 않은 `tools`가 도착하면 400이며, 이미지·파일 첨부·Bash·편집·검색을 쓰는 **일반 코딩 모드는 미지원**입니다. `--allowedTools`나 권한 거절만으로 선언 자체가 사라진다고 가정하지 마세요.

공식 자료: [Claude Code CLI 옵션](https://code.claude.com/docs/en/cli-reference), [게이트웨이 연결·인증 위치](https://code.claude.com/docs/en/llm-gateway-connect), [게이트웨이 지원 범위](https://code.claude.com/docs/en/llm-gateway), [OpenCodex의 Claude Code 안내](https://opencodex.me/guides/claude-code/).

## 부록 B. Codex CLI

### 직접 연결 불가, 현재 일반 코딩 모드 미지원

Codex CLI는 Responses 프로토콜을 사용합니다. 게이트웨이 8940의 `/v1/responses`는 404이므로 **별도 Responses → Chat Completions 프록시**가 필요합니다. 하지만 프로토콜 변환만으로 코딩 모드가 지원되지는 않습니다. Codex는 기본적으로 외부 도구를 선언하며, 이를 프록시가 그대로 전달하면 게이트웨이에서 400입니다.

0.153.4의 도움말에서는 `--no-tools` 같은 전체 도구 선언 해제 옵션을 확인하지 못했습니다. `--sandbox read-only`, 승인 설정, MCP 비활성화, 웹 검색 끄기는 **모든 도구 선언 제거와 다릅니다.** 공식 CLI에서 도구를 완전히 빼는 경로를 검증하기 전에는 텍스트 원샷 성공도 주장하지 않습니다.

### 접속 위치를 보여 주는 설정 참고

다음은 실행 성공이 확인된 사용법이 아니라 **프록시 URL·모델·키의 배치 예시**입니다. 기존 `~/.codex/config.toml`을 덮어쓰지 말고 아래 두 섹션만 병합합니다. 같은 이름의 섹션이 이미 있으면 중복 생성하지 말고 해당 항목을 검토해 병합하세요. 루트의 `model`·`model_provider`·기본 프로필 등 기존 기본값은 변경하지 않습니다.

```toml
[model_providers.ocx-cli-text]
name = "OpenCodex CLI 텍스트 중계"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
env_key = "OCX_API_KEY"
requires_openai_auth = false

[profiles.opencode-cli-text]
model = "opencode-cli/deepseek-v4.1-flash-free"
model_provider = "ocx-cli-text"
web_search = "disabled" # 검색만 끄며 전체 도구를 제거하지 않음
```

아래 `--profile opencode-cli-text`는 위 `[profiles.opencode-cli-text]`를 선택합니다. 별도 이름의 TOML 파일을 자동으로 읽는다고 가정하지 않습니다. 설정을 올바르게 병합해도 기본 외부 도구 선언에 따른 400 문제는 해결되지 않으며, 현재 지원되는 코딩 경로가 아닙니다.

```bash
(
  IFS= read -r -s -p '별도 프록시 접속 키: ' OCX_API_KEY
  printf '\n'
  export OCX_API_KEY
  # 구성 점검용일 뿐입니다. 현재 도구 선언으로 400이 발생할 수 있는 미지원 경로입니다.
  codex exec --profile opencode-cli-text '17의 제곱을 숫자로만 답하세요.'
)
```

`env_key`는 **프록시 접속 키의 환경변수 이름**이며, 프록시의 게이트웨이 상류 자격증명과는 별개입니다. `wire_api = "chat"`로 바꾸거나 프롬프트에 “도구 금지”를 붙이는 것으로 지원되지 않는 API·도구 경계를 우회할 수 없습니다. 일반 텍스트 API 호출은 앞의 curl·벤치 예시를 사용하세요. 이번 프로젝트에는 Codex 도구 브리지를 구현하지 않았습니다.

공식 자료: [Codex CLI 옵션](https://developers.openai.com/codex/cli/reference/), [사용자 공급자·프로필 설정](https://developers.openai.com/codex/config-advanced/), [설정 참조](https://developers.openai.com/codex/config-reference/), [OpenCodex의 Codex 통합 안내](https://opencodex.me/guides/codex-integration/).

## 부록 C. GJC

### 별도 사용자 공급자로 직접 Chat Completions 연결

GJC는 사용자 공급자에 `api: openai-completions`를 지정할 수 있어 **별도 프로토콜 프록시 없이** 8940의 텍스트 API로 구성할 수 있습니다. 기존 내장 `opencode` 등 기본 공급자와 구분하기 위해 여기서는 `opencode-cli-text`라는 새 이름을 사용합니다.

기존 `~/.gjc/agent/models.yml`을 **덮어쓰지 마세요.** 기존 `providers:` 안에 아래 공급자 항목만 병합합니다. `providers:` 루트 키를 중복 생성하거나 기본 모델·역할 바인딩을 바꾸지 마세요. 별도의 `GJC_CODING_AGENT_DIR`을 사용하는 환경에서는 그 디렉터리의 `models.yml`이 대상입니다.

```yaml
providers:
  opencode-cli-text:
    baseUrl: http://127.0.0.1:8940/v1
    apiKeyEnv: GATEWAY_API_KEY
    api: openai-completions
    auth: apiKey
    compat:
      supportsReasoningEffort: false
    models:
      - id: deepseek-v4.1-flash-free
        name: OpenCode CLI 텍스트 전용
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 8192
```

`apiKeyEnv: GATEWAY_API_KEY`는 [GJC 공식 모델 설정 문서](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/models.md)에 명시된 **환경변수 이름 참조**입니다. YAML에 키 값을 저장하거나 `${...}` 보간 문법을 추측해 넣지 않습니다. `auth: apiKey`는 해결된 토큰을 Bearer 인증으로 사용합니다.

GJC 0.18.11이 보내는 `store: false`는 응답 저장을 요청하지 않는 값이므로 게이트웨이가 수용합니다. 초기에는 이 필드를 거절해 400이 발생했지만, 현재 구현은 `false`만 허용합니다. 저장 활성화나 임의 필드를 허용하도록 지원 범위를 넓힌 것은 아닙니다.

`contextWindow: 128000`은 클라이언트용 설정값이지 128000토큰 입력의 실제 중계 성공을 입증한 수치가 아닙니다. HTTP 본문 상한과 네이티브 프롬프트 부가분도 적용됩니다. 비용 0 역시 현재 무료 모델에 맞춘 표시값이며 상류 정책 변경에 대한 약속이 아닙니다. `reasoning: false`는 클라이언트의 추론 옵션 전송을 막기 위한 설정이지 상류 내부 추론의 부재를 뜻하지 않습니다.

### 도구 없는 텍스트 원샷

**GJC 0.18.11에서 도구 없는 텍스트 원샷을 실제 검증했습니다.** 수정된 게이트웨이와 임시 `GJC_CODING_AGENT_DIR`의 사용자 공급자 설정으로 실행해, 응답 본문 `{"gjc_text":true}`와 완료 이유 `stop`을 확인했습니다. 아래는 같은 텍스트 전용 옵션의 예시입니다. 앞의 토큰 파일을 읽을 수 있고 해당 GJC 설정 디렉터리에 위 공급자를 병합한 환경에서 실행합니다.

```bash
(
  IFS= read -r GATEWAY_API_KEY < "$GATEWAY_TOKEN_FILE"
  export GATEWAY_API_KEY
  gjc --model opencode-cli-text/deepseek-v4.1-flash-free \
    --no-tools --no-mcp --no-lsp --no-title --no-rules --no-session \
    --thinking off --mode json \
    -p '설명이나 코드 펜스 없이 {"gjc_text":true}만 출력하세요.'
)
```

`--no-tools`는 기본 도구, `--no-mcp`는 MCP 자동 로드, `--no-lsp`는 LSP 도구·처리, `--no-title`은 제목 생성 요청, `--no-rules`는 규칙 자동 로드를 끕니다. `--mode json`은 GJC의 출력 모드이지 게이트웨이의 JSON 강제 기능이 아닙니다. 실검증 범위는 이 텍스트 원샷에 한정하며 일반 코딩 모드·도구 실행·장시간 세션 성공을 뜻하지 않습니다. 기본 코딩 세션처럼 실행하거나 별도 확장에서 도구를 주입하면 400이 될 수 있습니다. 이미지·파일을 첨부하지 말고 텍스트만 입력하세요. 잘못된 API 선택으로 Responses나 Messages를 보내도 동작하지 않습니다.

공식 자료: [Gajae-Code 저장소](https://github.com/Yeachan-Heo/gajae-code), [사용자 공급자·키 참조·호환 필드](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/models.md).

## 상류 문서

- [OpenCode CLI](https://opencode.ai/docs/cli/)
- [OpenCode 권한 정책](https://opencode.ai/docs/permissions/)
- [고정한 npm 패키지 `opencode-ai@1.19.0`](https://www.npmjs.com/package/opencode-ai/v/1.19.0)

상류 문서는 최신 버전 기준으로 바뀔 수 있습니다. 이 저장소가 고정한 CLI 버전과 실제 요청·오류를 기준으로 지원 범위를 판단하세요.
