import { useState } from 'react';
import { Mic, Square, Trash2 } from 'lucide-react';
import type { useConversation } from './useConversation';

export function ConversationInput({ conversation, disabled = false }: { conversation: ReturnType<typeof useConversation>; disabled?: boolean }) {
  const [consent, setConsent] = useState(false);
  const active = conversation.recording !== 'off';
  return <section className="conversation-input" aria-label="10초 대화 녹음">
    <h2>대화 녹음 (선택)</h2>
    <p>마이크를 켜면 10초 뒤 자동 종료합니다. 녹취를 확인한 후 사진과 함께 카드뉴스에 반영합니다.</p>
    <label className="review-check"><input type="checkbox" checked={consent} disabled={disabled || active || conversation.pending} onChange={event => setConsent(event.target.checked)} />대화 참여자 모두 녹음과 음성의 서버 전사 처리에 동의했습니다.</label>
    <div className="conversation-actions">
      {active ? <button type="button" disabled={conversation.recording === 'finishing'} onClick={conversation.stop}><Square size={16} />{conversation.recording === 'requesting' ? '마이크 요청 취소' : conversation.recording === 'finishing' ? '녹음 마무리 중…' : `녹음 종료 · ${Math.min(conversation.elapsed, 10)} / 10초`}</button>
        : <button type="button" disabled={disabled || !consent || conversation.pending} onClick={() => void conversation.start()}><Mic size={16} />10초 녹음 시작</button>}
      {!!conversation.clips.length && <button type="button" disabled={disabled || active} onClick={conversation.clear}><Trash2 size={16} />녹취 전체 삭제</button>}
    </div>
    {active && <p role="status">{conversation.recording === 'requesting' ? '브라우저의 마이크 권한 요청을 확인하세요.' : conversation.recording === 'finishing' ? '녹음을 마무리하고 있습니다.' : `녹음 중 · ${Math.min(conversation.elapsed, 10)} / 10초`}</p>}
    {conversation.quiet && <p role="status">말소리가 작습니다. 마이크에 가까이 말해주세요.</p>}
    {conversation.clips.length > 0 && <ul className="conversation-transcript" aria-label="생성에 사용할 녹취">{conversation.clips.map(clip => <li key={clip.id}>
      <p {...(clip.pending ? { role: 'status' } : {})}>{clip.pending ? '녹음한 대화를 텍스트로 바꾸는 중…' : clip.text}</p>
      <button type="button" disabled={disabled || active} aria-label={clip.pending ? '전사 취소' : '이 녹취 삭제'} onClick={() => conversation.remove(clip.id)}><Trash2 size={16} /></button>
    </li>)}</ul>}
    {!conversation.clips.length && <p className="setup-note">녹취 없이 사진만으로도 생성할 수 있습니다.</p>}
  </section>;
}
