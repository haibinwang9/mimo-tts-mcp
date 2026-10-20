import { describe, expect, it } from "vitest";
import { wavFromPcm16 } from "../src/wav.js";
import { resolveOutputPath } from "../src/output.js";
import { loadConfig, MISSING_API_KEY_MESSAGE, requireApiKey } from "../src/config.js";
import { PRESET_VOICES } from "../src/models.js";

describe("wavFromPcm16", () => {
  it("writes a canonical 44-byte PCM16 mono header", () => {
    const pcm = Buffer.alloc(2400); // 50 ms at 24 kHz mono 16-bit
    const wav = wavFromPcm16(pcm);

    expect(wav.byteLength).toBe(44 + pcm.byteLength);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.byteLength);
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(28)).toBe(48_000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.byteLength);
  });
});

describe("resolveOutputPath", () => {
  it("uses a timestamped name inside the output dir", () => {
    const target = resolveOutputPath("/tmp/mimo", "wav", undefined, "冰淇淋");
    expect(target.startsWith("/tmp/mimo/")).toBe(true);
    expect(target.endsWith("-冰淇淋.wav")).toBe(true);
  });

  it("keeps an explicit path and only appends the missing extension", () => {
    expect(resolveOutputPath("/tmp/mimo", "mp3", "/tmp/a/b.wav", undefined)).toBe("/tmp/a/b.wav");
    expect(resolveOutputPath("/tmp/mimo", "mp3", "/tmp/a/b", undefined)).toBe("/tmp/a/b.mp3");
  });

  it("falls back to a generic name when the hint is unusable", () => {
    const target = resolveOutputPath("/tmp/mimo", "wav", undefined, "***");
    expect(target.endsWith(".wav")).toBe(true);
    expect(target).toContain("speech");
  });
});

describe("loadConfig", () => {
  it("defaults to the official base URL and a home output dir", () => {
    const config = loadConfig({});
    expect(config.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(config.outputDir.endsWith("mimo-tts")).toBe(true);
    expect(config.apiKey).toBeUndefined();
  });

  it("reads MIMO_API_KEY and strips trailing slashes from the base URL", () => {
    const config = loadConfig({ MIMO_API_KEY: "k", MIMO_BASE_URL: "https://example.test/v1///" });
    expect(config.apiKey).toBe("k");
    expect(config.baseUrl).toBe("https://example.test/v1");
  });

  it("falls back to XIAOMIMIMO_API_KEY and ignores a blank primary key", () => {
    expect(loadConfig({ MIMO_API_KEY: "  ", XIAOMIMIMO_API_KEY: "alt" }).apiKey).toBe("alt");
  });

  it("refuses to synthesize without a key", () => {
    expect(() => requireApiKey(loadConfig({}))).toThrow(MISSING_API_KEY_MESSAGE);
  });
});

describe("preset voices", () => {
  it("lists the documented voice ids without duplicates", () => {
    const ids = PRESET_VOICES.map((voice) => voice.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]);
  });
});
