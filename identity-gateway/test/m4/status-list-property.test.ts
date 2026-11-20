// Property of the follow steps: after any sequence of record changes and any moves of the chain tip,
// the lists that a service has made by follow steps (and now and then a full build) are the lists of
// a full build of the same ledger at the same tip, byte for byte: the same ledger point, the same
// indices, the same Token Status List bytes and the same Bitstring Status List bytes. The records are
// roots, subagents, legacy records and adopted records; the changes are holds (that end by their
// time), the end of a record, the lift of a hold, a new subagent epoch, parties that cover only a
// time window, moves of the token out of its record output, the burn of a legacy token and an
// adoption. A record that has ended gets no later change, as the identity contract has it.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { IdentityDatum } from "../../src/codec/identity-datum.js";
import { STATUS, statusValue, type StatusLists } from "../../src/m4/status-lists.js";
import { VectorResolver } from "../../src/resolve/resolver.js";
import { IDENTITY, LedgerBuilder, identityDatum, idOf, legacyDatum, party, timeAt } from "../support/ledger.js";
import { tombstoneOf } from "../support/resolve.js";
import { bslBits, child, clockAt, decode, fullBuildOf, hold, listsOn, retirement, revocation, tslValue, type DecodedLists } from "./status-list-support.js";

type Kind =
  | "register"
  | "child"
  | "suspend"
  | "unsuspend"
  | "revoke"
  | "retire"
  | "bump"
  | "dropParty"
  | "restoreParty"
  | "partyWindow"
  | "moveOut"
  | "moveBack"
  | "burnLegacy"
  | "adopt"
  | "build";

/** A change that needs a record in some state (a hold to lift, a token that is out) is in the list more than once, so that it applies often. */
const KINDS: readonly Kind[] = [
  "register",
  "child",
  "suspend",
  "suspend",
  "unsuspend",
  "unsuspend",
  "unsuspend",
  "revoke",
  "retire",
  "bump",
  "dropParty",
  "restoreParty",
  "partyWindow",
  "moveOut",
  "moveBack",
  "moveBack",
  "moveBack",
  "burnLegacy",
  "adopt",
  "build",
];

interface Step {
  readonly kind: Kind;
  /** Which of the records that the change fits. */
  readonly pick: number;
  /** Blocks that the chain tip moves on after the change. */
  readonly advance: number;
  /** A follow step runs after this change (and a check against a full build). */
  readonly follow: boolean;
  /** Blocks that a hold or a party window lasts. */
  readonly length: number;
  readonly flag: boolean;
}

const stepArb: fc.Arbitrary<Step> = fc.record({
  kind: fc.constantFrom(...KINDS),
  pick: fc.nat(1_000),
  advance: fc.oneof(
    { weight: 3, arbitrary: fc.constant(0) },
    { weight: 3, arbitrary: fc.integer({ min: 1, max: 5 }) },
    { weight: 2, arbitrary: fc.integer({ min: 6, max: 40 }) },
  ),
  follow: fc.boolean(),
  length: fc.integer({ min: 1, max: 60 }),
  flag: fc.boolean(),
});

interface Agent {
  readonly id: string;
  legacy: boolean;
  burned: boolean;
  datum: IdentityDatum;
  readonly depth: number;
  epoch: number;
  ended: boolean;
  /** The token is outside its record output. */
  out: boolean;
  suspended: boolean;
}

/** The ledger and the model of it. The chain starts at block 450; the cutoff of the legacy registry is at block 500. */
class World {
  readonly b = new LedgerBuilder();
  readonly clock = { now: clockAt(450) };
  readonly agents: Agent[] = [];
  /** The newest block with a transaction. */
  private last = 450;
  private count = 0;

  constructor() {
    this.b.tip(450);
    // Two roots, a subagent of the first, two live legacy records and a burned one.
    const root = this.add(null, 100);
    this.add(null, 110);
    this.add(root, 120);
    for (const [i, height] of [50, 55].entries()) {
      const id = idOf(`property legacy ${i}`);
      this.b.legacyRegister(id, legacyDatum(), { height });
      this.agents.push({ id, legacy: true, burned: false, datum: identityDatum(), depth: 0, epoch: 0, ended: false, out: false, suspended: false });
    }
    const burned = idOf("property legacy burned");
    this.b.legacyRegister(burned, legacyDatum(), { height: 60 });
    this.b.legacyDeregister(burned, { height: 70 });
    this.agents.push({ id: burned, legacy: true, burned: true, datum: identityDatum(), depth: 0, epoch: 0, ended: true, out: false, suspended: false });
  }

