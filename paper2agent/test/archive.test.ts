import { mkdtemp, readFile, writeFile, rm, open, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractPackage, MAX_PACKAGE_BYTES, packageZip, verifyPackageFiles } from "../src/archive.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "paper-package-test-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

interface ArchiveEntry { name: string; content?: string | Buffer; type?: "file" | "symlink" | "link"; linkname?: string }
async function archive(entries: ArchiveEntry[]): Promise<string> {
  const path = join(directory, "input.tar");
  const pack = tar.pack();
  const writing = pipeline(pack, createWriteStream(path));
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: entry.name, type: entry.type ?? "file", size: content.length, linkname: entry.linkname }, content,
        (error) => error ? reject(error) : resolve());
    });
  }
  pack.finalize();
  await writing;
  return path;
}

describe("untrusted package archive boundaries", () => {
  it.each(["../outside.py", "/tmp/outside.py", "source/../../outside.py", "source\\..\\outside.py"])("rejects escaping path %s without touching outside files", async (name) => {
    const outside = join(directory, "outside.py");
    await writeFile(outside, "operator-owned");
    const path = await archive([{ name, content: "replacement" }]);
    const target = join(directory, "package");
    await expect(extractPackage(path, target)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("operator-owned");
    await expect(readFile(join(target, "outside.py"))).rejects.toThrow();
  });

  it.each(["symlink", "link"] as const)("rejects %s entries instead of following them", async (type) => {
    const path = await archive([{ name: "server.py", type, linkname: "../../private-key" }]);
    await expect(extractPackage(path, join(directory, "package"))).rejects.toThrow();
  });

  it("rejects duplicate files instead of replacing reviewed content", async () => {
    const path = await archive([{ name: "server.py", content: "reviewed" }, { name: "./server.py", content: "replacement" }]);
    await expect(extractPackage(path, join(directory, "package"))).rejects.toThrow();
  });

  it("rejects a sparse oversized archive before reading its body", async () => {
    const path = join(directory, "oversized.tar");
    const file = await open(path, "wx");
    try { await file.truncate(MAX_PACKAGE_BYTES + 1); } finally { await file.close(); }
    await expect(extractPackage(path, join(directory, "package"))).rejects.toThrow();
  });

  it("does not overwrite an existing destination", async () => {
    const path = await archive([{ name: "server.py", content: "replacement" }]);
    await writeFile(join(directory, "server.py"), "operator-owned");
    await expect(extractPackage(path, directory)).rejects.toThrow();
    expect(await readFile(join(directory, "server.py"), "utf8")).toBe("operator-owned");
  });

  it("invalidates a review when a package file changes", async () => {
    const path = await archive([{ name: "server.py", content: "reviewed" }]);
    const target = join(directory, "package");
    const inventory = await extractPackage(path, target);
    await writeFile(join(target, "server.py"), "modified");
    await expect(verifyPackageFiles(target, inventory)).rejects.toThrow();
  });

  it("invalidates a review when a file is added", async () => {
    const path = await archive([{ name: "server.py", content: "reviewed" }]);
    const target = join(directory, "package");
    const inventory = await extractPackage(path, target);
    await writeFile(join(target, "sitecustomize.py"), "unreviewed startup code");
    await expect(verifyPackageFiles(target, inventory)).rejects.toThrow();
  });

  it("rejects a link substituted after extraction", async () => {
    const path = await archive([{ name: "server.py", content: "reviewed" }]);
    const target = join(directory, "package");
    const inventory = await extractPackage(path, target);
    await rm(join(target, "server.py"));
    await symlink(join(directory, "input.tar"), join(target, "server.py"));
    await expect(verifyPackageFiles(target, inventory)).rejects.toThrow();
  });
});

describe("code ZIP downloads", () => {
  it("preserves nested UTF-8 names, binary files, and empty files in a real ZIP", async () => {
    const binary = Buffer.from([0, 255, 192, 128, 13, 10]);
    const path = await archive([
      { name: "server.py", content: "print('paper')\n" },
      { name: "résultats/測定.bin", content: binary },
      { name: "requirements.lock", content: "" },
    ]);
    const files = unzipSync(await packageZip(await readFile(path)));
    expect(Object.keys(files).sort()).toEqual(["server.py", "résultats/測定.bin", "requirements.lock"].sort());
    expect(Buffer.from(files["server.py"]).toString()).toBe("print('paper')\n");
    expect(Buffer.from(files["résultats/測定.bin"])).toEqual(binary);
    expect(files["requirements.lock"]).toEqual(new Uint8Array(0));
  });

  it.each(["../outside.py", "C:/outside.py", "code.py:hidden"])("rejects unsafe ZIP path %s", async (name) => {
    const path = await archive([{ name, content: "untrusted" }]);
    await expect(packageZip(await readFile(path))).rejects.toThrow();
  });

  it.each(["symlink", "link"] as const)("does not put %s entries into a code download", async (type) => {
    const path = await archive([{ name: "server.py", type, linkname: "../../private-key" }]);
    await expect(packageZip(await readFile(path))).rejects.toThrow();
  });

  it("rejects duplicate normalized names instead of replacing a downloaded file", async () => {
    const path = await archive([{ name: "server.py", content: "reviewed" }, { name: "./server.py", content: "replacement" }]);
    await expect(packageZip(await readFile(path))).rejects.toThrow();
  });
});
