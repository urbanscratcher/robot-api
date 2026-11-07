import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, readdir, readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fail } from './local.ts';

export type TranscriptSegment = { interactionId: string; startedAt: string; endedAt: string };
export type Transcript = { id: string; text: string; receivedAt: string } & Partial<TranscriptSegment>;

let saving: Promise<unknown> = Promise.resolve();
let lastReceivedAt = 0;

export function saveTranscript(text: string, segment?: TranscriptSegment): Promise<Transcript> {
  const task = saving.catch(() => {}).then(async () => {
    if (segment) {
      const existing = (await readTranscripts()).find(item => item.interactionId === segment.interactionId);
      if (existing) {
        if (existing.text !== text || existing.startedAt !== segment.startedAt || existing.endedAt !== segment.endedAt)
          fail('같은 interactionId에 다른 최종 전사가 있습니다.', 409);
        return existing;
      }
    }
    lastReceivedAt = Math.max(Date.now(), lastReceivedAt + 1);
    const item = { ...segment, id: randomUUID(), text, receivedAt: new Date(lastReceivedAt).toISOString() };
    const root = resolve(process.env.TRANSCRIPTS_DATA_DIR || 'data/transcripts');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = join(root, `${item.id}.json`);
    await writeFile(`${target}.tmp`, JSON.stringify(item, null, 2), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
    return item;
  });
  saving = task;
  return task;
}

export async function receivedTranscripts() {
  await saving.catch(() => {});
  return readTranscripts();
}

export function clearTranscripts(): Promise<void> {
  const task = saving.catch(() => {}).then(async () => {
    const root = resolve(process.env.TRANSCRIPTS_DATA_DIR || 'data/transcripts');
    const items = await readTranscripts();
    await Promise.all(items.map(item => unlink(join(root, `${item.id}.json`))));
  });
  saving = task;
  return task;
}

async function readTranscripts() {
  const root = resolve(process.env.TRANSCRIPTS_DATA_DIR || 'data/transcripts');
  let files: string[];
  try { files = await readdir(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const items: Transcript[] = [];
  for (const file of files) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const item = JSON.parse(await readFile(join(root, file), 'utf8'));
    items.push(item);
  }
  return items.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
}

