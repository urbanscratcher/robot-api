import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './local.ts';

const stateFile = () => resolve(process.env.INSTAGRAM_PUBLISHING_SETTINGS_FILE || 'data/instagram/publishing.json');
let pending: Promise<unknown> = Promise.resolve();

export async function instagramPublishingStatus(): Promise<{ enabled: boolean }> {
  try {
    const value = JSON.parse(await readFile(stateFile(), 'utf8'));
    if (typeof value.enabled !== 'boolean') throw Error('Instagram 게시 설정 파일이 올바르지 않습니다.');
    return { enabled: value.enabled };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: true };
    throw error;
  }
}

export function setInstagramPublishing(value: unknown) {
  if (typeof value !== 'boolean') fail('enabled는 true 또는 false여야 합니다.');
  const next = pending.then(async () => {
    const target = stateFile();
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ enabled: value }), { mode: 0o600 });
    await rename(temporary, target);
    return { enabled: value };
  });
  pending = next.catch(() => {});
  return next;
}
