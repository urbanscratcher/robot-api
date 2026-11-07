const placeholder =
  /\[(?:기록되지\s*않음|음[성식]\s*인식\s*없음|전사\s*실패[^\]]*|BLANK_AUDIO|무음|침묵|음악|잡음|박수)\]|<\|(?:nospeech|endoftext|startoftranscript)\|>/gi;
export function cleanTranscript(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(placeholder, " ")
    .replace(/^\[\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\]\s*/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return /^(?:기록되지\s*않음|음[성식]\s*인식\s*없음|전사\s*실패|무음|침묵)[.!。\s]*$/i.test(
    text,
  )
    ? ""
    : text;
}
export type SpeechSegment = { start: number; end: number; text: string };
