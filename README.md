# opencode-cli-gateway

정식 **OpenCode CLI**를 요청마다 한 번 실행해 OpenAI Chat Completions API로 제공합니다. CLI는 OpenCode V2 `@opencode/cli@2.4.1`로 고정합니다. 제공 모델은 OpenCode 무료 모델 세 개이며, 요청의 `model`로 고릅니다.

| 모델 ID                    | 컨텍스트 | 최대 출력 | 입력          | effort                                        |
| -------------------------- | -------- | --------- | ------------- | --------------------------------------------- |
| `deepseek-v4.1-flash-free` | 200K     | 32000     | 텍스트·이미지 | `low`·`high`·`max`                            |
| `tidepool-alpha-free`      | 1M       | 131072    | 텍스트        | `minimal`·`low`·`medium`·`high`·`xhigh`·`max` |
| `iceman-free`              | 256K     | 131072    | 텍스트        | 없음(`reasoning_effort`를 보내면 400)         |

한도·입력·effort 단계는 models.dev의 OpenCode 항목에 공시된 값입니다. `tidepool-alpha-free`(2026-11-18 공개)와 `iceman-free`(2026-11-06 공개)는 "한시적 무료" 스텔스 모델이며, 상류가 수집한 데이터를 모델 개선에 씁니다. 기밀 자료를 보내지 마세요. 세 모델 모두 무료 상류에서 텍스트·시스템 지시 준수·함수 호출·도구 결과 왕복을 실측했고, DeepSeek 이미지 입력과 Tidepool `minimal`·`xhigh`·`max`를 확인했습니다.

이전에 제공하던 `glm-5.3-flash-free`는 상류에서 내려가(400 "Model is unavailable") 목록에서 뺐습니다.

### V1 CLI에서 V2로 옮긴 이유

2026-11 OpenCode는 V1 CLI(`opencode-ai`)의 무료 모델 사용을 막았습니다. V1 CLI는 무료 모델 요청마다 429 `FreeUsageLimitError`를 받고, CLI가 이를 계속 재시도해 게이트웨이에는 시간 초과(504)로만 보였습니다. 상류 공지는 "무료 모델은 OpenCode 안에서만 동작하며 다른 클라이언트·프록시·직접 API 호출은 쓸 수 없다"고 밝힙니다. **이 게이트웨이는 그 공지가 말하는 프록시 사용에 해당하므로, 상류가 언제든 막을 수 있습니다.**

무료 상류는 요청이 OpenCode에서 왔는지 본문으로 판별합니다. 실측 결과는 다음과 같습니다.

| 상류로 보낸 본문                                               | 결과 |
| -------------------------------------------------------------- | ---- |
| OpenCode 시스템 프롬프트를 앞에 두고 호출자 메시지를 이어 붙임 | 성공 |
| OpenCode 시스템 프롬프트를 호출자 system으로 교체              | 429  |
| 함수 목록에 OpenCode `read` 포함(호출자 함수와 함께)           | 성공 |
| `read` 없이 호출자 함수만, 또는 함수 없음                      | 429  |

그래서 V2 게이트웨이는 **OpenCode 시스템 프롬프트와 `read` 정의를 남긴 채** 나머지를 호출자 것으로 바꿉니다.

같은 IP에서 짧은 시간에 요청이 몰리면, 플러그인 없는 정식 CLI도 같은 429를 간헐적으로 받습니다(한 호스트에서 수 분간 약 60회 시험 뒤 정식 CLI 10회 중 4회). 이때 `Retry-After`는 수만 초로 오지만 다음 요청은 곧바로 성공하기도 합니다. 게이트웨이는 이 429를 그대로 돌려주며 재시도하지 않습니다.

**비공식·독립 프로젝트입니다.** OpenCode·Anthropic·OpenAI·Gajae-Code의 공식 제품이나 완전한 호환성을 주장하지 않습니다. 다른 클라이언트로 위장하는 헤더나 비공개 엔드포인트를 쓰지 않으며, 상류 요청은 고정 CLI가 직접 보냅니다. 무료 모델의 제공 기간·한도·가격·가용성은 상류 정책에 달려 있습니다.

## 동작 방식: 요청 하나 = 모델 호출 하나

