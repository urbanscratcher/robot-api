export type Expression = 'happy' | 'surprised' | 'thinking' | 'hurt'

interface RobotFaceProps {
  expression: Expression
  recording?: boolean
}

type MouthShape = 'cat' | 'thinking' | 'wobble' | 'o' | 'grin'

function Mouth({ shape }: { shape: MouthShape }) {
  const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
  return (
    <svg className={`mouth mouth-${shape}`} viewBox="0 0 120 60" aria-hidden="true">
      {shape === 'cat' && <path {...line} d="M27 21 Q43 42 60 25 Q77 42 93 21" />}
      {shape === 'thinking' && <path {...line} d="M31 28 Q47 19 62 29 Q77 38 91 27" />}
      {shape === 'wobble' && <path {...line} d="M25 31 Q36 18 47 31 T69 31 T91 31" />}
      {shape === 'o' && <ellipse cx="60" cy="31" rx="11" ry="14" fill="none" stroke="currentColor" strokeWidth="6" />}
      {shape === 'grin' && (
        <>
          <path d="M18 15 Q60 64 102 15 Q60 30 18 15 Z" fill="currentColor" />
          <path
            d="M27 20 L34 29 L42 22 L51 33 L60 24 L69 33 L78 22 L86 29 L93 20"
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
    : expression === 'hurt'
      ? 'wobble'
      : expression === 'thinking'
        ? 'thinking'
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
