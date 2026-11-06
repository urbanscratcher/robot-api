export type Expression = 'happy' | 'surprised' | 'thinking' | 'hurt'

interface RobotFaceProps {
  expression: Expression
  recording?: boolean
}

function PixelFeatures({ expression, recording }: RobotFaceProps) {
  if (recording) return (
    <g className="pixel-features pixel-features-recording">
      <path d="M9 7h5v2H9zM18 7h5v2h-5zM10 10h3v3h-3zM19 10h3v3h-3z" />
      <path d="M10 16h2v-1h2v1h4v-1h2v1h2v3H10z" />
      <path className="pixel-cutout" d="M13 17h2v1h-2zM17 17h2v1h-2z" />
    </g>
  )

  if (expression === 'surprised') return (
    <g className="pixel-features">
      <path d="M9 7h2V6h2v1h2v5H9zM17 7h2V6h2v1h2v5h-6z" />
      <path d="M12 15h8v6h-8z" />
      <path className="pixel-cutout" d="M14 17h4v2h-4z" />
    </g>
  )

  if (expression === 'thinking') return (
    <g className="pixel-features">
      <path d="M8 8h6v2H8zM19 7h3v6h-3zM24 5h2v2h-2zM26 3h2v2h-2z" />
      <path d="M11 17h3v-1h7v2h-7v1h-3z" />
    </g>
  )

  if (expression === 'hurt') return (
    <g className="pixel-features">
      <path d="M8 6h2v2h2V6h2v2h-2v2h2v2h-2v-2h-2v2H8v-2h2V8H8zM18 6h2v2h2V6h2v2h-2v2h2v2h-2v-2h-2v2h-2v-2h2V8h-2z" />
      <path d="M10 16h2v-1h2v1h4v-1h2v1h2v3h-2v1h-2v-1h-4v1h-2v-1h-2z" />
    </g>
  )

  return (
    <g className="pixel-features">
      <path d="M10 7h3v6h-3zM19 7h3v6h-3z" />
      <path d="M11 17h2v1h6v-1h2v2h-2v1h-6v-1h-2z" />
    </g>
  )
}

export function RobotFace({ expression, recording = false }: RobotFaceProps) {
  return (
    <div
      className={`robot-face pixel-robot-face expression-${expression}${recording ? ' is-recording' : ''}`}
      aria-label={`Robot expression: ${expression}${recording ? ' (recording)' : ''}`}
    >
      <svg className="pixel-face-svg" viewBox="0 0 32 24" role="img" aria-hidden="true" shapeRendering="crispEdges">
        <path
          className="pixel-head"
          d="M8 1h16v1h3v2h2v3h2v10h-2v3h-2v2h-3v1H8v-1H5v-2H3v-3H1V7h2V4h2V2h3z"
        />
        <PixelFeatures expression={expression} recording={recording} />
      </svg>
    </div>
  )
}
