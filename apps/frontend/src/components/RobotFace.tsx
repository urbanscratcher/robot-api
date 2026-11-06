export type Expression = 'idle' | 'curious' | 'happy' | 'surprised' | 'hurt'

interface RobotFaceProps {
  expression: Expression
  // 취재(사진·녹음) 중이면 눈이 빨갛게 바뀌어 앞에 있는 사람에게 녹화 중임을 알린다.
  recording?: boolean
}

export function RobotFace({ expression, recording = false }: RobotFaceProps) {
  return (
    <div
      className={`robot-face expression-${expression}${recording ? ' is-recording' : ''}`}
      aria-label={`Robot expression: ${expression}${recording ? ' (recording)' : ''}`}
    >
      <div className="eyes" aria-hidden="true">
        <div className="eye eye-left"><span className="eye-shine" /></div>
        <div className="eye eye-right"><span className="eye-shine" /></div>
      </div>
    </div>
  )
}