```text
클라이언트 ─ Chat Completions(전체 이력) ─▶ 게이트웨이
  게이트웨이: 요청 파일·전역 설정 작성 → 격리된 `opencode run --standalone` 1회 실행
  plugin/ (OpenCode V2 공식 플러그인 API)
    session.hook("http.request")  → 상류 본문 교체: OpenCode 시스템 프롬프트 뒤에 호출자 system·developer,
                                     이력은 호출자 메시지, 함수는 호출자 함수 + OpenCode `read`, 생성 설정은 호출자 값
    session.hook("http.response") → 상류 SSE를 읽어 텍스트·추론 델타, 함수 호출, 종료를 게이트웨이로 전달하고
                                     OpenCode에는 빈 종료 응답만 돌려줌
    session.hook("title"/"retry") → 제목 생성 호출과 CLI 재시도를 막음
    tool.hook("execute.before")   → OpenCode 도구 실행을 막음(도달하면 실패 처리)
  CLI는 빈 답을 받고 스스로 종료
클라이언트 ◀─ 텍스트 또는 tool_calls(원래 ID·이름·인자) ─ 게이트웨이
클라이언트가 도구를 실제 실행하고 결과를 이력에 붙여 다음 요청
```

- **게이트웨이는 무상태입니다.** 도구 결과를 기다리며 유지하는 CLI·세션·TTL이 없습니다. 매 요청의 이력이 진실의 원천이므로 요청마다 도구 목록·스키마가 바뀌어도, 이력을 압축·편집해도, 게이트웨이를 재시작해도, 다른 인스턴스로 라우팅해도 동작합니다.
- **도구 실행은 클라이언트 소유입니다.** 플러그인은 상류 응답의 함수 호출을 게이트웨이에 넘기고 OpenCode에는 호출 없는 빈 답만 주므로, OpenCode는 도구를 실행하지도 다음 상류 요청을 보내지도 않습니다. 게이트웨이 호스트는 파일 읽기·쓰기·셸을 실행하지 않습니다.
- **상류 본문**: OpenCode 시스템 프롬프트(에이전트 지시·환경 블록)가 맨 앞에 남고, 그 뒤에 호출자 system·developer 문구와 원래 역할 순서의 대화·`tool_calls`·`tool` 결과가 옵니다. `tools`는 호출자 함수의 원래 이름·설명·스키마에 OpenCode `read` 정의 하나를 더한 것입니다. 호출자 함수에 `read`가 있으면 그 정의가 대신 쓰입니다. 위 표처럼 둘 다 상류가 요구합니다. OpenCode 시스템 프롬프트 때문에 입력 토큰이 모델에 따라 약 3K~11K 늘어납니다.
- **요청 헤더**는 CLI가 만든 그대로(`x-opencode-client: cli` 등)이며 게이트웨이가 바꾸지 않습니다.
- `tool_choice: "required"`와 특정 함수 강제는 상류 `tool_choice: "required"`로 전송합니다. 함수 강제는 해당 함수만 선언합니다. 텍스트만 반환하면 성공으로 위장하지 않고 502로 실패합니다.
- 모델이 호출자 함수 없이 OpenCode `read`만 부르면, 아직 출력이 없을 때에 한해 같은 본문으로 최대 2번 다시 묻습니다. 본문을 이미 말했다면 그 본문을 정상 종료로 돌려줍니다. 계속 `read`만 부르면 502입니다. 이 호출은 클라이언트에 전달되지 않습니다.
- 상류 오류는 상태와 메시지를 그대로 돌려줍니다(예: 429 `Free usage limit reached`).

## 지원 범위

| 항목      | 지원과 제한                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API       | `POST /v1/chat/completions`, `GET /v1/models`: Bearer 인증. `GET /healthz`: 인증 없음, 상류 검사 아님                                                                                                          |
| 메시지    | 앞부분의 `system`·`developer`(합쳐서 시스템 프롬프트), `user`, `assistant`(`tool_calls`, `reasoning_content`), `tool`                                                                                          |
| 입력 형식 | 텍스트 문자열·텍스트 파트. **사용자 이미지**: PNG·JPEG·GIF·WebP base64 data URL(원격 URL은 미지원)                                                                                                             |
| 함수      | OpenAI `type: function` 최대 512개(한도는 사실상 모델 컨텍스트), 이름 1~64자, 설명 32768자, object 루트 JSON Schema 64KiB. 스키마는 변형 없이 상류로 전달. 한 응답의 호출은 최대 64개                          |
| 도구 선택 | `auto`, `none`, `required`, 특정 함수 강제                                                                                                                                                                     |
| 병렬 호출 | 한 단계의 호출을 모두 반환. `parallel_tool_calls`는 상류로 전달하고, `false`일 때는 첫 호출만 반환                                                                                                             |
| 생성 옵션 | `temperature`, `top_p`, `max_tokens`/`max_completion_tokens`(1~모델 최대 출력, 기본 1024), `stop`, `seed`, `frequency_penalty`, `presence_penalty`, `reasoning_effort`(모델별 단계), `response_format`, `user` |
| SSE       | 상류 토큰 델타를 즉시 전달. `content`와 `reasoning_content`를 구분                                                                                                                                             |
| 응답      | `reasoning_content`, `tool_calls`, 실제 상류 `usage`(캐시·추론 토큰 포함)                                                                                                                                      |
| 미지원    | 오디오·파일 입력, 도구 결과 이미지, legacy `function` 역할, custom/freeform 도구, `n>1`, `logprobs`, `store: true`                                                                                             |
| 프로토콜  | Responses·Messages는 직접 제공하지 않음. 별도 프로토콜 프록시 필요                                                                                                                                             |

