# AI 서비스 이관

robot-api 모노레포에 기존 사진·기사·카드뉴스·Instagram 처리 앱을 `apps/ai-worker`로 이관했다. 첫 단계에서는 처리 로직과 관리 화면을 보존하고 실행 위치와 요청 경로를 변경한다. 기존 자료와 실제 비밀 값은 포함하지 않는다.

## 구성

- `frontend` (8080): `/`는 로봇 얼굴·카메라, `/admin/`은 AI 모니터·관리자 화면. 모든 API는 backend로 전달한다.
- `backend` (내부 3000): 기존 로봇·센서 API와 AI 게이트웨이. 전송 토큰을 서버에서 붙이고 JSON·이미지·SSE·관리 쿠키를 전달한다.
- `ai-worker` (내부 3002): Claude 분석, Python/Pillow 합성, 자동 게시, 작업 상태 저장. 외부 포트를 열지 않는다.

사진 → backend → ai-worker → Claude/합성/Instagram. 결과와 SSE는 같은 경로로 돌아온다. 작업 상태와 원본은 ai-data 볼륨에 보관한다. 기존 단일 처리·추가 입력 거절·실패 확인 대기 정책을 유지한다. 큐, 별도 DB, 자동 재시도는 추가하지 않는다.

현재 워커는 기존 HTTP API와 상태 저장을 포함한 독립 서비스다. 입력·상태 소유권을 backend로 완전히 옮기는 리팩터링은 이후 단계다. 기존 /capture의 Whisper와 레거시 ComfyUI 기능은 코드만 보존하며 해당 로컬 서비스는 Compose에 포함하지 않는다. 현재 카드뉴스 경로는 Claude와 Pillow만 사용한다.

## 홈서버 설정

1. 레포 루트에서 `cp .env.example .env` 후 빈 값을 채운다. `OBSERVATION_TOKEN`과 `ADMIN_ACCESS_TOKEN`은 서로 다른 임의 값으로 만든다 (`openssl rand -hex 32`). Claude 키와도 구분한다. 브라우저용 VITE_* 키는 필요 없다.
2. 실제 도메인이 다르면 `AI_ALLOWED_ORIGINS`, `AI_ADMIN_ORIGINS`, `INSTAGRAM_REDIRECT_URI`, `INSTAGRAM_MEDIA_ORIGIN`을 변경한다. Origin에는 경로와 마지막 슬래시를 넣지 않는다.
3. 기존 Docker의 외부 `proxy` 네트워크와 `/mnt/data/cam` 로봇 데이터 경로를 유지한다. 네트워크가 없다면 기존 프록시 구성을 확인하고 생성한다.
4. `docker compose config --quiet`로 검사한 후 `docker compose up -d --build`로 실행한다.
5. 기존 리버스 프록시에서 로봇 도메인을 홈서버 8080으로 연결한다. `https://n.joun.cc/`에서 로봇 화면, `https://n.joun.cc/admin/`에서 AI 관리 화면이 열린다. 별도 모니터 포트나 도메인은 필요 없다. HTTPS를 사용한다. **8080 전체 서비스는 기존처럼 Tailscale 내부 접근으로 제한한다.** 브라우저 전송 토큰을 없앴으므로 게이트웨이의 접근 경계가 tailnet이다. 공개 로봇 서비스가 필요하면 별도 사용자/장치 인증부터 추가해야 한다.
6. Instagram이 읽어야 하는 `GET /api/publish-images/*`와 OAuth 콜백 `/api/instagram/callback`만 같은 HTTPS 도메인에서 외부 접근 가능하도록 프록시를 구성한다. 원본 파일이나 data 폴더는 공개하지 않는다. 공개 기사 화면이 필요하면 공개 경로를 따로 검토한다.
7. Meta 앱에 `.env`의 정확한 콜백 URL을 등록한다. AI 관리 화면에서 관리자 코드로 로그인한 뒤 Instagram 계정을 연결한다. ENV 입력만으로 OAuth 사용자 동의까지 생략되지는 않는다.

필수 키가 없어도 서버는 기동하지만 생성·게시 기능은 설정 오류를 반환한다. `/health`는 프로세스 생존 검사이며 Claude 키·Meta 권한까지 검증하지 않는다. `docker compose logs ai-worker backend`에서 실행 상태를 확인한다. `docker compose config`는 값이 출력될 수 있어 공유하지 않는다.

## 기존 데이터 이관과 전환

새 환경은 빈 볼륨으로 시작한다. 기존 게시 이력·연결 정보를 유지하려면 다음 순서를 따른다.

1. 기존 서비스의 신규 수신을 멈추고 진행 중 게시가 종료되었는지 확인한다. 처리 중인 채로 두 서비스를 동시에 실행하지 않는다.
2. 기존 프로젝트의 `data/` 전체를 백업한다. `.env`는 별도 보관하며 Git에 넣지 않는다.
3. 새 서비스를 만든 뒤 ai-worker를 중지하고 `data/` 내용을 ai-data 볼륨의 `/app/data`에 복사한다. 컨테이너 사용자 node(UID 1000)가 읽고 쓸 수 있게 권한을 맞춘다.
4. Instagram 연결 파일을 옮긴 경우 기존 `META_APP_SECRET`을 유지해야 복호화된다. 앱 설정·콜백 URL이 바뀌면 계정을 다시 연결한다.
5. 새 워커 한 개만 시작하고 모니터에서 상태를 확인한다. 재시작 시 확인 대기 상태는 관리자가 확인 후 해제한다. 결과 불명확 게시를 재전송하지 않는다.
6. 도메인을 전환한 후 사진·텍스트 수신, 40초 텍스트 대기, 게시 상태 SSE, 실제 게시 1건을 확인한다. 이전 서비스를 다시 켜야 한다면 먼저 새 워커를 중지한다.

실제 데이터 복사, 도메인 전환, Meta 연결과 실제 게시 검증은 운영 단계다. 이 코드 이관으로 자동 실행되지 않는다.

## 로컬 검증과 개발

```sh
npm ci
npm run build
npm run test:integration
npm run test:ai
```

개발 시 backend 프로세스에 `AI_WORKER_URL=http://127.0.0.1:3002`, `OBSERVATION_TOKEN`, `AI_ALLOWED_ORIGINS`를 전달한다. 워커의 로컬 `.env`는 루트 예제를 참고해 직접 만들고 같은 전송 토큰을 사용한다. `npm run dev:ai`는 관리 화면 개발 서버(5174, `/admin/`)와 워커(3002)를 함께 실행한다. 로봇 프런트의 `/admin/` 요청도 이 서버로 전달한다. `npm run dev`는 기존 로봇 프런트와 백엔드만 실행한다. Docker 실행 시에는 루트 `.env` 하나를 사용한다.
