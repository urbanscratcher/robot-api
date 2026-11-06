// 관리자 패널의 "사진 찍기" 버튼이 관찰 기록(사진)을 보낼 주소.
// 실제 API는 https://h.joun.cc/api/observations 이지만, h.joun.cc가 n.joun.cc를 CORS로 허용하지 않아서
// 같은 서버 경로로 보내고 nginx.conf(배포)·vite.config.ts(개발)가 h.joun.cc로 넘겨줍니다.
// h.joun.cc가 https://n.joun.cc 를 허용하게 되면 여기에 전체 주소를 넣어도 됩니다.
export const OBSERVATION_URL = '/api/observations'

// Bearer 토큰은 코드에 적지 않고 apps/frontend/.env.local 의 VITE_OBSERVATION_TOKEN 에서 읽습니다.
// .env.local 은 git에 올라가지 않습니다(*.local). 빌드된 JS에는 포함되니 공개 사이트에서는 주의하세요.
export const OBSERVATION_TOKEN = import.meta.env.VITE_OBSERVATION_TOKEN ?? ''

// 휴대폰에서 글자로 바꾼 대화를 보낼 주소. 몸통: { "text": "..." }  (토큰은 위와 같음)
export const TRANSCRIPT_URL = '/api/transcripts'

// 기사 작성/인스타그램 게시 상태와 SSE 알림을 조회하는 기본 경로.
export const PUBLICATIONS_URL = '/api/mobile/publications'

// 사람 인식. 사람이 연속으로 보이면 취재를 시작한다.
export const AUTO_CAPTURE = {
  intervalMs: 500,        // 0.5초마다 카메라를 본다
  minScore: 0.4,          // 사람이라고 볼 확신도 (0~1). 얼굴만 가까이 보이면 0.5 근처로 낮게 나온다
  minAreaRatio: 0.03,     // 사람이 화면의 3% 이상 차지해야 함 (멀리 지나가는 사람 제외)
  arriveChecks: 2,        // 연속 2번(약 1초) 보여야 시작
}

// 취재 한 번: 사진 1장(시작할 때) + 10초 동안 들은 말 전체.
// 사진을 더 찍으려면 [0, 4000, 8000]처럼 찍을 시각(ms)을 더 넣는다.
export const VISIT = {
  photoDelaysMs: [0],
  maxListenMs: 10000,
}

// eventId 앞부분: camera-1-20261106-001
export const CAMERA_ID = 'camera-1'
