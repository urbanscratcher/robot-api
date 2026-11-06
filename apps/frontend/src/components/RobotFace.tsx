export type Expression = 'happy' | 'surprised' | 'thinking' | 'hurt'

interface RobotFaceProps {
  expression: Expression
  recording?: boolean
}

const line = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 3.2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

function ShinyEye({ x, y = 21 }: { x: number; y?: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r="7.2" fill="currentColor" />
      <circle cx={x - 2.3} cy={y - 2.5} r="2" fill="#fff" />
      <circle cx={x + 1.4} cy={y + 1.3} r="1" fill="#fff" opacity=".9" />
    </g>
  )
}

function Cheeks() {
  return (
    <g className="emoji-cheeks">
      <ellipse cx="25" cy="37" rx="7" ry="3.2" />
      <ellipse cx="75" cy="37" rx="7" ry="3.2" />
    </g>
  )
}

function Features({ expression, recording }: RobotFaceProps) {
  if (recording) return (
    <>
      <path {...line} d="M19 13l14-5M67 8l14 5" />
      <ShinyEye x={28} y={24} /><ShinyEye x={72} y={24} />
      <Cheeks />
      <path d="M36 40 Q50 55 64 40 Q50 44 36 40Z" fill="currentColor" />
      <path d="M42 47 Q50 42 58 47 Q50 52 42 47Z" fill="#ff8eaa" />
    </>
  )

  if (expression === 'surprised') return (
    <>
      <ShinyEye x={28} /><ShinyEye x={72} />
      <Cheeks />
      <ellipse cx="50" cy="43" rx="8" ry="10" fill="currentColor" />
      <path d="M44 47 Q50 42 56 47 Q50 52 44 47Z" fill="#ff8eaa" />
    </>
  )

  if (expression === 'thinking') return (
    <>
      <ShinyEye x={28} />
      <path {...line} d="M65 23q7-8 14 0" />
      <Cheeks />
      <path {...line} d="M41 43q9-7 18 0" />
      <circle cx="82" cy="11" r="2.2" fill="currentColor" />
    </>
  )

  if (expression === 'hurt') return (
    <>
      <path {...line} d="M20 17l13 9M33 17l-13 9M67 17l13 9M80 17l-13 9" />
      <Cheeks />
      <path {...line} d="M37 47q6-8 13 0q7-8 13 0" />
    </>
  )

  return (
    <>
      <ShinyEye x={28} /><ShinyEye x={72} />
      <Cheeks />
      <path {...line} d="M37 39q13 15 26 0" />
    </>
  )
}

export function RobotFace({ expression, recording = false }: RobotFaceProps) {
  return (
    <div
      className={`robot-face emoji-robot-face expression-${expression}${recording ? ' is-recording' : ''}`}
      aria-label={`Robot expression: ${expression}${recording ? ' (recording)' : ''}`}
    >
      <svg className="emoji-face-svg" viewBox="0 0 100 62" aria-hidden="true">
        <Features expression={expression} recording={recording} />
      </svg>
    </div>
  )
}
