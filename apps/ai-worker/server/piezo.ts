import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PiezoLevel } from '../src/publishing.ts';
import { fail } from './local.ts';

let pending: Promise<unknown> = Promise.resolve();
const HOLD_MS = 5 * 60 * 1000;
const stateFile = () => join(resolve(process.env.PUBLICATIONS_DIR || 'data/publications'), 'piezo', 'state.json');
export function validatePiezoLevel(value: unknown): asserts value is PiezoLevel {
  if (value !== 0 && value !== 1 && value !== 2) fail('piezoLevel은 숫자 0, 1, 2 중 하나입니다.');
}
export async function piezoStatus(now = Date.now()): Promise<{ level: PiezoLevel; expiresAt: number | null }> {
  let state;
  try { state = JSON.parse(readFileSync(stateFile(), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { level: 0, expiresAt: null }; throw error; }
  if (state.level === 0 && state.expiresAt === null) return state;
  if ((state.level !== 1 && state.level !== 2) || !Number.isFinite(state.expiresAt)) throw Error('피에조 상태 파일이 올바르지 않습니다.');
  return state.expiresAt > now ? state : { level: 0, expiresAt: null };
}
export function receivePiezoLevel(value: unknown, now = Date.now()) {
  validatePiezoLevel(value);
  const next = pending.then(() => saveLevel(value, now));
  pending = next.catch(() => {});
  return next;
}
export function setPiezoLevel(value: unknown, now = Date.now()) {
  validatePiezoLevel(value);
  const next = pending.then(() => saveLevel(value, now, true));
  pending = next.catch(() => {});
  return next;
}
async function saveLevel(value: PiezoLevel, now: number, manual = false) {
  // Idle readings must not cancel the five-minute hold.
  if (value === 0 && !manual) return piezoStatus(now);
  const state = { level: value, expiresAt: value === 0 ? null : now + HOLD_MS };
  const target = stateFile();
  await mkdir(join(target, '..'), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, target);
  return state;
}