함수 정의는 매 요청마다 프롬프트 토큰을 씁니다. MCP 서버가 붙은 GJC의 함수 155개는 약 43K 토큰이었습니다. 실측으로 상류는 함수 310개까지 받았습니다.

JSON Schema의 `format`은 주석입니다. 클라이언트도 자체 인자 검증·권한 정책·실행 격리를 적용해야 합니다.

### 추론 강도(effort)

단계는 모델마다 다릅니다(맨 위 표). `reasoning_effort`로 지정하며, 그 모델의 단계가 아닌 값은 400 `unsupported_parameter`입니다. `GET /v1/models`는 모델별 `supports_reasoning`과 `reasoning_efforts`를 광고합니다(`iceman-free`는 빈 목록).

- 플러그인이 상류 본문에 `reasoning_effort`를 직접 넣습니다. 지정하지 않으면 OpenCode가 넣은 값을 지우고 상류 기본값을 따릅니다.
- 클라이언트 단계는 프록시나 클라이언트 설정에서 매핑합니다. `register-oci.py`는 OpenCodex에 모델별로 다음을 등록합니다.
  - DeepSeek: 단계 `low`·`high`·`max`, 매핑 `minimal→low`·`medium→high`·`xhigh→max`, 기본 `high`
  - Tidepool: 여섯 단계를 그대로, 기본 `medium`
  - Iceman: 빈 단계 목록. OpenCodex가 `reasoning_effort`를 지우고 보냅니다.
  - 세 모델 모두 이력의 `reasoning_content` 보존
- OpenCodex 2.100.3의 Chat 입구(`/v1/chat/completions`)는 이 매핑을 적용하지 않고 받은 단계를 그대로 넘깁니다. 그래서 DeepSeek에 `medium`을 보내면 400입니다. Responses 입구는 매핑합니다(`medium→high` 실측).

## 설치와 로컬 실행

Linux, Node.js 20 이상, npm, 상류 네트워크 연결이 필요합니다. 벤치·SSH 등록 스크립트에는 Python 3이 필요하며 추가 Python 패키지는 없습니다. 다른 OS·CLI 버전은 검증하지 않았습니다. 플러그인 훅은 `@opencode/cli` 2.4.1 기준입니다. 패키지는 OS별 실행 파일(`@opencode/cli-linux-x64` 등)을 선택 의존성으로 받습니다.

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

요청마다 CLI를 새로 기동하므로 상류 응답 외에 약 2~4초의 기동 비용이 듭니다. 플러그인은 의존성 없는 로컬 디렉터리라 요청마다 npm에 접속하지 않습니다. 플러그인 이벤트와 CLI 출력은 각각 줄당 4MiB, SSE 송신 버퍼는 1MiB로 제한합니다.

| 상태 | 대표 원인                                                                       |
| ---- | ------------------------------------------------------------------------------- |
| 400  | 잘못된 스키마·이력·미지원 필드·이미지 형식, 중간 위치의 system 메시지           |
| 401  | Bearer 불일치                                                                   |
| 403  | 상류 거절                                                                       |
| 404  | 잘못된 모델·경로                                                                |
| 413  | 본문 상한 초과                                                                  |
| 429  | 동시 실행 포화 또는 상류 무료 한도(`Free usage limit reached`)                  |
| 502  | 선언되지 않은 함수·잘못된 인자 호출, 필수 호출 누락, `read`만 반복, 불완전 응답 |
| 504  | 요청 제한 시간 초과                                                             |

## 보안과 systemd

**공개 인터넷에 평문 HTTP로 노출하지 마세요.** 루프백, SSH 터널, 접근 제한 사설망 또는 인증·접근 제어가 있는 TLS 프록시를 사용하세요. 자체 TLS·사용자별 계정·할당량은 없으며 하나의 공유 토큰을 씁니다.

토큰 파일은 `0600`, 비밀 디렉터리는 `0700`으로 관리하고 curl 추적 로그를 켜지 마세요. 입력·함수 정의·결과는 상류 모델로 전달됩니다. 요청 파일은 처리 중에만 상태 디렉터리에 존재하며, 강제 종료 시에는 남을 수 있습니다. HOME/XDG 분리와 권한 설정은 완전한 OS 샌드박스가 아닙니다. 전용 비특권 서비스와 고정 CLI를 사용하세요.

