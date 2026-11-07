import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const privateName = /(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|PRIVATE_KEY|OBSERVATION_TOKEN)/i;
const secrets = Object.entries(process.env)
  .filter(([name, value]) => privateName.test(name) && value && value.length >= 8)
  .map(([, value]) => Buffer.from(value));
const unsafeNames = Object.entries(process.env)
  .filter(([name, value]) => name.startsWith('VITE_') && privateName.test(name) && value)
  .map(([name]) => name);
const failures = [];
async function scan(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) { await scan(file); continue; }
    if (!entry.isFile()) continue;
    const data = await readFile(file);
    if (/^\.env(?:\.|$)/.test(entry.name) || secrets.some(secret => data.includes(secret)) || /\bsk-ant-[A-Za-z0-9_-]{20,}\b/.test(data.toString())) failures.push(relative(root, file));
  }
}
await Promise.all(['dist', 'public', 'src'].map(folder => scan(join(root, folder))));
if (unsafeNames.length || failures.length) {
  console.error('Client secret check failed. Secret values are never printed.');
  if (unsafeNames.length) console.error('Remove private VITE_ variables:', unsafeNames.join(', '));
  if (failures.length) console.error('Inspect these client files:', failures.join(', '));
  process.exitCode = 1;
} else {
  console.log('Client secret check passed: no configured secrets or env files in client files.');
}
