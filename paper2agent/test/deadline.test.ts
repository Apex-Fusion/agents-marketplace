import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestDeadline } from "../src/deadline.js";

const execFileAsync = promisify(execFile);
afterEach(() => vi.useRealTimers());

describe("request deadlines", () => {
  it("cancels a live HTTP request even when garbage collection runs", async () => {
    // Native AbortSignal GC is outside fake-timer control. Await real fetch cancellation.
    const moduleUrl = new URL("../src/deadline.ts", import.meta.url).href;
    const program = `
      import {createServer} from 'node:http';
      import {requestDeadline} from ${JSON.stringify(moduleUrl)};
      const server=createServer(()=>{});
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      const deadline=requestDeadline(100,new AbortController().signal);
      const collecting=setInterval(()=>global.gc(),10);
      try {
        await fetch('http://127.0.0.1:'+server.address().port,{signal:deadline.signal});
        console.log('missed deadline');
      } catch(error) { console.log(error.name); }
      finally {clearInterval(collecting);deadline.dispose();server.closeAllConnections();server.close();}
    `;
    const result = await execFileAsync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", program], { timeout: 10_000 });
    expect(result.stdout.trim()).toBe("TimeoutError");
  }, 15_000);

  it("preserves caller cancellation and releases timers when disposed", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const first = requestDeadline(100, parent.signal);
    const reason = new Error("operator cancelled");
    parent.abort(reason);
    expect(first.signal.reason).toBe(reason);
    first.dispose();
    const detachedParent = new AbortController();
    const detached = requestDeadline(100, detachedParent.signal);
    detached.dispose();
    detachedParent.abort(reason);
    vi.advanceTimersByTime(200);
    expect(detached.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
