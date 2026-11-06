export type Expression = 'idle' | 'curious' | 'happy' | 'surprised' | 'hurt'

interface RobotFaceProps {
  expression: Expression
}

export function RobotFace({ expression }: RobotFaceProps) {
  return (
    <div className={`robot-face expression-${expression}`} aria-label={`Robot expression: ${expression}`}>
      <div className="eyes" aria-hidden="true">
        <div className="eye eye-left"><span className="eye-shine" /></div>
        <div className="eye eye-right"><span className="eye-shine" /></div>
      </div>
    </div>
  )
}
