import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, MISSING_API_KEY_MESSAGE, type Config } from "./config.js";
import { MimoApiError, synthesize, type SynthesisResult } from "./mimo/client.js";
import {
  MODEL_PRESET_VOICE,
  MODEL_VOICE_CLONE,
  MODEL_VOICE_DESIGN,
  OUTPUT_FORMATS,
  PRESET_VOICES,
  PCM_SAMPLE_RATE,
  type AudioFormat,
  type MimoModel
} from "./models.js";
import { resolveOutputPath, saveAudio } from "./output.js";
import { sampleToDataUri } from "./voice-sample.js";

export const VERSION = "0.1.0";

const MCP_NAME = "mimo-tts";

/** Requested output file location. */
const outputPathField = z
  .string()
  .optional()
  .describe(
    "Where to write the audio file. Must stay inside MIMO_TTS_OUTPUT_DIR (~/mimo-tts) unless the server sets MIMO_TTS_ALLOW_ANY_PATH. A relative path resolves against the server process cwd. Existing files are never overwritten; a -2, -3 suffix is added instead."
  );

const formatField = z
  .enum(OUTPUT_FORMATS as [AudioFormat, ...AudioFormat[]])
  .default("wav")
  .describe("Output container. wav is lossless and takes the low-latency streaming path; mp3 is smaller.");

const fileNameField = z
  .string()
  .optional()
  .describe("Base name used when output_path is omitted, e.g. \"greeting\".");

const styleField = z
  .string()
  .optional()
  .describe(
    "Natural-language style direction, sent as the user message. Describe emotion, pace, character, scene, or a director-style brief (角色/场景/指导). Audio tags such as (怅然) or [轻笑] belong in the spoken text instead."
  );

