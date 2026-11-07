import { createRequire } from 'node:module';
import { dirname as directoryName, join as joinPath } from 'node:path';
const viteBin = joinPath(directoryName(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const config = join(homedir(), ".cloudflared", "overheard.yml");
const frontendEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)/i.test(name)));
const children = [
  spawn(process.execPath, ["--env-file-if-exists=.env", "--experimental-strip-types", "server/index.ts"], {
    cwd: root,
    env: { ...process.env, API_PORT: "3102" },
    stdio: "inherit",
  }),
  spawn(process.execPath, [viteBin, "preview"], {
    cwd: root,
    env: frontendEnv,
    stdio: "inherit",
  }),
  spawn(
    "/opt/homebrew/bin/cloudflared",
    ["tunnel", "--config", config, "run", "overheard-mac"],
    { cwd: root, stdio: "inherit", env: frontendEnv },
  ),
];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  process.exitCode = code;
  children.forEach((p) => {
    if (p.exitCode === null) p.kill("SIGTERM");
  });
}
children.forEach((p) => {
  p.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  p.on("exit", (code) => stop(code ?? 1));
});
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
