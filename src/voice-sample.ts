import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** MiMo rejects Base64 voice samples above 10 MB, so cap the raw file below that. */
const MAX_SAMPLE_BYTES = 7_500_000;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav"
};

/**
 * Read a local mp3/wav sample and turn it into the `data:<mime>;base64,<payload>`
 * string MiMo's voiceclone model expects in `audio.voice`.
 */
export async function sampleToDataUri(samplePath: string): Promise<string> {
  const resolved = path.resolve(samplePath);
  const extension = path.extname(resolved).toLowerCase();
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) {
    throw new Error(`Unsupported voice sample format "${extension || "(none)"}". Use an .mp3 or .wav file.`);
  }

  let size: number;
  try {
    size = (await stat(resolved)).size;
  } catch {
    throw new Error(`Voice sample not found: ${resolved}`);
  }
  if (size === 0) {
    throw new Error(`Voice sample is empty: ${resolved}`);
  }
  if (size > MAX_SAMPLE_BYTES) {
    throw new Error(
      `Voice sample is ${(size / 1_000_000).toFixed(1)} MB; keep it under ` +
        `${(MAX_SAMPLE_BYTES / 1_000_000).toFixed(1)} MB so the Base64 payload stays under MiMo's 10 MB limit.`
    );
  }

  const bytes = await readFile(resolved);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
