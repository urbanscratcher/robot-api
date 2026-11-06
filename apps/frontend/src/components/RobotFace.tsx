export type Expression = 'idle' | 'curious' | 'happy' | 'surprised' | 'thinking' | 'hurt'

interface RobotFaceProps {
  expression: Expression
  // 취재(사진·녹음) 중이면 반전: 빨간 눈 + 치켜 올라간 눈썹 + 톱니 이빨로 씩 웃는 입.
  // 앞에 있는 사람에게 지금 녹화(엿듣기) 중임을 알린다.
  recording?: boolean
}

type MouthShape = 'cat' | 'wobble' | 'o' | 'grin'

function Mouth({ shape }: { shape: MouthShape }) {
  const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
  return (
    <svg className={`mouth mouth-${shape}`} viewBox="0 0 120 60" aria-hidden="true">
      {shape === 'cat' && <path {...line} d="M10 16 Q35 52 60 22 Q85 52 110 16" />}
      {shape === 'wobble' && <path {...line} d="M14 30 q11.5 -15 23 0 t23 0 t23 0 t23 0" />}
      {shape === 'o' && <ellipse cx="60" cy="30" rx="13" ry="17" fill="currentColor" />}
      {shape === 'grin' && (
        <>
          <path d="M6 8 Q60 78 114 8 Q60 26 6 8 Z" fill="currentColor" />
          <path
            d="M14 12 L21 25 L28 15 L36 30 L44 18 L52 33 L60 20 L68 33 L76 18 L84 30 L92 15 L99 25 L106 12"
            fill="none"
            stroke="#000"
            strokeWidth="4"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  )
}

export function RobotFace({ expression, recording = false }: RobotFaceProps) {
  const mouth: MouthShape = recording
    ? 'grin'
    : expression === 'hurt' || expression === 'thinking'
      ? 'wobble'
      : expression === 'surprised'
        ? 'o'
        : 'cat'
  return (
    <div
      className={`robot-face expression-${expression}${recording ? ' is-recording' : ''}`}
      aria-label={`Robot expression: ${expression}${recording ? ' (recording)' : ''}`}
    >
      <div className="eyes" aria-hidden="true">
        <div className="eye-slot eye-slot-left">
          <span className="brow" />
          <div className="eye eye-left"><span className="eye-shine" /></div>
          <span className="cheek" />
        </div>
        <div className="eye-slot eye-slot-right">
          <span className="brow" />
          <div className="eye eye-right"><span className="eye-shine" /></div>
          <span className="cheek" />
        </div>
      </div>
      <Mouth shape={mouth} />
    </div>
  )
}
