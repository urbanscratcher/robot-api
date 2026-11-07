# ROBOT FACE MONOREPO

가로로 장착한 iPhone을 이동형 로봇의 얼굴로 사용하는 React 프론트엔드와, 향후 로봇 기능을 연결할 Node.js API를 함께 관리하는 TypeScript 모노레포입니다. 평소에는 웃는 표정을 유지하고, 화면을 탭하면 짧은 글리치 뒤 녹음이 재생되는 동안 아픈 표정으로 바뀝니다.

## 프로젝트 구조

```text
apps/
├── frontend/  # React + Vite UI, Nginx 설정과 Dockerfile
└── backend/   # Node.js TypeScript API와 Dockerfile
```

루트의 npm workspaces가 두 앱의 의존성과 명령을 관리합니다. 개발 환경에서는 Vite가 `/api`를 `localhost:3000`으로 전달하고, Docker 환경에서는 프론트 Nginx가 같은 경로를 `backend:3000`으로 전달합니다.

일반 얼굴 화면을 탭하면 `public/audio`에 포함된 사용자 녹음 5개 중 하나를 무작위로 재생합니다. 바로 직전에 나온 녹음은 연속으로 다시 선택하지 않습니다. 소리가 들리지 않으면 iPhone의 음량과 무음 모드 설정을 확인하세요.

## 로컬 개발

Node.js 20 이상이 필요합니다.

```bash
npm install
npm run dev
```

프론트엔드는 `http://localhost:5173`, 백엔드는 `http://localhost:3000`에서 실행됩니다. 각각만 실행하려면 `npm run dev:frontend` 또는 `npm run dev:backend`를 사용하세요. 백엔드 연결은 `GET /api/health`로 확인할 수 있습니다.

개발 서버에서는 오른쪽 아래에 카메라 상태가 표시됩니다. 프로덕션 빌드에서는 이 표시가 제거됩니다.

## 프레임 캡처

`apps/frontend/src/hooks/useCamera.ts`의 `useCamera()`가 `captureFrame(): Promise<Blob | null>`을 제공합니다. 현재 앱은 향후 연동을 위해 같은 함수를 `window.captureFrame()`에도 노출합니다. 카메라 프레임을 읽을 수 없으면 `null`, 준비되면 JPEG `Blob`을 반환하며 서버로 전송하지 않습니다.

## Docker 배포

```bash
docker compose up -d --build
docker compose ps
curl -I http://localhost:8080
```

Compose는 `frontend`와 `backend` 컨테이너를 함께 빌드합니다. 외부에는 프론트 Nginx만 호스트의 8080번으로 노출되고 백엔드는 내부 Docker 네트워크에서 연결됩니다. 기존 리버스 프록시에서 `http://lab:8080`으로 프록시하고 TLS 인증서를 적용하세요.

카메라와 Wake Lock은 보안 컨텍스트가 필요하므로 iPhone에서는 반드시 HTTPS 도메인으로 접속해야 합니다. `localhost` 예외는 iPhone에서 원격 홈서버에 적용되지 않습니다.

## iPhone Safari 테스트

1. iPhone에서 HTTPS 주소를 Safari로 엽니다.
2. iPhone을 가로로 놓고 화면을 한 번 탭합니다.
3. 카메라 권한에서 **허용**을 선택합니다. 거부해도 얼굴과 표정 전환은 계속 작동합니다.
4. 탭할 때 네 가지 표정이 순서대로 바뀌는지 확인합니다.
5. Safari 공유 메뉴의 **홈 화면에 추가**를 선택하고, 생성된 아이콘으로 실행해 브라우저 UI가 없는 standalone 모드를 확인합니다.
6. 앱을 잠시 백그라운드로 보냈다가 돌아와 눈 애니메이션과 카메라가 복구되는지 확인합니다.

iOS는 웹페이지의 화면 방향 강제를 허용하지 않으므로 기기를 가로로 장착해야 합니다. iOS 설정의 자동 잠금 정책이나 저전력 모드에 따라 Wake Lock 요청이 무시될 수 있습니다.

## 피에조 값 → 놀라거나 아파하는 얼굴

ESP32가 피에조 값을 감지하면 아래처럼 요청하면 됩니다. 300 이하는 놀란 표정으로, 그보다 큰 값은 글리치 + 아픈 표정 + 녹음 재생으로 반응합니다.

```
POST https://n.joun.cc/api/hurt
Content-Type: application/json      (본문은 선택)

{"level": 812}
```