function jsonText(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorText(error: unknown) {
  if (error instanceof MimoApiError) {
    const hint =
      error.status === 401 || error.status === 403
        ? " Verify MIMO_API_KEY at https://platform.xiaomimimo.com/console/api-keys."
        : "";
    return { isError: true, content: [{ type: "text" as const, text: `${error.message}${hint}` }] };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function describeResult(result: SynthesisResult, saved: { path: string; bytes: number }, model: MimoModel, voice: string | undefined) {
  return {
    ok: true,
    model,
    voice,
    file: saved.path,
    format: result.format,
    bytes: saved.bytes,
    duration_seconds: result.durationSeconds,
    sample_rate: result.format === "wav" ? PCM_SAMPLE_RATE : undefined,
    streamed: result.streamed,
    latency_ms: result.latencyMs
  };
}

export function createServer(config: Config = loadConfig()): McpServer {
  const server = new McpServer({ name: MCP_NAME, version: VERSION });
  const saveOptions = { rootDir: config.outputDir, allowAnyPath: config.allowAnyPath };

  server.registerTool(
    "text_to_speech",
    {
      title: "MiMo TTS - preset voice",
      description:
        "Synthesize speech with Xiaomi MiMo `mimo-v2.5-tts` using one of the built-in voices. " +
        "Supports singing via a leading (唱歌) tag, and fine-grained audio tags inside the text. " +
        "Writes the audio to a file and returns its path, byte size, and duration.",
      inputSchema: {
        text: z
          .string()
          .min(1)
          .describe(
            "Text to speak. Add a leading style tag such as (怅然) or (唱歌) and inline tags such as [轻笑] or [长叹一口气] to steer delivery. Keep it within a few thousand characters (8K token context)."
          ),
        voice: z
          .string()
          .default("mimo_default")
          .describe(
            `Preset voice id: ${PRESET_VOICES.map((v) => v.id).join(", ")}. Chinese voices: ${PRESET_VOICES.filter((v) => v.language === "zh").map((v) => v.id).join(", ")}; English: ${PRESET_VOICES.filter((v) => v.language === "en").map((v) => v.id).join(", ")}.`
          ),
        instructions: styleField,
        format: formatField,
        output_path: outputPathField,
        file_name: fileNameField
      }
    },
    async ({ text, voice, instructions, format, output_path, file_name }) => {
      try {
        const result = await synthesize(
          { model: MODEL_PRESET_VOICE, text, instructions, voice, format },
          config
        );
        const target = resolveOutputPath(config.outputDir, result.format, output_path, file_name ?? voice);
        const saved = await saveAudio(target, result.audio, saveOptions);
        return jsonText(describeResult(result, saved, MODEL_PRESET_VOICE, voice));
      } catch (error) {
        return errorText(error);
      }
    }
  );

  server.registerTool(
    "design_voice_to_speech",
    {
      title: "MiMo TTS - designed voice",
      description:
        "Synthesize speech with Xiaomi MiMo `mimo-v2.5-tts-voicedesign`, inventing a brand-new voice from a text description. " +
        "No preset voice and no audio sample involved. Writes the audio to a file and returns its path.",
      inputSchema: {
        voice_description: z
          .string()
          .min(1)
          .describe(
            "Voice design brief, 1-4 sentences. Cover dimensions such as gender and age, timbre, emotion, pace, plus optional persona/scene/era. Avoid post-processing terms (reverb, EQ) and contradictions."
          ),
        text: z
          .string()
          .optional()
          .describe(
            "Text to speak. Optional only when optimize_text_preview is true, in which case MiMo generates or polishes the script itself."
          ),
        optimize_text_preview: z
          .boolean()
          .default(false)
          .describe("Let MiMo polish the script (or invent one when text is omitted) before synthesis."),
        format: formatField,
        output_path: outputPathField,
        file_name: fileNameField
      }
    },
    async ({ voice_description, text, optimize_text_preview, format, output_path, file_name }) => {
      try {
        if (!text && !optimize_text_preview) {
          throw new Error(
            "design_voice_to_speech needs `text`, or `optimize_text_preview: true` so MiMo can write one."
          );
        }
        const result = await synthesize(
          {
            model: MODEL_VOICE_DESIGN,
            text: text ?? "",
            instructions: voice_description,
            format,
            optimizeTextPreview: optimize_text_preview
          },
          config
        );
        const target = resolveOutputPath(config.outputDir, result.format, output_path, file_name ?? "designed-voice");
        const saved = await saveAudio(target, result.audio, saveOptions);
        return jsonText(describeResult(result, saved, MODEL_VOICE_DESIGN, undefined));
      } catch (error) {
        return errorText(error);
      }
    }
  );

  server.registerTool(
    "clone_voice_to_speech",
    {
      title: "MiMo TTS - cloned voice",
      description:
        "Synthesize speech with Xiaomi MiMo `mimo-v2.5-tts-voiceclone`, replicating a voice from a local mp3/wav sample. " +
        "The sample is Base64-encoded and sent on every call; MiMo requires it to stay under 10 MB. " +
        "Writes the audio to a file and returns its path.",
      inputSchema: {
        text: z.string().min(1).describe("Text to speak. Audio tags such as (慵懒) or [叹气] are supported."),
        sample_path: z
          .string()
          .min(1)
          .describe("Absolute path to the reference voice sample (.mp3 or .wav, ideally 5-30 seconds, under ~7.5 MB)."),
        instructions: styleField,
        format: formatField,
        output_path: outputPathField,
        file_name: fileNameField
      }
    },
    async ({ text, sample_path, instructions, format, output_path, file_name }) => {
      try {
        const voice = await sampleToDataUri(sample_path);
        const result = await synthesize(
          { model: MODEL_VOICE_CLONE, text, instructions, voice, format },
          config
        );
        const fallbackName = `cloned-${sample_path.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "")}`;
        const target = resolveOutputPath(config.outputDir, result.format, output_path, file_name ?? fallbackName);
        const saved = await saveAudio(target, result.audio, saveOptions);
        return jsonText({
          ...describeResult(result, saved, MODEL_VOICE_CLONE, undefined),
          sample_path
        });
      } catch (error) {
        return errorText(error);
      }
    }
  );

  server.registerTool(
    "list_voices",
    {
      title: "MiMo TTS - catalog",
      description:
        "List the MiMo TTS models, their capabilities, built-in preset voices, and where files are written. Read-only; no API key needed.",
      inputSchema: {}
    },
    async () =>
      jsonText({
        base_url: config.baseUrl,
        api_key_configured: Boolean(config.apiKey),
        api_key_hint: config.apiKey ? undefined : MISSING_API_KEY_MESSAGE,
        output_dir: config.outputDir,
        models: [
          {
            id: MODEL_PRESET_VOICE,
            tool: "text_to_speech",
            capability: "Preset voices, style instructions, audio tags, singing via (唱歌).",
            voices: PRESET_VOICES
          },
          {
            id: MODEL_VOICE_DESIGN,
            tool: "design_voice_to_speech",
            capability: "Text-described voice design; no preset voice or sample. No singing mode.",
            voices: []
          },
          {
            id: MODEL_VOICE_CLONE,
            tool: "clone_voice_to_speech",
            capability: "Voice cloning from an mp3/wav sample (Base64 data URI, under 10 MB). No singing mode.",
            voices: []
          }
        ],
        formats: OUTPUT_FORMATS,
        style_tag_examples: ["(怅然)", "(慵懒)", "(东北话)", "(唱歌)", "(轻笑)", "[长叹一口气]"]
      })
  );

  return server;
}
