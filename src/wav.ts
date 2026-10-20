import { PCM_SAMPLE_RATE } from "./models.js";

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

/** Wrap raw PCM16LE mono samples in a canonical 44-byte WAV header. */
export function wavFromPcm16(pcm: Buffer): Buffer {
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const byteRate = PCM_SAMPLE_RATE * blockAlign;
  const header = Buffer.alloc(HEADER_BYTES);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(HEADER_BYTES - 8 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);

  return Buffer.concat([header, pcm]);
}
