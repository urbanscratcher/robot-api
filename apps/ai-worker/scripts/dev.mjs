import { createRequire } from 'node:module';
import { dirname as directoryName, join as joinPath } from 'node:path';
const viteBin = joinPath(directoryName(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');
import { spawn } from "node:child_process";
const frontendEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)/i.test(name)));
const children = [
  spawn(process.execPath, ["--env-file-if-exists=.env", "--experimental-strip-types", "server/index.ts"], {
    stdio: "inherit",
  }),
  spawn(
    process.execPath,
    [
      viteBin,
      "--host",
      "127.0.0.1",
      "--port",
      "5174",
      "--strictPort",
    ],
    { stdio: "inherit", env: frontendEnv },
  ),
];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  children.forEach((p) => p.kill("SIGTERM"));
  process.exitCode = code;
}
children.forEach((p) => p.on("exit", (code) => stop(code ?? 0)));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
