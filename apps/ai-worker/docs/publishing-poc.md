# 사진 + 프롬프트 → 이미지·게시문 → Instagram

로컬 기본 화면에서 **새 게시물 만들기**를 누르고 사진과 프롬프트를 입력합니다. **이미지·게시문 생성**을 누르면 Ollama가 사진과 지시를 읽어 한국어 게시문과 영어 이미지 프롬프트를 만들고, 기존 ComfyUI SDXL img2img가 이미지를 생성합니다. 생성 이미지는 ffmpeg로 게시용 JPEG(1080×1350, 필요한 부분은 흰 여백)로 변환합니다. 이 기능의 SDXL 변형 강도(denoise)는 0.8로, 기존 재귀 생성의 0.45보다 프롬프트를 더 반영하도록 설정했습니다. 두 결과가 모두 준비된 뒤 검토·수정·저장하고 Publish를 누릅니다. 생성은 Instagram에 자동 게시하지 않습니다.

필요 서비스는 Ollama `gemma3:4b`, ComfyUI와 `sd_xl_base_1.0.safetensors`, 서버 PATH의 `ffmpeg`입니다. ffmpeg 경로를 지정하려면 `FFMPEG_PATH`를 사용하세요. 별도 클라우드 AI나 유료 API를 추가하지 않습니다. SDXL img2img는 원본 구도를 참고하는 생성 방식이므로 요청한 모든 세부 편집을 정확히 수행한다는 보장은 없습니다.

`POST /api/creations` JSON `{ "image": "data:image/jpeg;base64,...", "prompt": "사진을 수채화 분위기로 바꾸고 짧은 게시문을 써줘" }`를 받습니다. prompt는 1~2,000자입니다. 입력을 저장한 뒤 202로 응답하고 서버에서 생성하며, 기존 관측 조회 API로 진행 상태를 조회합니다. 이 API는 로컬 전용입니다. 홈서버의 기존 관측 수신 API와 목록도 유지합니다.

결과에는 원본 사진·사용자 prompt·실제 이미지 생성 프롬프트·seed를 보관합니다. 새 이미지·게시문 생성은 한 번에 하나만 실행합니다. 실패 시 원본과 오류를 보존하고 재시도할 수 있으며, 이전 결과가 남아 있어도 failed 상태에서는 게시할 수 없습니다. `POST /api/observations/:id/generate`에 최신 `revision`을 보내면 같은 원본 사진·프롬프트로 두 결과를 다시 생성합니다. 재생성은 기존 결과를 교체합니다.

---

# 관측 → AI 초안 → 검토 → Instagram POC

## 실행과 화면

`npm run dev` 실행 후 http://localhost:5174 에서 검토 화면을 엽니다.
기존 사진·녹음 화면은 `/capture`에서 유지합니다. `n.joun.cc`의 기존 공개 화면도 유지합니다.
검토·수정·게시 API는 기존 로컬 접근 정책 안에 두며 공개 터널에서 차단합니다.
외부 홈서버의 수신 POST만 Origin 헤더 없이 Bearer 토큰으로 허용합니다. 기존 공개 터널을 쓸 경우 `https://n.joun.cc/api/observations`로 전송할 수 있습니다. 터널/서비스 재시작·배포는 이번 변경에 포함하지 않습니다.

`.env.example`를 참고해 환경변수를 설정합니다. `npm run dev`와 `npm run serve:public`는 `.env`를 자동으로 읽습니다. 변경 후 해당 서버를 다시 시작하세요. 셸에 이미 export한 값은 `.env`보다 우선하므로 이전 수동 설정이 남아 있으면 해제하세요. 토큰은 프런트엔드에 전달하지 않습니다.

Ollama의 `gemma3:4b`를 사용하며 음성 입력에만 기존 Whisper가 필요합니다. ComfyUI는 사용하지 않습니다.

## 홈서버 계약

`POST /api/observations`, `Content-Type: application/json`, `Authorization: Bearer <OBSERVATION_TOKEN>`.
한 요청은 최대 16MB. 원본이 저장되면 202를 반환하고 서버에서 자동으로 AI 초안을 생성합니다. 동일 이벤트 재전송은 기존 결과를 반환하며, 처리 중이면 409입니다. 동일 ID의 다른 입력은 409입니다. 홈서버는 재전송 때 eventId와 관측 내용을 유지하세요.

