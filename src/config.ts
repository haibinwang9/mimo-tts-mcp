import os from "node:os";
import path from "node:path";

export interface Config {
  apiKey: string | undefined;
  baseUrl: string;
  outputDir: string;
  timeoutMs: number;
  /** When false, audio writes are confined to `outputDir`. */
  allowAnyPath: boolean;
}

const DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_TIMEOUT_MS = 180_000;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Expand a leading `~` and make the directory absolute. Node does not expand
 * `~`, so `MIMO_TTS_OUTPUT_DIR=~/audio` would otherwise create a literal `~`
 * directory under the cwd instead of reaching the home directory.
 */
function resolveDirectory(value: string | undefined, fallback: string): string {
  const raw = nonEmpty(value);
  if (!raw) {
    return fallback;
  }
  const expanded =
    raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")
      ? path.join(os.homedir(), raw.slice(1))
      : raw;
  return path.resolve(expanded);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const timeout = Number(nonEmpty(env.MIMO_TTS_TIMEOUT_MS));
  return {
    apiKey: nonEmpty(env.MIMO_API_KEY) ?? nonEmpty(env.XIAOMIMIMO_API_KEY),
    baseUrl: (nonEmpty(env.MIMO_BASE_URL) ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    outputDir: resolveDirectory(env.MIMO_TTS_OUTPUT_DIR, path.join(os.homedir(), "mimo-tts")),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    allowAnyPath: /^(1|true|yes)$/i.test(nonEmpty(env.MIMO_TTS_ALLOW_ANY_PATH) ?? "")
  };
}

export const MISSING_API_KEY_MESSAGE =
  "MIMO_API_KEY is not set. Create a key at https://platform.xiaomimimo.com/console/api-keys and start the MCP server with MIMO_API_KEY=<your key>.";

export function requireApiKey(config: Config): string {
  if (!config.apiKey) {
    throw new Error(MISSING_API_KEY_MESSAGE);
  }
  return config.apiKey;
}
