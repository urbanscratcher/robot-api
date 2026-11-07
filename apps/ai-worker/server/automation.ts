import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fail } from './local.ts';
import { setPiezoLevel } from './piezo.ts';
import { receivedTranscripts, clearTranscripts } from './transcript-store.ts';

type Pair = { photoId: string; transcriptId?: string; text: string };
type State = { status: 'waiting' | 'processing' | 'halted'; photoId?: string; generateAt?: number; transcriptId?: string; text?: string; eventId?: string; error?: string };
const path = () => resolve(process.env.AUTOMATION_STATE_FILE || 'data/automation/state.json');
let state: State;
let entering = false;
let intakeFinished: Promise<void> | undefined;
let running = false;
let runningTask: Promise<void> | undefined;
let controller: AbortController | undefined;
let photoTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePhoto() {
  clearTimeout(photoTimer);
  if (state.status !== 'waiting' || !state.photoId) return;
  state.generateAt ??= Date.now() + 10_000;
  photoTimer = setTimeout(() => { void generatePhoto(); }, Math.max(0, state.generateAt - Date.now()));
  photoTimer.unref?.();
}
async function generatePhoto() {
  if (entering || externallyBusy()) {
    photoTimer = setTimeout(() => { void generatePhoto(); }, 100);
    photoTimer.unref?.();
    return;
  }
  if (running || state.status !== 'waiting' || !state.photoId) return;
  if (state.generateAt && state.generateAt > Date.now()) { schedulePhoto(); return; }
  entering = true;
  try {
    const transcript = (await receivedTranscripts()).find(item => item.interactionId === state.photoId);
    state.transcriptId = transcript?.id;
    state.text = transcript?.text;
    state.status = 'processing';
    await save();
    runPair();
  } catch (error) {
    state.status = 'halted';
    state.error = error instanceof Error ? error.message : '자동 처리 시작 실패';
    await save().catch(() => console.error('자동 처리 상태 저장 실패'));
  } finally { entering = false; }
}
function runPair() {
  const pair = { photoId: state.photoId!, transcriptId: state.transcriptId, text: state.text ?? '' };
  running = true;
  controller = new AbortController();
  const signal = controller.signal;
  runningTask = (async () => {
    try {
      try { await runner(pair, signal); }
      finally { await setPiezoLevel(0); }
      const next: State = { status: 'waiting', eventId: state.eventId };
      await save(next); state = next;
    } catch (error) {
      state.status = 'halted'; state.error = error instanceof Error ? error.message : '자동 처리 실패';
      try { await save(); } catch { console.error('자동 처리 상태 저장 실패'); }
    } finally { running = false; }
  })();
}
let externallyBusy = () => false;
export function setAutomationBusyCheck(check: () => boolean) { externallyBusy = check; }
let runner: (pair: Pair, signal: AbortSignal) => Promise<void | 'skipped'>;
export function setAutomationRunner(value: typeof runner) { runner = value; }
let writing = Promise.resolve();
function save(next?: State) {
  writing = writing.catch(() => {}).then(async () => {
    await mkdir(dirname(path()), { recursive: true });
    await writeFile(`${path()}.tmp`, JSON.stringify(next ?? state), { mode: 0o600 });
    await rename(`${path()}.tmp`, path());
  });
  return writing;
}
let initialization: Promise<void> | undefined;
function initialize() {
  return initialization ??= initializeState().catch(error => { initialization = undefined; throw error; });
}
async function initializeState() {
  if (state) return;
  try { state = JSON.parse(await readFile(path(), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = { status: 'waiting' };
  }
  if (state.status === 'waiting') {
    const transcript = state.photoId ? (await receivedTranscripts()).find(item => item.interactionId === state.photoId) : undefined;
    state.transcriptId = transcript?.id;
    state.text = transcript?.text;
    schedulePhoto();
  }
  if (state.status === 'processing') {
    state.status = 'halted'; state.error = '처리 중 서버가 재시작되었습니다. 게시 여부를 확인한 뒤 수신을 재개하세요.';
    await save();
  }
}
export async function automationStatus() {
  await initialize();
  // Status is an in-memory snapshot. Waiting for the persistence queue here can
  // freeze every monitor poll after an intake/save stalls, even though the
  // automation has already returned to a state that can accept the next pair.
  return { status: state.status, accepting: state.status === 'waiting' && !entering && !running && !externallyBusy(),
    hasPhoto: !!state.photoId, hasTranscript: !!state.transcriptId, generateAt: state.generateAt ?? null,
    eventId: state.eventId ?? null, error: state.error ?? null };
}
export async function assertAutomationIdle() {
  await initialize();
  if (entering || running || state.status !== 'waiting') fail('자동 생성·게시 처리 중이거나 확인 대기 중입니다.', 409);
}
export async function resumeAutomation() {
  await initialize();
  if (entering || running || externallyBusy()) fail('아직 처리 중입니다.', 409);
  entering = true;
  try { clearTimeout(photoTimer); await setPiezoLevel(0); state = { status: 'waiting' }; await save(); }
  finally { entering = false; }
  return automationStatus();
}
export async function restartAutomation() {
  await initialize();
  if (entering || (!running && externallyBusy())) fail('다른 작업이 처리 중입니다.', 409);
  entering = true;
  try {
    clearTimeout(photoTimer);
    state.status = 'halted';
    state.error = '중단 후 수신을 재개하는 중입니다.';
    await save();
    controller?.abort();
    await runningTask;
    await setPiezoLevel(0);
    await clearTranscripts();
    state = { status: 'waiting' };
    await save();
  } finally { entering = false; }
  return automationStatus();
}
export async function setAutomationEvent(eventId: string) { state.eventId = eventId; await save(); }

// Photos reserve intake; saved text notifications wait for an active intake to finish.
export async function receiveAutomatic<T extends { id: string; text?: string } | null>(kind: 'photo' | 'text', accept: () => Promise<T>) {
  if (kind === 'text' && intakeFinished) await intakeFinished;
  if (entering) fail('다른 입력을 수신 중입니다. 다시 전송하세요.', 409);
  entering = true;
  let release!: () => void;
  intakeFinished = new Promise<void>(resolve => { release = resolve; });
  try {
    await initialize();
    if (running || externallyBusy() || state.status !== 'waiting') fail('생성·게시 중에는 사진과 텍스트를 받지 않습니다.', 409);
    if (kind === 'photo' && state.photoId) fail('이미 해당 입력을 받았습니다. 나머지 입력을 기다리고 있습니다.', 409);
    const receipt = await accept();
    if (!receipt) return receipt;
    // Give the matching transcript exactly 10 seconds to arrive. Generation starts
    // at the deadline even when no transcript was received.
    if (kind === 'photo') { state.photoId = receipt.id; state.generateAt = Date.now() + 10_000; }
    const transcript = state.photoId ? (await receivedTranscripts()).find(item => item.interactionId === state.photoId) : undefined;
    state.transcriptId = transcript?.id;
    state.text = transcript?.text;
    await save();
    schedulePhoto();
    return receipt;
  } finally { entering = false; intakeFinished = undefined; release(); }
}
