import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveOutputPath, saveAudio } from "../src/output.js";

const cleanups: Array<() => Promise<void>> = [];

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mimo-out-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const audio = Buffer.from("fake-audio-bytes");

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("saveAudio - path confinement", () => {
  it("writes inside the configured directory", async () => {
    const root = await sandbox();
    const saved = await saveAudio(path.join(root, "a.wav"), audio, { rootDir: root, allowAnyPath: false });

    expect(saved.bytes).toBe(audio.byteLength);
    expect(await readFile(saved.path)).toEqual(audio);
  });

  it("creates missing subdirectories inside the sandbox", async () => {
    const root = await sandbox();
    const saved = await saveAudio(path.join(root, "deep", "nested", "a.wav"), audio, {
      rootDir: root,
      allowAnyPath: false
    });

    expect(await readFile(saved.path)).toEqual(audio);
  });

  it("refuses an absolute path outside the sandbox", async () => {
    const root = await sandbox();
    const outside = await sandbox();

    await expect(
      saveAudio(path.join(outside, "evil.wav"), audio, { rootDir: root, allowAnyPath: false })
    ).rejects.toThrow(/Refusing to write outside the audio directory/);
  });

  it("refuses traversal that escapes the sandbox", async () => {
    const root = await sandbox();
    const escaped = path.join(root, "..", "escape.wav");

    await expect(saveAudio(escaped, audio, { rootDir: root, allowAnyPath: false })).rejects.toThrow(
      /Refusing to write outside/
    );
  });

  it("refuses the sandbox root itself as a file target", async () => {
    const root = await sandbox();

    await expect(saveAudio(root, audio, { rootDir: root, allowAnyPath: false })).rejects.toThrow(
      /Refusing to write outside/
    );
  });

  it("refuses to follow a symlinked directory that leaves the sandbox", async () => {
    const root = await sandbox();
    const outside = await sandbox();
    await mkdir(path.join(root, "link-target"));
    await symlink(outside, path.join(root, "escape-link"));

    await expect(
      saveAudio(path.join(root, "escape-link", "a.wav"), audio, { rootDir: root, allowAnyPath: false })
    ).rejects.toThrow(/symlink/);
  });

  it("honors the opt-out for operators who need arbitrary paths", async () => {
    const root = await sandbox();
    const outside = await sandbox();
    const saved = await saveAudio(path.join(outside, "a.wav"), audio, { rootDir: root, allowAnyPath: true });

    expect(await readFile(saved.path)).toEqual(audio);
  });
});

describe("saveAudio - no clobbering", () => {
  it("never overwrites an existing file, adding a numbered suffix instead", async () => {
    const root = await sandbox();
    const target = path.join(root, "take.wav");

    const first = await saveAudio(target, Buffer.from("first"), { rootDir: root, allowAnyPath: false });
    const second = await saveAudio(target, Buffer.from("second"), { rootDir: root, allowAnyPath: false });
    const third = await saveAudio(target, Buffer.from("third"), { rootDir: root, allowAnyPath: false });

    expect(first.path).toBe(target);
    expect(second.path).toBe(path.join(root, "take-2.wav"));
    expect(third.path).toBe(path.join(root, "take-3.wav"));
    expect(await readFile(target)).toEqual(Buffer.from("first"));
    expect(await readFile(second.path)).toEqual(Buffer.from("second"));
  });

  it("does not clobber a file that is not audio (e.g. a dotfile in the sandbox)", async () => {
    const root = await sandbox();
    const victim = path.join(root, "precious.txt");
    await writeFile(victim, "do not touch");

    const saved = await saveAudio(victim, audio, { rootDir: root, allowAnyPath: false });

    expect(saved.path).toBe(path.join(root, "precious-2.txt"));
    expect(await readFile(victim, "utf8")).toBe("do not touch");
  });

  it("refuses to write through a symlink pointing at an existing file", async () => {
    const root = await sandbox();
    const victim = path.join(root, "victim.txt");
    await writeFile(victim, "do not touch");
    await symlink(victim, path.join(root, "link.txt"));

    const saved = await saveAudio(path.join(root, "link.txt"), audio, { rootDir: root, allowAnyPath: false });

    expect(saved.path).toBe(path.join(root, "link-2.txt"));
    expect(await readFile(victim, "utf8")).toBe("do not touch");
  });
});

describe("resolveOutputPath - untrusted name handling", () => {
  it("strips path separators out of the model-supplied file name", async () => {
    const target = resolveOutputPath("/tmp/mimo", "wav", undefined, "../../etc/passwd");
    expect(target.startsWith("/tmp/mimo/")).toBe(true);
    expect(target.includes("..")).toBe(false);
  });
});
