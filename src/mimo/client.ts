import { performance } from "node:perf_hooks";
import { loadConfig, requireApiKey, type Config } from "../config.js";
import { PCM_SAMPLE_RATE, type AudioFormat, type MimoModel } from "../models.js";
import { wavFromPcm16 } from "../wav.js";

/** Bytes per PCM16LE mono sample. */
const SAMPLE_BYTES = 2;

export class MimoApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "MimoApiError";
    this.status = status;
  }
}

export interface SynthRequest {
  model: MimoModel;
  /** `assistant` message: the text to speak. */
  text: string;
  /** `user` message: style instruction, or the voice-design description. */
  instructions?: string;
  /** Preset voice id, or a `data:` URI holding a Base64 audio sample for cloning. */
  voice?: string;
  format: AudioFormat;
  optimizeTextPreview?: boolean;
}

export interface SynthesisResult {
  audio: Buffer;
  format: AudioFormat;
  /** Populated for WAV only, where the payload length is exact. */
  durationSeconds: number | undefined;
  streamed: boolean;
  latencyMs: number;
}

/**
 * Redact anything that looks like the API key from a message we are about to
 * surface to a model/host. Upstream error bodies occasionally echo credentials.
 */
export function redactSecrets(text: string, apiKey: string | undefined): string {
  if (!apiKey || apiKey.length < 6) {
    return text;
  }
  return text.split(apiKey).join("[redacted]");
}

function errorMessageFrom(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.detail === "string" && record.detail) {
    return record.detail;
  }
  const nested = record.error;
  if (typeof nested === "string" && nested) {
    return nested;
  }
  if (nested && typeof nested === "object") {
    const inner = nested as Record<string, unknown>;
    if (typeof inner.message === "string" && inner.message) {
      return inner.message;
    }
  }
  if (typeof record.message === "string" && record.message) {
    return record.message;
  }
  return undefined;
}

function buildBody(request: SynthRequest, stream: boolean): Record<string, unknown> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  // `user` carries style instructions, `assistant` carries the text to speak.
  // Voicedesign requires `user` and rejects `voice`.
  if (request.instructions) {
    messages.push({ role: "user", content: request.instructions });
  }
  if (request.text) {
    messages.push({ role: "assistant", content: request.text });
  }

  const audio: Record<string, unknown> = { format: stream ? "pcm16" : request.format };
  if (request.voice) {
    audio.voice = request.voice;
  }
  if (request.optimizeTextPreview !== undefined) {
    audio.optimize_text_preview = request.optimizeTextPreview;
  }

  return { model: request.model, messages, audio, ...(stream ? { stream: true } : {}) };
}

async function readError(response: Response, apiKey: string): Promise<MimoApiError> {
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const message = errorMessageFrom(parsed) ?? `MiMo API returned HTTP ${response.status}: ${raw.slice(0, 500)}`;
  return new MimoApiError(redactSecrets(message, apiKey), response.status);
}

/** Streaming call: MiMo emits Base64 audio chunks over SSE. Returns concatenated PCM16. */
async function postStream(request: SynthRequest, config: Config, apiKey: string): Promise<Buffer> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(buildBody(request, true)),
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) {
    throw await readError(response, apiKey);
  }
  if (!response.body) {
    throw new MimoApiError("MiMo API returned an empty streaming response.");
  }

  const chunks: Buffer[] = [];
  const decoder = new TextDecoder();
  let buffered = "";

  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      return;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return;
    }
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event?.error) {
      throw new MimoApiError(
        redactSecrets(errorMessageFrom(event) ?? "MiMo API reported a streaming error.", apiKey)
      );
    }
    const data = event?.choices?.[0]?.delta?.audio?.data;
    if (typeof data === "string" && data.length > 0) {
      chunks.push(Buffer.from(data, "base64"));
    }
  };

  for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(part, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      consume(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) {
    consume(buffered);
  }

  const pcm = Buffer.concat(chunks);
  // Drop a trailing partial sample so the payload stays frame-aligned.
  return pcm.subarray(0, pcm.byteLength - (pcm.byteLength % SAMPLE_BYTES));
}

/** Non-streaming call: the whole audio arrives Base64-encoded in one JSON body. */
async function postJson(request: SynthRequest, config: Config, apiKey: string): Promise<Buffer> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify(buildBody(request, false)),
    signal: AbortSignal.timeout(config.timeoutMs)
  });

  const raw = await response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (!response.ok) {
      throw new MimoApiError(
        redactSecrets(`MiMo API returned HTTP ${response.status}: ${raw.slice(0, 500)}`, apiKey),
        response.status
      );
    }
    throw new MimoApiError("MiMo API returned a non-JSON response.");
  }

  if (!response.ok || parsed?.error) {
    throw new MimoApiError(
      redactSecrets(errorMessageFrom(parsed) ?? `MiMo API returned HTTP ${response.status}.`, apiKey),
      response.status
    );
  }

  const data = parsed?.choices?.[0]?.message?.audio?.data;
  if (typeof data !== "string" || data.length === 0) {
    throw new MimoApiError(
      "MiMo API response contained no audio. The text to speak must be in the assistant message."
    );
  }
  return Buffer.from(data, "base64");
}

function asWav(bytes: Buffer): Buffer {
  return bytes.subarray(0, 4).toString("ascii") === "RIFF" ? bytes : wavFromPcm16(bytes);
}

function wavDuration(wav: Buffer): number | undefined {
  const pcmBytes = wav.byteLength - 44;
  return pcmBytes > 0 ? Number((pcmBytes / SAMPLE_BYTES / PCM_SAMPLE_RATE).toFixed(2)) : undefined;
}

/**
 * Synthesize speech.
 *
 * WAV takes the streaming path because MiMo only emits raw `pcm16` while
 * streaming; the collected PCM is wrapped in a WAV header locally. mp3 uses the
 * non-streaming path. When a streaming request yields no audio (voicedesign and
 * voiceclone may not stream), it falls back to a non-streaming request.
 */
export async function synthesize(
  request: SynthRequest,
  config: Config = loadConfig()
): Promise<SynthesisResult> {
  const apiKey = requireApiKey(config);
  const started = performance.now();

  if (request.format === "wav") {
    const pcm = await postStream(request, config, apiKey);
    const audio = pcm.byteLength > 0 ? wavFromPcm16(pcm) : asWav(await postJson(request, config, apiKey));
    return {
      audio,
      format: "wav",
      durationSeconds: wavDuration(audio),
      streamed: pcm.byteLength > 0,
      latencyMs: Math.round(performance.now() - started)
    };
  }

  const audio = await postJson(request, config, apiKey);
  return {
    audio,
    format: request.format,
    durationSeconds: undefined,
    streamed: false,
    latencyMs: Math.round(performance.now() - started)
  };
}
