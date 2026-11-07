export const localPort = (value: string | undefined, fallback: number) =>
  value && /^\d+$/.test(value) && +value > 0 && +value < 65536
    ? +value
    : fallback;
export const OLLAMA = `http://127.0.0.1:${localPort(process.env.OLLAMA_PORT, 11434)}`;
export const COMFY = `http://127.0.0.1:${localPort(process.env.COMFY_PORT, 8188)}`;
export async function localFetch(
  url: string,
  init: RequestInit = {},
  ms = 5000,
  signal?: AbortSignal,
) {
  return fetch(url, {
    ...init,
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
      : AbortSignal.timeout(ms),
  });
}
export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