서비스 예제는 `DynamicUser`, `LoadCredential`, `ProtectHome`, `ProtectSystem`, 프로세스 그룹 정리와 2GiB 메모리 상한을 사용합니다. 아래는 **신규 설치 예시**이며 기존 토큰·설치를 덮어쓰는 업그레이드 절차가 아닙니다.

```bash
sudo install -d -m 0755 /opt/opencode-cli-gateway
sudo install -m 0644 main.mjs server.mjs cli.mjs errors.mjs tools.mjs \
  package.json package-lock.json /opt/opencode-cli-gateway/
sudo install -d -m 0755 /opt/opencode-cli-gateway/plugin
sudo install -m 0644 plugin/index.js plugin/upstream.js plugin/package.json \
  /opt/opencode-cli-gateway/plugin/
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

Node 테스트는 HTTP·SSE·이미지·생성 옵션·모델별 한도·이력 검증·러너 이벤트 처리·취소·정리와, 플러그인의 본문 교체·SSE 해석·함수 인자 누적·`read` 재질문·상류 오류 전달을 검증합니다. 회귀 테스트에는 모델 대신 대체 CLI 프로세스와 가짜 OpenCode 훅을 사용하므로, 실제 상류 검증과는 구분됩니다.

별도의 실제 모델 검증(고정 CLI 2.4.1, 실제 무료 상류, 2026-11-24):

- **일회용 클라우드 VM**: 세 모델 각각 텍스트(`391`), 시스템 지시 준수(`PINEAPPLE`), 필수 함수 호출(`lookup`, 원래 이름·인자), 도구 결과를 반영한 최종 답, Tidepool 스트리밍 `minimal`·`max`(추론 델타 분리, 사용량 포함), DeepSeek `low`·이미지 색 인식(`Red`), 동시 3건이 모두 200이었습니다(16/16). Iceman `reasoning_effort`는 400으로 거절했습니다.
- **상시 운영 호스트**: 같은 시험을 반복하는 동안 위의 IP 단위 429가 간헐적으로 섞였습니다. 같은 시각 플러그인 없는 정식 CLI도 같은 비율로 429를 받아, 게이트웨이의 본문 교체 때문이 아님을 확인했습니다.
- **OpenCodex 경유**: Chat으로 Tidepool `xhigh`·Iceman(effort 제거), Responses로 Tidepool `minimal`·DeepSeek `medium→high`가 200이었습니다.

V1 시절 측정(GJC 종단·다단계 코딩·동시성 벤치)은 V2에서 다시 재지 않았습니다. 소규모 관측이며 장시간 안정성·최대 처리량·다른 장비에서의 성능 보장이 아닙니다.

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

| 위치                     | 값                                                               |
| ------------------------ | ---------------------------------------------------------------- |
| 공급자 이름 예시         | `opencode-cli`                                                   |
| 상류 어댑터·URL          | `openai-chat`, 같은 호스트면 `http://127.0.0.1:8940/v1`          |
| 상류 자격증명            | 게이트웨이 토큰, `key` 인증                                      |
| 상류 모델                | `deepseek-v4.1-flash-free`, `tidepool-alpha-free`, `iceman-free` |
| 클라이언트용 프록시 모델 | `opencode-cli/<위 모델 ID>`                                      |
| Messages 기본 URL        | `http://127.0.0.1:10100`                                         |
| Responses·Chat 기본 URL  | `http://127.0.0.1:10100/v1`                                      |
| 클라이언트 키            | **프록시 접속 키**. 게이트웨이 토큰·관리자 키와 혼동하지 않음    |

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
        name: DeepSeek V4.1 Flash Free · OpenCode CLI
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
      - id: tidepool-alpha-free
        name: Tidepool Alpha Free · OpenCode CLI
        reasoning: true
        thinking:
          mode: effort
          minLevel: minimal
          maxLevel: max
          levels: [minimal, low, medium, high, xhigh, max]
          defaultLevel: medium
        compat:
          reasoningEffortMap:
            {
              minimal: minimal,
              low: low,
              medium: medium,
              high: high,
              xhigh: xhigh,
              max: max,
            }
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 1048576
        maxTokens: 8192
      - id: iceman-free
        name: Iceman Free · OpenCode CLI
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 262144
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
- [고정 CLI 패키지](https://www.npmjs.com/package/@opencode/cli/v/2.4.1)
- [V2 플러그인](https://opencode.ai/docs/build/plugins/), [V1→V2 이전](https://opencode.ai/docs/build/plugins/migrate-v1/)

상류 문서·서비스는 바뀔 수 있습니다. 고정 버전·실제 요청·실제 오류를 기준으로 지원 범위를 판단하세요.
