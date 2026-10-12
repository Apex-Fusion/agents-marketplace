import { requestDeadline } from "./deadline.js";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MAX_PACKAGE_BYTES } from "./archive.js";

export interface DockerCommandResult { code: number; stdout: string; stderr: string }
export interface DockerCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  outputPath?: string;
  input?: Buffer;
}

export async function dockerCommand(args: string[], options: DockerCommandOptions = {}): Promise<DockerCommandResult> {
  const deadline = requestDeadline(options.timeoutMs ?? 120_000, options.signal);
  const signal = deadline.signal;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawn("docker", args, { env, stdio: ["pipe", "pipe", "pipe"], signal });
  let inputError: Error | undefined;
  child.stdin.on("error", (error) => { inputError = error; });
  child.stdin.end(options.input);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const limit = options.maxOutputBytes ?? 256 * 1024;
  let bytes = 0;
  let outputError: Error | undefined;
  child.stderr.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > limit) { outputError = new Error("Docker command output exceeds limit"); child.kill("SIGKILL"); }
    else stderr.push(chunk);
  });
  let writing: Promise<void> | undefined;
  if (options.outputPath) {
    let archiveBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      archiveBytes += chunk.length;
      if (archiveBytes > MAX_PACKAGE_BYTES) {
        outputError = new Error("Container artifact exceeds size limit");
        child.stdout.destroy(outputError); child.kill("SIGKILL");
      }
    });
    writing = pipeline(child.stdout, createWriteStream(options.outputPath, { flags: "wx", mode: 0o600 }));
    void writing.catch(() => undefined);
  } else {
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) { outputError = new Error("Docker command output exceeds limit"); child.kill("SIGKILL"); }
      else stdout.push(chunk);
    });
  }
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolve(value ?? 1));
    });
    await writing;
    if (outputError) throw outputError;
    if (inputError && code === 0) throw inputError;
    return { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  } catch (error) {
    child.kill("SIGKILL");
    await writing?.catch(() => undefined);
    throw error;
  } finally {
    deadline.dispose();
  }
}

export class BuildSandbox {
  readonly name: string;
  private readonly owner: string;
  private readonly attemptToken = randomUUID();
  private created = false;
  constructor(readonly image: string, readonly workDir: string, readonly signal: AbortSignal) {
    this.owner = createHash("sha256").update(resolve(workDir)).digest("hex");
    this.name = `vector-p2a-build-${this.owner.slice(0, 32)}`;
  }

  async start(): Promise<void> {
    this.created = true;
    const created = await dockerCommand(["create", "--name", this.name, "--label", "vector.paper2agent.build=true",
      "--label", `vector.paper2agent.work=${this.owner}`, "--label", `vector.paper2agent.attempt=${this.attemptToken}`,
      "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "128", "--user", "65532:65532",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777",
      "--tmpfs", "/workspace:rw,nosuid,nodev,size=1g,mode=1777",
      "--workdir", "/workspace", "--env", "HOME=/tmp", "--env", "PYTHONDONTWRITEBYTECODE=1",
      "--env", "PYTHONUNBUFFERED=1", "--env", "PYTHONPATH=/workspace/deps:/workspace/output",
      this.image, "sleep", "infinity"], { signal: this.signal });
    if (created.code !== 0) throw new Error(`Cannot create isolated build container: ${created.stderr.slice(0, 2000)}`);
    const started = await dockerCommand(["start", this.name], { signal: this.signal });
    if (started.code !== 0) throw new Error(`Cannot start isolated build container: ${started.stderr.slice(0, 2000)}`);
    const dirs = await this.python("import os\nfor name in ('output','wheels','deps','verification'):\n p='/workspace/'+name; os.mkdir(p); os.chmod(p,0o1777)", [], true);
    if (dirs.code !== 0) throw new Error(dirs.stderr);
  }

  async exec(command: string, timeoutMs = 60_000): Promise<DockerCommandResult> {
    if (!this.created || command.length > 20_000) throw new Error("Invalid sandbox command");
    const seconds = Math.max(1, Math.min(120, Math.ceil(timeoutMs / 1000)));
    return dockerCommand(["exec", this.name, "timeout", "--signal=KILL", `${seconds}s`, "sh", "-lc", command],
      { signal: this.signal, timeoutMs: (seconds + 5) * 1000, maxOutputBytes: 128 * 1024 });
  }

  async python(script: string, args: string[] = [], root = false): Promise<DockerCommandResult> {
    return dockerCommand(["exec", ...(root ? ["--user", "0:0"] : []), this.name,
      "timeout", "--signal=KILL", "60s", "python", "-I", "-c", script, ...args],
    { signal: this.signal, timeoutMs: 65_000, maxOutputBytes: 512 * 1024 });
  }