```json
{
  "eventId": "bot-1-20261106-001",
  "capturedAt": "2026-11-06T14:30:00+09:00",
  "sensors": {
    "temperatureC": 23.5,
    "humidityPercent": 48,
    "motionDetected": true
  }
}
```

- eventId: 영문·숫자·밑줄·하이픈, 1~100자.
- capturedAt: 시간대를 포함하는 ISO 8601 관측 시각.
- sensors: 필수 객체, 최대 100개. 값은 문자열(500자 이하)·유한 숫자·불리언. 단위를 키에 포함하세요. 센서 종류는 아직 고정하지 않습니다.
- image: 선택. `data:image/jpeg;base64,...` (또는 PNG·WebP).
- audio: 선택. `data:audio/wav;base64,...`. 16kHz·모노·16bit PCM WAV, 최대 60초.
- 센서값·사진·음성 중 최소 하나가 있어야 합니다.
- 파일을 base64 data URL로 JSON에 담습니다. POC에서는 multipart나 외부 원본 URL 다운로드를 지원하지 않습니다.

```sh
curl http://127.0.0.1:3002/api/observations \
  -H "Authorization: Bearer $OBSERVATION_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @observation.json
```

UI의 **샘플 관측 받기**도 같은 생성 파이프라인을 사용하며 AI 결과를 흉내 내지 않습니다. 입력 센서값만 예시입니다.

## 검토와 게시 API

- `GET /api/observations`: 원본 이미지·오디오를 제외한 목록.
- `GET /api/observations/:eventId`: 원본과 초안·상태.
- `POST /api/observations/:eventId/generate` + `{}`: 생성 실패 재시도 또는 초안 재작성. 기존 초안을 대체합니다.
- `PATCH /api/observations/:eventId` + `{ "caption": "검토한 게시문", "imageUrl": "https://.../photo.jpg", "revision": 1 }`: 초안 수정. 저장할 때 revision이 증가합니다.
- `POST /api/observations/:eventId/publish` + `{ "revision": 2, "accountId": "선택한 Instagram 숫자 ID" }`: 저장된 정확한 버전의 게시문과 이미지 URL을 게시합니다. 향후 자동화도 이 기능을 사용합니다.
- `GET /api/publishing/status`: 연결 설정 유무만 반환. 토큰 유효성 확인은 실제 Meta 요청 시 수행됩니다.

상태: received → generating → draft → publishing → published.
AI 실패는 failed로 남고 재시도할 수 있습니다. Meta 컨테이너 생성·처리 실패는 draft로 돌아갑니다. 최종 게시 요청 후 오류·타임아웃, 게시 중 서버 종료는 unknown으로 남겨 중복 게시를 차단합니다. unknown은 Instagram에서 직접 게시 여부를 확인하고 운영자가 저장 기록을 정리하기 전 재게시할 수 없습니다. 자동 복구 UI는 POC 범위에 없습니다.

`data/publications/<eventId>.json`에 원본·음성 전사·초안·게시 결과를 저장합니다. AI 실행 중 서버 종료는 failed로 복구하며 자동 재개하지 않습니다. 단일 Node 프로세스용 파일 저장·동시 요청 잠금이며 다중 프로세스 운영은 지원하지 않습니다.

## Instagram Unified login 연결

앱과 게시할 Instagram 계정을 같은 Business Portfolio가 소유하는 자체 운영 환경에서는 Unified Login이 만든 숨은 Business Integration System User에 같은 포트폴리오 자산이 위임되지 않아 `assigned_instagram_accounts`가 빈 배열이 될 수 있다. 이 경우 Business Settings의 **Users → System users**에서 명시적 System User를 만들고, Instagram 계정의 콘텐츠 권한을 자산으로 할당한 다음 앱의 `instagram_basic`, `instagram_content_publish` 권한으로 토큰을 생성한다. `.env`의 `INSTAGRAM_SYSTEM_USER_ACCESS_TOKEN`과 Instagram 프로페셔널 계정의 숫자 ID인 `INSTAGRAM_SYSTEM_USER_ID`를 설정하면 이 연결을 우선 사용한다. System User 자체 ID를 넣지 않는다.

