import { afterEach, describe, expect, it, vi } from "vitest";
import { MimoApiError, redactSecrets, synthesize, type SynthRequest } from "../src/mimo/client.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";

const config: Config = { ...loadConfig({}), apiKey: "test-key", baseUrl: "https://api.test/v1", outputDir: "/tmp" };

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function audioChunk(pcm: Buffer): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcm.toString("base64") } } }] })}\n\n`;
}

function callAt(fetchMock: any, index: number): { url: string; init: any } {
  const [url, init] = fetchMock.mock.calls.at(index);
  return { url, init };
}

function lastRequestBody(fetchMock: any, index = -1): any {
  return JSON.parse(callAt(fetchMock, index).init.body);
}

const presetRequest = (overrides: Partial<SynthRequest> = {}): SynthRequest => ({
  model: "mimo-v2.5-tts",
  text: "你好世界",
  voice: "冰糖",
  format: "wav",
  ...overrides
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("synthesize - request body", () => {
  it("puts style instructions in user and speech in assistant, and streams pcm16 for wav", async () => {
    const fetchMock = vi.fn(async () => sseResponse([audioChunk(Buffer.alloc(4))]));
    vi.stubGlobal("fetch", fetchMock);

    await synthesize(presetRequest({ instructions: "轻快上扬" }), config);

    const body = lastRequestBody(fetchMock);
    expect(body.model).toBe("mimo-v2.5-tts");
    expect(body.stream).toBe(true);
    expect(body.audio).toEqual({ format: "pcm16", voice: "冰糖" });
    expect(body.messages).toEqual([
      { role: "user", content: "轻快上扬" },
      { role: "assistant", content: "你好世界" }
    ]);
    expect(callAt(fetchMock, 0).url).toBe("https://api.test/v1/chat/completions");
    expect(callAt(fetchMock, 0).init.headers["api-key"]).toBe("test-key");
  });

  it("omits the user message when no style is given, and never sends voice for voicedesign", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([audioChunk(Buffer.alloc(4))])
    );
    vi.stubGlobal("fetch", fetchMock);

    await synthesize(
      {
        model: "mimo-v2.5-tts-voicedesign",
        text: "Hello there",
        instructions: "A warm narrator",
        format: "wav",
        optimizeTextPreview: true
      },
      config
    );

    const body = lastRequestBody(fetchMock);
    expect(body.audio).toEqual({ format: "pcm16", optimize_text_preview: true });
    expect(body.messages).toEqual([
      { role: "user", content: "A warm narrator" },
      { role: "assistant", content: "Hello there" }
    ]);
  });

  it("uses the non-streaming path for mp3 and decodes message audio", async () => {
    const mp3 = Buffer.from("ID3fake-mp3-bytes");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { audio: { data: mp3.toString("base64") } } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesize(presetRequest({ format: "mp3" }), config);

    const body = lastRequestBody(fetchMock);
    expect(body.stream).toBeUndefined();
    expect(body.audio.format).toBe("mp3");
    expect(result.format).toBe("mp3");
    expect(result.audio.equals(mp3)).toBe(true);
    expect(result.streamed).toBe(false);
    expect(result.durationSeconds).toBeUndefined();
  });
});

describe("synthesize - audio handling", () => {
  it("concatenates SSE chunks across buffer boundaries and wraps them in a WAV header", async () => {
    const first = Buffer.alloc(2400, 1);
    const second = Buffer.alloc(2400, 2);
    const payload = audioChunk(first) + audioChunk(second);
    // Split mid-line to prove the SSE parser re-assembles partial frames.
    const fetchMock = vi.fn(async () => sseResponse([payload.slice(0, 17), payload.slice(17)]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesize(presetRequest(), config);

    expect(result.format).toBe("wav");
    expect(result.streamed).toBe(true);
    expect(result.audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result.audio.readUInt32LE(40)).toBe(first.byteLength + second.byteLength);
    expect(result.audio.subarray(44, 44 + 2400).every((byte) => byte === 1)).toBe(true);
    expect(result.durationSeconds).toBe(0.1);
  });

  it("drops a trailing partial sample so the payload stays frame-aligned", async () => {
    const fetchMock = vi.fn(async () =>
      // 4799 bytes: one byte too many for whole 16-bit samples.
      sseResponse([audioChunk(Buffer.concat([Buffer.alloc(4798, 1), Buffer.from([9])]))])
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesize(presetRequest(), config);

    expect(result.audio.readUInt32LE(40)).toBe(4798);
  });

  it("falls back to a non-streaming request when streaming returns no audio", async () => {
    const pcm = Buffer.alloc(2400, 3);
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(32), pcm]);
    const fetchMock = vi.fn(async (_url: string, init: any) =>
      init.body.includes('"stream":true')
        ? sseResponse(['data: [DONE]\n\n'])
        : jsonResponse({ choices: [{ message: { audio: { data: wav.toString("base64") } } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesize(presetRequest({ model: "mimo-v2.5-tts-voiceclone", voice: "data:audio/wav;base64,AA==" }), config);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.streamed).toBe(false);
    expect(result.audio.equals(wav)).toBe(true);
  });
});

describe("synthesize - errors", () => {
  it("surfaces the API error message and status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "model not found" } }, 404)));

    await expect(synthesize(presetRequest(), config)).rejects.toThrow(/model not found/);
  });

  it("reports a missing audio payload instead of writing an empty file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ choices: [{ message: {} }] })));

    await expect(synthesize(presetRequest({ format: "mp3" }), config)).rejects.toThrow(/no audio/);
  });

  it("requires an API key before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(synthesize(presetRequest(), { ...config, apiKey: undefined })).rejects.toThrow(/MIMO_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts the API key if an upstream error body echoes it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "bad key test-key rejected" } }, 401))
    );

    const error = await synthesize(presetRequest(), config).catch((caught) => caught);
    expect((error as MimoApiError).message).toContain("[redacted]");
    expect((error as MimoApiError).message).not.toContain("test-key");
  });

  it("never redacts when no key is configured", () => {
    expect(redactSecrets("plain message", undefined)).toBe("plain message");
  });

  it("tags HTTP 401 so the tool layer can hint at the key page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "unauthorized" } }, 401)));

    const error = await synthesize(presetRequest(), config).catch((caught) => caught);
    expect(error).toBeInstanceOf(MimoApiError);
    expect((error as MimoApiError).status).toBe(401);
  });
});
