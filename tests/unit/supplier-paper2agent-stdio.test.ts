import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_TOOL_JSON_DEPTH, type JsonObject } from "@marketplace/shared/paper2agent";
import { LocalToolSession } from "../../supplier/src/paper2agent/local.js";
import { BoundedStdioTransport, MCP_FRAME_BYTES, MCP_JSON_DEPTH, MCP_STDERR_BYTES } from "../../supplier/src/paper2agent/transport.js";
import type { Paper2AgentConfig } from "../../supplier/src/config.js";

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function configFor(source: string): Paper2AgentConfig {
  const cwd = mkdtempSync(join(tmpdir(), "supplier-mcp-stdio-"));
  directories.push(cwd);
  return { executable: process.execPath, argv: ["--input-type=module", "-e", source], cwd,
    packagePath: join(cwd, "package.bin"), manifestPath: join(cwd, "manifest.json"), journalDir: join(cwd, "journal") };
}

// A protocol peer fixture, not a production fallback. The production side uses
// the official MCP Client to initialize, discover and call this local process.
// These process integration cases use the platform clock deliberately: fake
// timers cannot drive a separate OS process, SIGKILL delivery, or process reaping.
function peerSource(mode: "echo" | "hang") {
  return `
    import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    writeFileSync('pid', String(process.pid));
    const schema = {type:'object', properties:{value:{type:'string'}}, required:['value'], additionalProperties:false};
    createInterface({input:process.stdin}).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.id === undefined) return;
      let result;
      if (msg.method === 'initialize') result = {protocolVersion:msg.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'test-peer',version:'1'}};
      else if (msg.method === 'tools/list') result = {tools:[{name:'echo_record', inputSchema:schema, outputSchema:schema}]};
      else if (msg.method === 'tools/call') {
        if (${JSON.stringify(mode)} === 'hang') return;
        const keys = ['SUPPLIER_PRIV_KEY_HEX','OPENAI_API_KEY','DATALAB_API_KEY','BUYER_API_KEY','NODE_OPTIONS'];
        result = {content:[{type:'text',text:'ok'}], structuredContent:{value: keys.some(key => process.env[key]) ? 'secret-leaked' : msg.params.arguments.value}};
      } else result = {};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
    });
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((close) => close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bounded supplier MCP process transport", () => {
  it("uses real initialize/list/call, omits provider and wallet secrets, and reaps an uncooperative child", async () => {
    const config = configFor(peerSource("echo"));
    const session = new LocalToolSession(config);
    cleanups.push(() => session.close());
    const old = process.env.SUPPLIER_PRIV_KEY_HEX;
    process.env.SUPPLIER_PRIV_KEY_HEX = "test-secret-never-forward";
    try {
      expect((await session.discover()).map((tool) => tool.name)).toEqual(["echo_record"]);
      expect(await session.execute("echo_record", { value: "hello" }, 1000)).toEqual({ value: "hello" });
      await expect(session.execute("echo_record", { value: "again" }, 1000)).rejects.toThrow(/available/);
      const pid = Number(readFileSync(join(config.cwd, "pid"), "utf8"));
      await session.close();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (old === undefined) delete process.env.SUPPLIER_PRIV_KEY_HEX;
      else process.env.SUPPLIER_PRIV_KEY_HEX = old;
    }
  });

  it("bounds a hung tool call and stops the process after timeout", async () => {
    const config = configFor(peerSource("hang"));
    const session = new LocalToolSession(config);
    cleanups.push(() => session.close());
    await session.discover();
    const pid = Number(readFileSync(join(config.cwd, "pid"), "utf8"));
    await expect(session.execute("echo_record", { value: "hello" }, 25)).rejects.toThrow();
    await session.close();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.each([
    ["stdout", MCP_FRAME_BYTES + 1, /frame limit/],
    ["stderr", MCP_STDERR_BYTES + 1, /stderr limit/],
  ] as const)("rejects excess %s before accumulating unbounded data", async (stream, count, expected) => {
    const config = configFor(`process.${stream}.write(Buffer.alloc(${count}, 120)); setInterval(() => {}, 1000);`);
    const transport = new BoundedStdioTransport(config);
    cleanups.push(() => transport.close());
    const failure = new Promise<Error>((resolve) => { transport.onerror = resolve; });
    await transport.start();
    expect((await failure).message).toMatch(expected);
    await transport.close();
  });

  it("keeps a schema and a result at the shared depth limit inside MCP framing", async () => {
    // Innermost containers at depth MAX_TOOL_JSON_DEPTH: an empty properties
    // object at manifest depth (schema root is depth 1), and a result object.
    let schema: JsonObject = { type: "object", properties: {} };
    for (let depth = 2; depth < MAX_TOOL_JSON_DEPTH; depth += 2) schema = { type: "object", properties: { a: schema } };
    let result: JsonObject = {};
    for (let depth = 0; depth < MAX_TOOL_JSON_DEPTH; depth++) result = { a: result };
    const config = configFor(`
      import { createInterface } from 'node:readline';
      const tool = {name:'deep_record', inputSchema:{type:'object'}, outputSchema:${JSON.stringify(schema)}};
      createInterface({input:process.stdin}).on('line', line => {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        let result = {};
        if (msg.method === 'initialize') result = {protocolVersion:msg.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'test-peer',version:'1'}};
        else if (msg.method === 'tools/list') result = {tools:[tool]};
        else if (msg.method === 'tools/call') result = {content:[], structuredContent:${JSON.stringify(result)}};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
      });
      setInterval(() => {}, 1000);
    `);
    const session = new LocalToolSession(config);
    cleanups.push(() => session.close());
    expect((await session.discover())[0].outputSchema).toEqual(schema);
    expect(await session.execute("deep_record", {}, 1000)).toEqual(result);
  });

  it("rejects nesting beyond the protocol allowance before protocol validation", async () => {
    const text = '['.repeat(MCP_JSON_DEPTH + 1) + '0' + ']'.repeat(MCP_JSON_DEPTH + 1) + '\n';
    const config = configFor(`process.stdout.write(${JSON.stringify(text)}); setInterval(() => {}, 1000);`);
    const transport = new BoundedStdioTransport(config);
    cleanups.push(() => transport.close());
    const failure = new Promise<Error>((resolve) => { transport.onerror = resolve; });
    await transport.start();
    expect((await failure).message).toMatch(/nesting limit/);
    await transport.close();
  });
});
