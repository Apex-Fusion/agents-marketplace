import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { Zip, ZipDeflate } from "fflate";
import { PAPER2AGENT_MAX_DOWNLOAD_BYTES } from "@marketplace/shared/paper2agent/workflow";
import type { PaperPackageFile } from "@marketplace/shared/paper2agent/workflow";

export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;

export function packageRelativePath(value: string): string {
  const name = value.replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
  if (!name || name.length > 1024 || name.includes("\\") || /[\x00-\x1f\x7f]/.test(name) ||
      posix.isAbsolute(name) || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid package path");
  }
  return name;
}

export async function fileSha256(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) throw new Error("Package file is not a bounded regular file");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > MAX_PACKAGE_BYTES) throw new Error("Package file exceeds its size limit");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function extractPackage(archivePath: string, destination: string): Promise<PaperPackageFile[]> {
  const archive = await lstat(archivePath);
  if (!archive.isFile() || archive.size > MAX_PACKAGE_BYTES) throw new Error("Package archive exceeds its size limit");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  const extractor = tar.extract();
  const names = new Set<string>();
  const files: PaperPackageFile[] = [];
  let total = 0;
  let count = 0;
  extractor.on("entry", (header, stream, next) => {
    void (async () => {
      if (++count > MAX_FILES) throw new Error("Package has too many entries");
      if (header.type !== "file" && header.type !== "directory") throw new Error("Package links and special files are not allowed");
      if (header.type === "directory" && (header.name === "." || header.name === "./")) {
        stream.resume();
        next();
        return;
      }
      const name = packageRelativePath(header.name);
      if (names.has(name)) throw new Error("Package has duplicate paths");
      names.add(name);
      const size = header.size ?? 0;
      if (!Number.isSafeInteger(size) || size < 0 || (total += size) > MAX_PACKAGE_BYTES) throw new Error("Expanded package exceeds its size limit");
      const target = join(destination, name);
      if (header.type === "directory") {
        if (size !== 0) throw new Error("Directory entry contains data");
        await mkdir(target, { recursive: true, mode: 0o700 });
        stream.resume();
      } else {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const hash = createHash("sha256");
        let received = 0;
        const digest = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > size) return callback(new Error("Package entry length mismatch"));
          hash.update(chunk);
          callback(null, chunk);
        } });
        await pipeline(stream, digest, createWriteStream(target, { flags: "wx", mode: 0o600 }));
        if (received !== size) throw new Error("Package entry length mismatch");
        files.push({ path: name, bytes: size, sha256: hash.digest("hex") });
      }
      next();
    })().catch((error: Error) => { stream.destroy(); extractor.destroy(error); });
  });
  try {
    await pipeline(createReadStream(archivePath), extractor);
    return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function packageInventory(directory: string): Promise<PaperPackageFile[]> {
  const files: PaperPackageFile[] = [];
  let total = 0;
  let entries = 0;
  async function walk(relative: string, depth: number): Promise<void> {
    if (depth > 64) throw new Error("Package directory nesting exceeds limit");
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      if (++entries > MAX_FILES) throw new Error("Package has too many entries");
      const name = packageRelativePath(relative ? `${relative}/${entry.name}` : entry.name);
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isDirectory()) await walk(name, depth + 1);
      else if (stat.isFile()) {
        total += stat.size;
        if (total > MAX_PACKAGE_BYTES) throw new Error("Package exceeds size limit");
        files.push({ path: name, bytes: stat.size, sha256: await fileSha256(path) });
      } else throw new Error("Package links and special files are not allowed");
    }
  }
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Package root must be a directory");
  await walk("", 0);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function verifyPackageFiles(directory: string, files: PaperPackageFile[]): Promise<void> {
  const actual = await packageInventory(directory);
  const expected = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (actual.length !== expected.length || actual.some((file, index) => {
    const other = expected[index];
    return file.path !== other.path || file.bytes !== other.bytes || file.sha256 !== other.sha256;
  })) throw new Error("Package files no longer match the reviewed artifact");
}

export async function createPackage(directory: string, archivePath: string): Promise<PaperPackageFile[]> {
  const files = await packageInventory(directory);
  const pack = tar.pack();
  let bytes = 0;
  const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > MAX_PACKAGE_BYTES ? new Error("Package archive exceeds size limit") : null, chunk);
  } });
  const writing = pipeline(pack, bound, createWriteStream(archivePath, { flags: "wx", mode: 0o600 }));
  void writing.catch(() => undefined);
  try {
    for (const file of files) {
      const entry = pack.entry({ name: file.path, type: "file", size: file.bytes, mode: 0o644,
        uid: 0, gid: 0, mtime: new Date(0) });
      await pipeline(createReadStream(join(directory, file.path)), entry);
    }
    pack.finalize();
    await writing;
    return files;
  } catch (error) {
    pack.destroy(error instanceof Error ? error : new Error("Package creation failed"));
    await writing.catch(() => undefined);
    await rm(archivePath, { force: true });
    throw error;
  }
}

/** Convert already hash-verified bundle bytes, never the mutable preview directory. */
export async function packageZip(archive: Buffer): Promise<Buffer> {
  if (archive.length > MAX_PACKAGE_BYTES) throw new Error("Package archive exceeds its size limit");
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    outputBytes += chunk.byteLength;
    if (outputBytes > PAPER2AGENT_MAX_DOWNLOAD_BYTES) throw new Error("ZIP download exceeds its size limit");
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  });
  const extractor = tar.extract();
  const names = new Set<string>();
  let count = 0;
  let total = 0;
  extractor.on("entry", (header, stream, next) => {
    void (async () => {
      if (++count > MAX_FILES) throw new Error("Package has too many entries");
      if (header.type !== "file" && header.type !== "directory") throw new Error("Package links and special files are not allowed");
      const size = header.size ?? 0;
      if (!Number.isSafeInteger(size) || size < 0 || (total += size) > MAX_PACKAGE_BYTES) throw new Error("Expanded package exceeds its size limit");
      if (header.type === "directory" && (header.name === "." || header.name === "./")) {
        if (size !== 0) throw new Error("Directory entry contains data");
        stream.resume();
      } else {
        const name = packageRelativePath(header.name);
        if (name.includes(":")) throw new Error("ZIP paths cannot contain drive letters or alternate data streams");
        if (names.has(name)) throw new Error("Package has duplicate paths");
        names.add(name);
        if (header.type === "directory") {
          if (size !== 0) throw new Error("Directory entry contains data");
          stream.resume();
        } else {
          const entry = new ZipDeflate(name, { level: 6 });
          entry.mtime = new Date(1980, 0, 1);
          zip.add(entry);
          let received = 0;
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            received += chunk.length;
            if (received > size) throw new Error("Package entry length mismatch");
            entry.push(chunk);
          }
          if (received !== size) throw new Error("Package entry length mismatch");
          entry.push(new Uint8Array(0), true);
        }
      }
      next();
    })().catch((error: Error) => { stream.destroy(); extractor.destroy(error); });
  });
  try {
    await pipeline(Readable.from([archive]), extractor);
    zip.end();
    return Buffer.concat(chunks, outputBytes);
  } catch (error) {
    zip.terminate();
    throw error;
  }
}
