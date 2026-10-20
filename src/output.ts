import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AudioFormat } from "./models.js";

export interface SavedAudio {
  path: string;
  bytes: number;
}

export interface SaveOptions {
  /** Directory callers are confined to unless `allowAnyPath` is set. */
  rootDir: string;
  /** Escape hatch for operators who really want writes outside `rootDir`. */
  allowAnyPath: boolean;
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function slug(value: string | undefined): string {
  const cleaned = (value ?? "speech")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "speech";
}

/** True when `target` is strictly below `root` after lexical normalisation. */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Resolve where the audio goes. A caller-supplied path is honored (relative
 * paths resolve against the server process cwd); otherwise the file lands in
 * `outputDir` with a timestamped name derived from the requested name.
 * Containment is enforced later, at write time.
 */
export function resolveOutputPath(
  configOutputDir: string,
  format: AudioFormat,
  outputPath: string | undefined,
  fileName: string | undefined
): string {
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    return path.extname(resolved) ? resolved : `${resolved}.${format}`;
  }
  return path.join(path.resolve(configOutputDir), `${timestamp()}-${slug(fileName)}.${format}`);
}

/**
 * Write audio without ever clobbering an existing file.
 *
 * The path originates from model output, so it is treated as untrusted input:
 * writes stay inside `rootDir` (lexically and again after symlink resolution),
 * and an existing file yields a fresh `-2`, `-3`, ... name instead of being
 * overwritten. `wx` also refuses to follow an existing symlink at the target.
 */
export async function saveAudio(target: string, audio: Buffer, options: SaveOptions): Promise<SavedAudio> {
  const root = path.resolve(options.rootDir);
  const resolved = path.resolve(target);

  if (!options.allowAnyPath && !isInside(root, resolved)) {
    throw new Error(
      `Refusing to write outside the audio directory: ${resolved}. ` +
        `Writes are confined to ${root}. Set MIMO_TTS_ALLOW_ANY_PATH=1 to lift this restriction.`
    );
  }

  const directory = path.dirname(resolved);
  await mkdir(directory, { recursive: true });

  // Re-check after the directory exists so a symlinked subdirectory cannot
  // redirect the write outside the sandbox.
  if (!options.allowAnyPath) {
    const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(directory)]);
    if (realDirectory !== realRoot && !isInside(realRoot, realDirectory)) {
      throw new Error(
        `Refusing to write through a symlink that leaves the audio directory: ${realDirectory}.`
      );
    }
  }

  const extension = path.extname(resolved);
  const stem = resolved.slice(0, resolved.length - extension.length);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? resolved : `${stem}-${attempt + 1}${extension}`;
    try {
      await writeFile(candidate, audio, { flag: "wx" });
      return { path: candidate, bytes: audio.byteLength };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Could not find an unused file name near ${resolved}.`);
}