  async putBytes(bytes: Buffer, destination: string): Promise<void> {
    if (!/^\/workspace\/[A-Za-z0-9_.\/+!-]+$/.test(destination) || destination.split("/").includes("..")) throw new Error("Invalid sandbox destination");
    if (bytes.length > MAX_PACKAGE_BYTES) throw new Error("Sandbox input exceeds size limit");
    // Docker's archive-copy API rejects a read-only rootfs, even for writable tmpfs.
    // Stream through a trusted isolated helper instead; no host mount is needed.
    const script = "import os,sys,shutil\nfd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o444)\nwith os.fdopen(fd,'wb') as output: shutil.copyfileobj(sys.stdin.buffer,output,65536)";
    const result = await dockerCommand(["exec", "-i", "--user", "0:0", this.name,
      "python", "-I", "-c", script, destination], { signal: this.signal, input: bytes, timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(`Cannot transfer sandbox input: ${result.stderr.slice(0, 2000)}`);
  }

  async readFile(path: string): Promise<string> {
    const result = await this.python(`import pathlib,sys\np=pathlib.Path(sys.argv[1]).resolve()\nif not p.is_relative_to('/workspace') or not p.is_file() or p.stat().st_size>65536: raise ValueError('not a bounded workspace file')\nprint(p.read_text(),end='')`, [path]);
    if (result.code !== 0) throw new Error(result.stderr.slice(0, 4000));
    return result.stdout;
  }

  async writeFile(path: string, content: string, verificationOnly = false): Promise<void> {
    if (Buffer.byteLength(content) > 65536) throw new Error("File exceeds model write limit");
    const result = await this.python(`import pathlib,sys,base64\np=pathlib.Path(sys.argv[1]).resolve()\nroot=pathlib.Path(sys.argv[3])\nif not p.is_relative_to(root): raise ValueError('write outside allowed workspace')\np.parent.mkdir(parents=True,exist_ok=True)\np.write_bytes(base64.b64decode(sys.argv[2]))`,
      [path, Buffer.from(content).toString("base64"), verificationOnly ? "/workspace/verification" : "/workspace/output"]);
    if (result.code !== 0) throw new Error(result.stderr.slice(0, 4000));
  }

  async freezeAndExport(archivePath: string): Promise<void> {
    // tmpfs disappears on container stop. Stop every untrusted process first,
    // then stream the archive through a fresh, isolated standard-library process.
    const script = `import os,pathlib,signal,stat,sys,tarfile
me=os.getpid()
for attempt in range(256):
    running=[]
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit() or int(p.name) in (1,me): continue
        try:
            status=(p/'status').read_text()
            state=next(x for x in status.splitlines() if x.startswith('State:')).split()[1]
            if state not in ('T','t','Z','X'): running.append(int(p.name))
        except (FileNotFoundError,ProcessLookupError): pass
    if not running: break
    for pid in running:
        try: os.kill(pid,signal.SIGSTOP)
        except ProcessLookupError: pass
else: raise RuntimeError('cannot freeze generated processes')
root=pathlib.Path('/workspace/output')
count=total=0
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as archive:
    for path in sorted(root.rglob('*')):
        info=path.lstat()
        if stat.S_ISDIR(info.st_mode): continue
        if not stat.S_ISREG(info.st_mode): raise ValueError('package contains a link or special file')
        relative=path.relative_to(root)
        # Review and run source, never a stale or source-mismatched bytecode cache.
        if '__pycache__' in relative.parts or path.suffix in ('.pyc','.pyo'): continue
        count+=1; total+=info.st_size
        if count>10000 or total>67108864: raise ValueError('package exceeds limits')
        member=archive.gettarinfo(str(path),str(relative))
        member.uid=member.gid=0; member.uname=member.gname=''; member.mtime=0; member.mode=420
        with path.open('rb') as source: archive.addfile(member,source)
`;
    const copied = await dockerCommand(["exec", this.name, "python", "-I", "-c", script],
      { outputPath: archivePath, timeoutMs: 60_000, signal: this.signal });
    if (copied.code !== 0) throw new Error(`Cannot export generated package: ${copied.stderr.slice(0, 2000)}`);
  }

  static async recover(workDir: string): Promise<void> {
    const sandbox = new BuildSandbox("", workDir, new AbortController().signal);
    sandbox.created = true;
    await sandbox.removeOwned(false);
  }

  async close(): Promise<void> {
    await this.removeOwned(true);
  }

  private async removeOwned(requireAttemptToken: boolean): Promise<void> {
    if (!this.created) return;
    const inspected = await dockerCommand(["inspect", "--type", "container", "--format", "{{json .Config.Labels}}", this.name],
      { timeoutMs: 15_000 });
    if (inspected.code !== 0) {
      if (inspected.stderr.includes("No such")) { this.created = false; return; }
      throw new Error(`Cannot inspect owned build container: ${inspected.stderr.slice(0, 2000)}`);
    }
    const labels = JSON.parse(inspected.stdout) as Record<string, string> | null;
    if (labels?.["vector.paper2agent.build"] !== "true" || labels["vector.paper2agent.work"] !== this.owner ||
        (requireAttemptToken && labels["vector.paper2agent.attempt"] !== this.attemptToken)) {
      throw new Error("Refusing to remove a container not owned by this build attempt");
    }
    const result = await dockerCommand(["rm", "--force", this.name], { timeoutMs: 30_000 });
    if (result.code !== 0 && !result.stderr.includes("No such container")) throw new Error(`Cannot remove owned build container: ${result.stderr.slice(0, 2000)}`);
    this.created = false;
  }
}
