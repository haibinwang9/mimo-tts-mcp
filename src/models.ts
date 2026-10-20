export const MODEL_PRESET_VOICE = "mimo-v2.5-tts";
export const MODEL_VOICE_DESIGN = "mimo-v2.5-tts-voicedesign";
export const MODEL_VOICE_CLONE = "mimo-v2.5-tts-voiceclone";

export type MimoModel =
  | typeof MODEL_PRESET_VOICE
  | typeof MODEL_VOICE_DESIGN
  | typeof MODEL_VOICE_CLONE;

export interface PresetVoice {
  id: string;
  language: "zh" | "en";
  gender: "female" | "male";
  note?: string;
}

/** Built-in voices, only valid for `mimo-v2.5-tts`. */
export const PRESET_VOICES: readonly PresetVoice[] = [
  { id: "mimo_default", language: "zh", gender: "female", note: "MiMo default; resolves to 冰糖 on the China cluster, Mia elsewhere." },
  { id: "冰糖", language: "zh", gender: "female" },
  { id: "茉莉", language: "zh", gender: "female" },
  { id: "苏打", language: "zh", gender: "male" },
  { id: "白桦", language: "zh", gender: "male" },
  { id: "Mia", language: "en", gender: "female" },
  { id: "Chloe", language: "en", gender: "female" },
  { id: "Milo", language: "en", gender: "male" },
  { id: "Dean", language: "en", gender: "male" }
] as const;

export type AudioFormat = "wav" | "mp3";

export const OUTPUT_FORMATS: readonly AudioFormat[] = ["wav", "mp3"] as const;

/** 24 kHz PCM16LE mono, the sample rate MiMo streams and returns for pcm. */
export const PCM_SAMPLE_RATE = 24_000;