  get tip(): number {
    return this.b.chain.tipInfo.blockHeight;
  }

  moveTo(height: number): void {
    this.b.tip(height);
    this.clock.now = clockAt(height);
  }

  /** The block of the next transaction: after the tip and after every earlier transaction. */
  private block(): number {
    this.last = Math.max(this.last, this.tip) + 1;
    return this.last;
  }

  /** A new record at `height`, a root or a subagent of `parent`. */
  private add(parent: Agent | null, height: number): Agent {
    const id = idOf(`property agent ${this.count++}`);
    const depth = parent === null ? 0 : parent.depth + 1;
    const datum = parent === null ? identityDatum({ createdAt: timeAt(height) }) : child(parent.id, depth, parent.epoch, { createdAt: timeAt(height) });
    this.b.register(id, datum, { height });
    const agent: Agent = { id, legacy: false, burned: false, datum, depth, epoch: 0, ended: false, out: false, suspended: false };
    this.agents.push(agent);
    return agent;
  }

  /** The change of a step, in the next block. Returns true when the step is a full build. */
  async apply(step: Step, service: StatusLists): Promise<boolean> {
    const live = this.agents.filter((a) => !a.legacy && !a.ended);
    const active = live.filter((a) => !a.out);
    const pick = <T>(of: readonly T[]): T | undefined => (of.length === 0 ? undefined : of[step.pick % of.length]);
    const update = (agent: Agent, datum: IdentityDatum, height: number): void => {
      agent.datum = datum;
      this.b.update(agent.id, datum, { height });
    };
    switch (step.kind) {
      case "register":
        this.add(null, this.block());
        break;
      case "child": {
        const parent = pick(active.filter((a) => a.depth < 2));
        if (parent) this.add(parent, this.block());
        break;
      }
      case "suspend": {
        const agent = pick(active);
        if (!agent) break;
        const height = this.block();
        agent.suspended = true;
        update(agent, { ...agent.datum, status: hold(timeAt(height) + step.length * 10_000) }, height);
        break;
      }
      case "unsuspend": {
        const agent = pick(active.filter((a) => a.suspended));
        if (!agent) break;
        agent.suspended = false;
        update(agent, { ...agent.datum, status: { type: "Active" } }, this.block());
        break;
      }
      case "revoke":
      case "retire": {
        const agent = pick(active);
        if (!agent) break;
        const height = this.block();
        const status = step.kind === "retire" ? retirement(height) : revocation(height, step.flag ? timeAt(height) - 50_000 : null);
        agent.ended = true;
        update(agent, tombstoneOf(agent.datum, status), height);
        break;
      }
      case "bump": {
        const agent = pick(active);
        if (!agent) break;
        agent.epoch++;
        update(agent, { ...agent.datum, subagentEpoch: agent.epoch }, this.block());
        break;
      }
      case "dropParty": {
        const agent = pick(active);
        if (agent) update(agent, { ...agent.datum, parties: [] }, this.block());
        break;
      }
      case "restoreParty": {
        const agent = pick(active);
        if (agent) update(agent, { ...agent.datum, parties: [party()] }, this.block());
        break;
      }
      case "partyWindow": {
        const agent = pick(active);
        if (!agent) break;
        const height = this.block();
        const at = timeAt(height) + step.length * 10_000;
        update(agent, { ...agent.datum, parties: [step.flag ? { ...party(), notBefore: at } : { ...party(), notAfter: at }] }, height);
        break;
      }
      case "moveOut": {
        const agent = pick(active);
        if (!agent) break;
        agent.out = true;
        this.b.moveOut(agent.id, { height: this.block() });
        break;
      }
      case "moveBack": {
        const agent = pick(live.filter((a) => a.out));
        if (!agent) break;
        agent.out = false;
        this.b.moveBack(agent.id, IDENTITY.address, { height: this.block() });
        break;
      }
      case "burnLegacy": {
        const agent = pick(this.agents.filter((a) => a.legacy && !a.burned));
        if (!agent) break;
        agent.burned = true;
        agent.ended = true;
        this.b.legacyDeregister(agent.id, { height: this.block() });
        break;
      }
      case "adopt": {
        const agent = pick(this.agents.filter((a) => a.legacy && !a.burned));
        if (!agent) break;
        const height = this.block();
        agent.legacy = false;
        agent.datum = identityDatum({ createdAt: timeAt(height) });
        this.b.adopt(agent.id, agent.datum, { height });
        break;
      }
      case "build":
        await service.refresh();
        return true;
    }
    return false;
  }

