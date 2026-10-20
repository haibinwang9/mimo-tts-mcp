import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { loadConfig, type Config } from "../src/config.js";

const cleanups: Array<() => Promise<void>> = [];

async function connectServer(config: Config): Promise<Client> {
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function textOf(result: any): any {
  return JSON.parse(result.content[0].text);
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("stdio server", () => {
  it("exposes the four TTS tools with descriptions", async () => {
    const client = await connectServer({ ...loadConfig({}), outputDir: tmpdir() });
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual(["clone_voice_to_speech", "design_voice_to_speech", "list_voices", "text_to_speech"]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
    }

    const preset = tools.find((tool) => tool.name === "text_to_speech");
    expect(preset?.inputSchema.required).toEqual(["text"]);
  });

  it("reports the catalog without an API key and flags the missing key", async () => {
    const client = await connectServer({ ...loadConfig({}), outputDir: "/tmp/mimo-out" });
    const catalog = textOf(await client.callTool({ name: "list_voices", arguments: {} }));

    expect(catalog.api_key_configured).toBe(false);
    expect(catalog.api_key_hint).toContain("MIMO_API_KEY");
    expect(catalog.output_dir).toBe("/tmp/mimo-out");
    expect(catalog.models.map((model: any) => model.id)).toEqual([
      "mimo-v2.5-tts",
      "mimo-v2.5-tts-voicedesign",
      "mimo-v2.5-tts-voiceclone"
    ]);
    expect(catalog.models[0].voices.length).toBe(9);
  });

  it("returns an actionable error instead of throwing when the key is absent", async () => {
    const client = await connectServer({ ...loadConfig({}), outputDir: tmpdir() });
    const result: any = await client.callTool({
      name: "text_to_speech",
      arguments: { text: "你好" }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("MIMO_API_KEY");
  });

  it("requires text or optimize_text_preview for voice design", async () => {
    const client = await connectServer({ ...loadConfig({ MIMO_API_KEY: "k" }), outputDir: tmpdir() });
    const result: any = await client.callTool({
      name: "design_voice_to_speech",
      arguments: { voice_description: "温柔的中年女声" }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("optimize_text_preview");
  });

  it("rejects non mp3/wav voice samples before calling the API", async () => {
    const client = await connectServer({ ...loadConfig({ MIMO_API_KEY: "k" }), outputDir: tmpdir() });
    const dir = await mkdtemp(path.join(tmpdir(), "mimo-sample-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const sample = path.join(dir, "voice.flac");
    await writeFile(sample, "not-really-a-flac");

    const result: any = await client.callTool({
      name: "clone_voice_to_speech",
      arguments: { text: "你好", sample_path: sample }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unsupported voice sample format");
  });
});
