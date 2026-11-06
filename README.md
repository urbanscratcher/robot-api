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

## 숨겨진 관리자 패널

화면 **왼쪽 위 모서리를 3번 빠르게 탭**하면 관리자 패널이 열립니다. 기본 화면에는 진입 방법이나 버튼이 표시되지 않습니다. 패널에서 전면 카메라 실시간 영상과 권한 상태를 확인하고, 카메라를 재시작하거나 전체화면을 요청할 수 있습니다.

이 진입 방식은 현장에서 실수로 패널이 열리는 것을 막기 위한 숨김 기능이며 사용자 인증을 대신하지 않습니다. Tailscale tailnet 외부에는 서비스가 공개되지 않도록 유지하세요.

## 프로덕션 확인

```bash
npm run build
docker compose config
```

범위에서 의도적으로 제외한 기능: AI/Ollama, 업로드, 음성, Arduino 제어, 로그인, 데이터베이스.