  /** The block after which everything is final: every change has 30 confirmations and every hold has ended. */
  settled(): number {
    return Math.max(this.last, this.tip) + 100;
  }
}

/** Where two decoded lists differ: the first entries of each format, as text. */
function differences(mine: DecodedLists, full: DecodedLists): string[] {
  const found: string[] = [];
  if (mine.tsl.length !== full.tsl.length || mine.bsl.length !== full.bsl.length) found.push(`list counts ${mine.tsl.length}/${full.tsl.length}`);
  for (let n = 0; n < Math.min(mine.tsl.length, full.tsl.length) && found.length < 10; n++) {
    if (mine.tsl[n]!.equals(full.tsl[n]!) && mine.bsl[n]!.equals(full.bsl[n]!)) continue;
    for (let p = 0; p < 4096 && found.length < 10; p++) {
      const i = n * 131_072 + p;
      const a = [tslValue(mine, i), ...bslBits(mine, i)];
      const b = [tslValue(full, i), ...bslBits(full, i)];
      if (a.join() !== b.join()) found.push(`index ${i}: follow [${a}] full build [${b}]`);
    }
  }
  return found;
}

/** The lists of the service are the lists of a full build at the same tip; also the indices, and the bits agree with another resolver. */
async function sameAsFullBuild(world: World, service: StatusLists, label: string): Promise<void> {
  const full = await fullBuildOf(world.b, world.clock);
  const mine = await decode(service);
  expect(mine.iat, `${label}: ledger point`).toBe(full.decoded.iat);
  expect(mine.exp, `${label}: validity`).toBe(full.decoded.exp);
  expect(differences(mine, full.decoded), label).toEqual([]);
  expect(mine.tsl.every((bytes, n) => bytes.equals(full.decoded.tsl[n]!)), `${label}: Token Status List bytes`).toBe(true);
  expect(mine.bsl.every((bytes, n) => bytes.equals(full.decoded.bsl[n]!)), `${label}: Bitstring Status List bytes`).toBe(true);
  const resolver = new VectorResolver(world.b.chain, world.b.settings, { log: () => undefined });
  for (const agent of world.agents) {
    const index = await service.indexOf(agent.id);
    expect(index, `${label}: index`).toBe(await full.lists.indexOf(agent.id));
    if (index === null) continue;
    const lookup = await resolver.currentStatus(agent.id);
    expect(tslValue(mine, index), `${label}: the resolver and the lists`).toBe(lookup.found ? statusValue(lookup.effective.status) : STATUS.suspended);
  }
}

async function run(steps: readonly Step[]): Promise<void> {
  const world = new World();
  const logs: string[] = [];
  const info: string[] = [];
  const service = listsOn(world.b, { clock: world.clock, logs, info });
  await service.refresh();
  await sameAsFullBuild(world, service, "the first build");
  for (const [i, step] of steps.entries()) {
    const built = await world.apply(step, service);
    world.moveTo(world.tip + step.advance);
    if (step.follow || built) {
      await service.follow();
      await sameAsFullBuild(world, service, `step ${i} (${step.kind}) at tip ${world.tip}`);
    }
  }
  world.moveTo(world.settled());
  await service.follow();
  await sameAsFullBuild(world, service, `the end at tip ${world.tip}`);
  // No step found that the records do not fit the lists, and no read failed.
  expect(logs).toEqual([]);
  expect(info.filter((line) => line.includes("(repair)"))).toEqual([]);
}

describe("a service that follows the chain gives the lists of a full build", () => {
  test("after any sequence of changes of the records and moves of the tip", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 24 }), async (steps) => {
        await run(steps);
      }),
      { numRuns: 40 },
    );
  }, 120_000);

  test("with a step after every change and a tip that moves one block at a time", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 20 }), async (steps) => {
        await run(steps.map((step) => ({ ...step, advance: Math.min(step.advance, 1), follow: true })));
      }),
      { numRuns: 20 },
    );
  }, 120_000);
});