- `300` 이하: 놀란 표정 (`surprised`)
- `301` 이상 `800` 미만: 1단계 (`weak`)
- `800` 이상: 2단계 (`strong`)

- 응답: `{"ok":true,"listeners":1}`. `listeners`는 지금 연결된 얼굴 페이지 수입니다. 0이면 페이지가 열려 있지 않은 것입니다.
- 0.3초 안에 다시 오면 한 번으로 칩니다(`"skipped":"cooldown"`).
- `HURT_TOKEN` 환경변수를 설정하면 `Authorization: Bearer <토큰>`이 필요합니다. 설정하지 않으면 누구나 부를 수 있습니다.
- 페이지는 `GET /api/events`(Server-Sent Events)로 신호를 받습니다. 관리자 패널 위쪽에 `피에조 연결됨`이 보이면 정상입니다.
- iPhone은 화면을 한 번 터치해야 소리를 낼 수 있습니다. 페이지를 연 뒤 얼굴을 한 번 탭해 두세요. 탭하기 전에도 표정은 바뀝니다.

## 촬영 중 로봇 멈춤

얼굴 페이지가 사람을 보고 취재(촬영)를 시작하면 로봇을 잠깐 세우고, 인스타 게시가 끝나면(또는 게시 관리자에게 넘어가거나 실패하면) 다시 출발시킵니다. 관리자 패널의 주행 켜짐/꺼짐 스위치와는 따로 동작합니다. 스위치가 꺼져 있으면 게시가 끝나도 출발하지 않습니다.

```
POST https://n.joun.cc/api/robot/hold
Content-Type: application/json

{"hold": true, "reason": "capture"}   # 멈춤 (maxMs 로 최대 시간 지정 가능)
{"hold": false}                       # 다시 출발
```

- `GET /api/robot` 응답에 `hold`, `holdReason`, `holdUntil`, `shouldDrive`(실제로 달려야 하는지)가 포함됩니다. ESP32는 `"hold":true`이면 바퀴만 멈춥니다(센서는 계속 동작).
- 해제 신호가 오지 않아도 `ROBOT_HOLD_MAX_MS`(기본 10분)가 지나면 저절로 풀립니다. 서버를 다시 시작해도 풀린 상태로 시작합니다.
- 다른 서비스에서도 같은 주소로 멈춤/해제를 보낼 수 있습니다.

## 숨겨진 관리자 패널

화면 **왼쪽 위 모서리를 3번 빠르게 탭**하면 관리자 패널이 열립니다. 기본 화면에는 진입 방법이나 버튼이 표시되지 않습니다. 패널에서 전면 카메라 실시간 영상과 권한 상태를 확인하고, 카메라를 재시작하거나 전체화면을 요청할 수 있습니다.

카메라와 사람 인식은 앱이 열릴 때 자동으로 시작하며 관리자 패널을 닫아도 계속 작동합니다. 최초 카메라 권한 요청이 자동 시작을 막는 브라우저에서는 얼굴 화면을 한 번 탭하면 다시 시도합니다.

이 진입 방식은 현장에서 실수로 패널이 열리는 것을 막기 위한 숨김 기능이며 사용자 인증을 대신하지 않습니다. Tailscale tailnet 외부에는 서비스가 공개되지 않도록 유지하세요.

## 프로덕션 확인

```bash
npm run build
docker compose config
```

범위에서 의도적으로 제외한 기능: AI/Ollama, 업로드, 음성, Arduino 제어, 로그인, 데이터베이스.

## AI 처리 서비스

기존 사진·텍스트 수신과 게시 상태 요청은 이제 외부 AI 서버 대신 같은 Compose의 `ai-worker`로 전달됩니다. `apps/ai-worker`에 기존 처리 코드와 관리 화면을 보존했습니다. 브라우저에 `VITE_OBSERVATION_TOKEN`을 넣지 않으며 backend가 서버 전송 토큰을 사용합니다.

루트 `.env.example`을 `.env`로 복사해 키와 도메인을 입력하세요. 같은 도메인에서 `/`는 로봇 화면, `/admin/`은 AI 모니터·관리자 화면입니다. 외부 프록시는 기존 8080 포트만 연결하면 됩니다. 도메인 연결, Meta 계정 연결과 기존 데이터 복사 절차는 [AI 서비스 이관 안내](docs/ai-service-migration.md)를 따르세요. 실제 키와 운영 데이터는 레포에 포함하지 않습니다.
