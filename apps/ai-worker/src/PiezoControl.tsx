import { PIEZO_LABELS, type PiezoLevel } from './publishing';
export function PiezoControl({ value, onChange, disabled = false }: { value: PiezoLevel; onChange: (value: PiezoLevel) => void; disabled?: boolean }) {
  return <fieldset className="piezo-control" disabled={disabled}>
    <legend>피에조 단계 설정</legend>
    <div className="piezo-options">{PIEZO_LABELS.map((label, level) => <label key={level} className={value === level ? 'selected' : ''}>
      <input type="radio" name="piezo-level" value={level} checked={value === level} onChange={() => onChange(level as PiezoLevel)} />
      <strong>{level}단계</strong><span>{label}</span>
    </label>)}</div>
    <p>선택하면 즉시 적용하며, 이후 생성되는 카드뉴스에 사용합니다. 자동 처리 종료, 수신 재개, 새로 시작 시 0단계로 돌아갑니다. 1·2단계는 최대 5분 동안 유지되며, 새 센서 신호가 들어오면 변경될 수 있습니다.</p>
  </fieldset>;
}