1. Meta 앱의 **App settings → Basic**에서 App ID와 App Secret을 확인합니다. `.env`의 `META_APP_ID`, `META_APP_SECRET`에 넣습니다. 시크릿을 채팅이나 프런트엔드에 넣지 마세요.
2. Instagram → **API setup with Unified login**의 선택된 Configuration ID를 `INSTAGRAM_CONFIG_ID`에 넣습니다. 이는 Instagram 사용자 ID가 아닙니다.
3. 설정 구성에는 Instagram 계정 자산과 `instagram_basic`, `instagram_content_publish` 권한이 필요합니다. 게시만 구현하므로 메시지·댓글 권한은 이 앱에서 사용하지 않습니다. 테스트 계정은 앱 역할과 계정/비즈니스 포트폴리오 권한을 갖춰야 합니다.
4. `INSTAGRAM_API_VERSION`은 Meta 앱에서 지원하는 버전으로 설정합니다. 예시 파일은 `v26.0`입니다.
5. **Redirect URL**에 `.env`의 `INSTAGRAM_REDIRECT_URI`와 정확히 같은 주소를 등록합니다. 기존 터널을 쓰는 예시는 `https://n.joun.cc/api/instagram/callback`입니다.
6. 로컬 API와 공개 콜백 API를 모두 최신 코드로 실행합니다. 두 프로세스는 같은 프로젝트 폴더의 `.env`, `data/instagram/`을 공유해야 합니다. 공개 서비스의 코드 적용은 빌드와 서비스 재시작이 필요합니다. 이번 구현만으로 기존 공개 서비스에 자동 배포하지 않습니다.
7. 로컬 검토 화면의 **인스타그램 연결**을 누르고 Meta에서 로그인·계정 공유를 승인합니다. Meta 콘솔의 정적인 Login URL 대신 이 버튼을 사용하세요. 버튼이 브라우저 확인용 state를 생성합니다.
8. 콜백 화면의 **검토 화면으로 돌아가기**를 누르면, 처음 연결을 시작한 브라우저의 로컬 서버가 토큰 교환과 계정 조회를 완료합니다. 여러 계정을 승인했다면 게시 계정을 선택하세요. 한 계정이면 자동 선택합니다.

환경변수를 생략할 때의 개발용 콜백 기본값은 `http://localhost:5174/api/instagram/callback`입니다. Meta가 해당 앱의 로컬 HTTP URL을 허용하는지는 콘솔에서 확인해야 합니다. HTTPS가 필요하면 위 공개 터널 주소를 사용하세요. 임의의 예시 도메인은 사용할 수 없습니다.

새 API:
- `POST /api/instagram/connect` + `{}`: 로컬 UI에서만 로그인 URL 생성, HttpOnly 브라우저 쿠키 설정.
- `GET /api/instagram/callback`: 공개 허용 경로. 일회용 state 검증 후 코드만 임시 저장합니다. 이 경로는 토큰을 발급·노출하거나 게시하지 않습니다.
- `POST /api/instagram/complete` + `{}`: 시작한 브라우저 확인 후 서버에서 인증 코드 교환, `/me/assigned_instagram_accounts` 조회, 연결 저장.
- `POST /api/instagram/account` + `{ "userId": "..." }`: 승인된 계정 중 게시 대상을 선택.
- `GET /api/publishing/status`: 연결 상태·계정 이름·Redirect URL만 반환. 시크릿·토큰은 반환하지 않습니다.

로그인 요청은 10분 후 만료되고, 콜백과 코드는 한 번만 소비합니다. 공개·로컬 콜백 프로세스가 동일한 상태 파일을 사용하도록 원자적 파일 이동으로 재사용을 막습니다. 임시 인증 코드는 교환 후 삭제하며 만료된 임시 파일은 다음 연결 시작 시 정리합니다. 토큰은 `data/instagram/connection.json`에 App Secret에서 파생한 키로 AES-256-GCM 암호화하여 저장합니다. App Secret 변경 시 다시 연결해야 합니다. 원본 인증 정보 폴더는 서버 전용으로 관리하고 `.env`와 함께 외부에 제공하지 마세요.

Unified login은 `config_id`를 사용하는 Facebook Login for Business 인증 코드 흐름과 `graph.facebook.com`을 사용합니다. 게시 시작 때 선택한 계정과 토큰을 고정하여 도중 재연결로 게시 대상이 바뀌지 않게 합니다. 클라이언트가 검토한 계정 ID와 서버의 계정 ID가 다르면 게시를 차단합니다. 기존 Instagram Login용 수동 환경변수는 OAuth 앱 설정이 없는 경우만 기존 `graph.instagram.com` 방식으로 유지합니다.

계정 목록이 비어 있으면 추측한 ID를 저장하지 않습니다. Meta 로그인에서 올바른 비즈니스 포트폴리오와 계정 자산을 공유했는지 확인하고 다시 연결하세요. 실패한 재연결은 기존 정상 연결을 덮어쓰지 않습니다. 토큰 만료·권한 철회 시 재연결이 필요합니다. 별도의 자동 토큰 갱신이나 앱 심사 자동화는 구현하지 않습니다.

검토 화면의 **게시할 이미지**에서 JPG·PNG·WebP(원본 최대 20MB)를 선택하면 브라우저가 JPEG로 변환하고 미리보기를 보여줍니다. 가로 1080px로 맞추고, 지원 비율을 벗어난 부분은 흰 여백으로 채워 원본을 자르지 않습니다. **변경 저장**으로 서버에 업로드한 뒤 검토 확인과 Publish를 진행하세요. URL 직접 입력도 접힌 보조 기능으로 유지합니다.

저장 API의 선택 필드 `image`에 JPEG base64 data URL을 전달하면 `data/publication-images/`에 콘텐츠 해시 이름으로 저장합니다. 저장한 결과는 `uploadedImageId`로 식별하며, `GET /api/observations/:eventId/image`는 로컬 미리보기 전용입니다. `removeImage: true`로 제거합니다. 이미지 변경도 revision을 증가시키고 재검토가 필요합니다.

Publish 시 서버가 `/api/publish-images/<hash>.jpg?expires=...&signature=...` 형식의 1시간 유효 서명 주소를 만들어 Meta에 전달합니다. 서명 없이는 이미지에 접근할 수 없습니다. 임시 URL을 아는 사람은 만료 전까지 해당 이미지를 읽을 수 있습니다. `INSTAGRAM_MEDIA_ORIGIN`이 있으면 그 HTTPS origin을 사용하며, 없으면 `INSTAGRAM_REDIRECT_URI`의 origin을 사용합니다. 로컬·공개 프로세스는 이미지 폴더와 서명 키(`PUBLISH_MEDIA_SECRET` 또는 `META_APP_SECRET`)를 공유해야 합니다. 이미지 파일은 저장 후 유지되며 이번 POC에는 자동 정리가 없습니다.

수신 원본 사진은 게시 이미지로 자동 선택하거나 공개하지 않습니다. 사용자가 게시용으로 업로드한 이미지에만 이 흐름을 적용합니다. 실제 게시에는 정상적인 Instagram 계정 연결이 여전히 필요합니다.

참고: [Meta Facebook Business SDK의 assigned Instagram accounts](https://github.com/meta/facebook-python-business-sdk/blob/main/facebook_business/adobjects/user.py), [OpenPost의 Unified login 연동 문서](https://openpo.st/docs/self-hosting/integrations/instagram#new-meta-apps-unified-login-with-config_id), [Meta Unified login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-unified-login/).

## 검증

`npm test`, `npm run build`.
새 통합 테스트는 가짜 Ollama·Meta 응답으로 수신 토큰, 원본 저장, 중복/충돌, AI 실패와 재시도, 수정 revision, 정확한 검토문 게시, 중복 게시 방지, 불확실한 게시 결과와 재시작 복구를 검증합니다. 실제 Instagram 게시는 자격 증명과 공개 이미지 연결 후 별도 확인이 필요합니다.


## 카드뉴스와 피에조 단계 (2026-11-06)

- 출력: 커버 1장 + 본문 3장, 모두 JPEG 1080×1350. 사진 배경, 하단 검정 그라데이션, 굵은 흰 제목과 하단 브랜드. 원본 비율을 보존하고 부족한 영역은 여백으로 채운다. 본문 이미지는 같은 사진에 각기 다른 제목·내용을 합성한다.
- `piezoLevel`: 정수 0(어그로성 기자), 1(조금 착하게), 2(완전 아첨). 기본 0. 헤드라인·카드 본문·caption 전체에 적용. 관리자 화면에서는 수동 선택하며, 홈 자동 생성은 아래 실물 피에조 수신 상태를 사용한다. 실물 센서의 전압 임계값은 송신 측에서 분류한다.
- 생성 요청 및 재생성 요청은 `piezoLevel`을 받고 생성 시 저장한다. 이미 만든 결과에는 단계 변경을 소급하지 않는다. 관리자 화면은 재생성 시, 홈 화면은 다음 자동 생성 시작 시 새 단계를 적용한다.
- 사진은 가림 처리가 필요 없는 것으로 사용하며 자동 마스킹 없이 원본 장면을 보존한다. 말투가 세져도 범죄·사생활·확인되지 않은 사건을 만들지 않는다.
- `cards`: `{imageId, title, body}[]` 4개. `uploadedImageId`는 기존 호환용 첫 커버 ID. `GET /api/observations/:id/cards/:index`(0~3)는 로컬 미리보기·저장용.
- 카드뉴스 게시: 각 이미지의 child container → FINISHED 확인 → 순서대로 묶은 CAROUSEL parent → FINISHED 확인 → media_publish 1회. child 실패 시 게시하지 않고 초안 유지. publish 결과 불확실 시 기존 unknown 처리를 유지한다. 기존 단일 이미지 초안도 그대로 게시 가능하다.
- 카드뉴스 이미지는 한 세트이므로 단일 이미지 교체·제거 API는 차단한다. caption 수정은 허용한다. 생성 실패 시 이전 이미지 세트는 보존하며 게시를 차단한다.
- 공개 `/`와 `/poc`는 상태 비저장 카드뉴스 체험이다. POST `/api/card-preview`는 요청의 사진·맥락·단계를 처리해 4개 data URL과 caption을 반환한다. 저장된 초안·계정 조회·게시 권한은 공개하지 않는다. 동시 생성은 프로세스당 1개로 제한한다. 기존 `/capture`는 유지한다.
- 위험: 실제 Meta 계정의 권한·이미지 fetch·모델 출력에 따른 실패 가능. 검증은 격리된 API mock과 렌더 결과, 빌드와 공개 배포 응답으로 수행한다. 실제 계정 게시·센서 하드웨어 연결·새 사진 합성은 범위 밖이다.
- 폐기 조건: 4장 중 하나라도 잘못된 레이아웃·본문 잘림·잘못된 단계·다른 이미지 순서로 전달되면 배포 전에 수정한다.


### 10초 대화 입력

공개 POC와 로컬 새 카드뉴스 화면에 마이크 입력을 제공한다. 참여자 동의 후 녹음하며 10초 자동 종료 또는 수동 종료한다. 기존 Web Audio → 16kHz mono WAV → `/api/transcribe` → 로컬 Whisper 경로를 재사용한다. 기존 `/capture`의 60초 제한은 유지한다. 전사 중에는 카드뉴스 생성을 막고, 완료된 녹취를 확인·개별 삭제·전체 삭제할 수 있다. 사진만 생성하는 경로도 유지한다.

`POST /api/card-preview`, `POST /api/creations`의 선택적 `transcript`는 최대 8,000자 문자열이다. 서버는 프롬프트와 녹취를 구분한 JSON 자료로 모델에 전달하고 녹취에 없는 대사·발언자를 만들지 않게 지시한다. 로컬 초안은 녹취를 저장해 재생성에도 같은 입력을 사용한다. Claude ON일 때 전달되는 것은 사진·녹취 텍스트이며, 원음은 로컬 전사 서버가 처리한다. 실제 마이크 녹음·타인 대화 전송 없이 모의 오디오 및 전사·카드 API로 검증한다.


### 공개 관리자 인증 추가

앞선 로컬 전용 Claude 전환 제한을 확장했다. `/api/ai-settings`는 `editable`, `requiresAdmin`, `adminAvailable`만 추가로 알려주며 비밀값은 반환하지 않는다. `POST /api/admin/login`은 `{token}`으로 별도 관리자 접근 코드를 확인한 뒤 8시간의 보안 세션 쿠키를 설정하고, `POST /api/admin/logout`은 세션을 폐기한다. 공개 설정 변경은 이 세션과 정확한 Origin이 모두 필요하다. 공개 `/publish` 화면에서도 관리자 인증 후 초안 조회·생성·수정·Instagram 게시 및 계정 연결을 사용할 수 있다. 변경 요청에는 `https://n.joun.cc` Origin이 필요하다. 인증 없는 접근과 기존 재귀 세션 접근 제한은 유지한다.

### 실물 피에조 단계 수신

`POST /api/piezo`에 `Content-Type: application/json`, `Authorization: Bearer <OBSERVATION_TOKEN>`과 아래 본문을 보냅니다. 사진이나 텍스트 없이 센서 단계만 전달할 수 있습니다.

```json
{ "piezoLevel": 1 }
```

- 숫자 `0`, `1`, `2`를 받습니다. 문자열은 거부합니다.
- 기본 단계는 0입니다. 1·2 수신 시 해당 단계로 바꾸고 **서버 수신 시각부터 5분** 유지합니다.
- 1·2를 다시 받으면 새 단계로 바꾸고 5분을 다시 셉니다. 0 수신은 유지 시간을 취소하거나 연장하지 않습니다.
- 서버에 만료 시각을 저장하므로 새로고침·서버 재시작에도 남은 시간이 유지됩니다. 만료 후 단계는 0입니다.
- 기존 `POST /api/observations`의 `sensors.piezoLevel`도 같은 동작을 합니다. 동일 eventId 재전송은 시간을 연장하지 않습니다.
- 홈 자동 생성은 요청 시점의 서버 센서 단계를 사용합니다. 생성 중 새 신호가 오면 다음 생성에 적용합니다. 수동 관리자 생성의 단계 선택은 기존대로 유지합니다.
- `GET /api/publishing/status`의 `piezo`는 `{ level, expiresAt }`입니다. `expiresAt`은 Unix 밀리초이며 기본/만료 상태에서는 null입니다.

## 서버 자동 게시 (2026-11-06)

기본 화면과 `/poc`는 모니터입니다. 브라우저와 관계없이 Node 서버가 수신 → 카드뉴스 4장 생성 → Instagram 게시를 수행합니다. 연결 설정·오류 복구는 모니터의 관리자 영역에서 합니다. 수동 생성·검토·게시 화면은 제거했습니다. 기존 `/publish` 주소는 모니터로 연결됩니다. 서버, 선택한 AI 서비스와 이미지 합성 환경은 실행 중이어야 합니다.

기존 주소와 Bearer 인증을 그대로 사용합니다.

1. `POST /api/observations`로 고유한 `eventId`와 사진을 보냅니다. 사진은 JPEG·PNG·WebP data URL입니다.
2. `POST /api/transcripts`로 `{ "interactionId": "사진 eventId", "startedAt": "2026-11-07T00:00:00.000Z", "endedAt": "2026-11-07T00:00:20.000Z", "text": "해당 20초의 최종 전사" }`를 보냅니다. 텍스트가 먼저 와도 됩니다. `cam`은 얼굴 감지 시 사진과 20초 녹음을 독립 시작하고 녹음·변환 완료 후 최종 전사를 한 번 전송합니다. 시각은 녹음 구간을 나타내며 20초 수집 자체는 `cam`의 책임입니다.
3. 텍스트는 수신 기록으로 계속 저장하되, 사진의 `eventId`와 `interactionId`가 같은 최종 전사만 생성 프롬프트에 넣습니다. 시간순으로 쌓인 과거 기록이나 다른 촬영의 대화를 합치지 않습니다. 사진만으로 시간 초과 후 생성하지 않습니다.
4. 생성·게시 중 사진은 409로 거절합니다. 텍스트는 계속 저장하며 이후 같은 ID의 사진이 수신될 때만 결합합니다. 관리자 수신 화면에는 전체 기록을 시간순으로 표시합니다. 같은 ID·텍스트·녹음 구간 재전송은 기존 수신 ID를 반환하고, 같은 ID의 다른 내용·구간은 409로 거절합니다.
5. `GET /api/mobile/publications`의 `automation.accepting`은 사진 수신 가능 여부입니다. 텍스트는 이 값이 false여도 전송할 수 있습니다. ID·녹음 구간 없이 보내던 기존 `{ "text": "..." }` 요청은 기록·표시용이며 자동 생성을 시작하지 않습니다. ID와 녹음 구간은 세 필드를 함께 전달해야 합니다.
6. 수신 사진의 `eventId`로 기존 단건 상태 API와 SSE를 사용하면 생성 진행과 게시 완료를 받습니다. 사진만 받은 상태는 `received`입니다.

게시 성공 시 사용한 입력을 처리 완료하고 다음 새 사진·텍스트를 기다립니다. 다른 촬영의 텍스트나 ID가 없는 과거 기록은 자동 생성에 포함하지 않습니다. 이미 수신한 사진 eventId는 다시 받지 않아 같은 최종 전사의 재전송으로 중복 게시하지 않습니다. 생성 실패, 연결 오류, 게시 결과 불명확, 처리 중 재시작은 `halted`로 멈춥니다. Instagram과 저장 상태를 확인하고 모니터 하단의 **관리자** 영역에서 **게시 여부 확인 완료 · 새 입력 수신 재개**를 누르세요. 대기 입력을 비우며 이전 작업은 자동 재게시하지 않습니다.

운영 상태는 `data/automation/state.json`에 저장합니다(`AUTOMATION_STATE_FILE`로 변경 가능). 서버 프로세스 한 개가 수신을 담당하는 로컬 운영 구조입니다. 상태 조회는 원본 텍스트·사진을 포함하지 않습니다. 관리자 `GET /api/publishing/status`에도 같은 `automation` 상태가 포함됩니다. 관리자 `POST /api/publishing/status`는 수신 재개용이며 기존 공개 관리자 인증·Origin 검증을 적용합니다.

### AI 공급자 고정

AI 분석·텍스트 생성은 Claude API 전용입니다. `ANTHROPIC_API_KEY`가 필요하며 `CLAUDE_MODEL`로 기존 모델 설정을 사용합니다. `TEXT_PROVIDER`나 `data/ai-settings.json`의 OFF 값은 더 이상 영향을 주지 않습니다. 로컬 Ollama 서비스는 이 자동 게시 흐름에 필요하지 않습니다. 카드 이미지 합성용 Python/Pillow는 유지합니다. 키 누락 또는 Claude 오류 시 자동 처리는 중단하며 로컬 모델로 대체하지 않습니다.

### 자동 처리 중단 후 재개 API

`POST /api/publishing/restart` (본문 없음)는 새 입력과 중복 재개 요청을 409로 차단하고, 진행 중인 자동 생성을 취소한 뒤 해당 작업 종료를 기다립니다. 이미 전송된 Instagram 게시 요청은 결과를 확정할 때까지 기다립니다. 기존 게시물은 삭제하거나 재게시하지 않습니다.

완료 시 대기 중 사진·텍스트와 이벤트 참조를 비우고 사진부터 새로 수신합니다. 응답은 `200 { "automation": { "status": "waiting", "accepting": true, "hasPhoto": false, "hasTranscript": false, "eventId": null, "error": null } }`입니다. 다른 수동 작업이나 입력 수신이 진행 중이면 409입니다. 공개 사이트에서는 관리자 세션과 올바른 Origin이 필요합니다. `GET` 등 다른 메서드는 405입니다.
