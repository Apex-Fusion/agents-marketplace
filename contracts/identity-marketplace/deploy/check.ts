/**
 * The read-only check of a deployment (Part 2 §3.8 step 6, §11 step 3).
 *
 * - The config seed: unspent at the seal-seed address before the seal.
 * - Each recorded reference output holds the expected script at the reference address.
 * - The configuration record at the exact `config_holder` address holds the
 *   configuration token and the inline datum M1, and M1 equals
 *   `hashes.identity_party` of the Module-1 manifest. Before the seal the
 *   check reports it as "not yet".
 * - The values of Part 1 §4 and an env snippet with the names that the
 *   consumers read (.env examples, compose files and READMEs of
 *   agents-marketplace, the MCP server and both SDKs).
 *
 * Exit status 1 when a published value is wrong or missing; "not yet" is no error.
 */

import { CONFIG_TOKEN_NAME, readConfigRecord } from "@marketplace/shared";
import { ap3x, holdsScript, openState, requirePlan, seedStatus, verifyPlan, type CommonOptions, type Io, type PlannedDeployment } from "./context.js";
import { manifestDifferences, readModule1Manifest, type Module1Manifest } from "./manifest.js";
import { buildEnv } from "./steps.js";
import { parseRef, REFERENCE_NAMES, refText } from "./state.js";

export interface EnvLine {
  name: string;
  /** null: not known yet; `why` says what gives it. */
  value: string | null;
  why?: string;
}

export interface EnvGroup {
  consumer: string;
  /** Where the names come from. */
  sources: string;
  lines: EnvLine[];
}

/** The env names of each consumer, with the values of the deployment. */
export function envGroups(state: PlannedDeployment, manifest: Module1Manifest | null): EnvGroup[] {
  const ref = (name: (typeof REFERENCE_NAMES)[number]): EnvLine["value"] => state.refs[name] ?? null;
  const notPublished = "publish-refs";
  const m1Ref = manifest?.identityPartyRef ?? null;
  const m1Why = "identity_party_ref of the Module-1 manifest (--module1-manifest)";
  const configRecord = state.seal?.config_record ?? null;
  return [
    {
      consumer: "agents-marketplace supplier, buyer, gateway and Paper2Agent publisher",
      sources: "supplier/.env.example, buyer/.env.example, deploy/mainnet/docker-compose.*.yml, deploy/inference-proxy/docker-compose.supplier-*.yml",
      lines: [
        { name: "IDENTITY_POLICY_ID", value: state.identity_hash },
        { name: "IDENTITY_REF_UTXO", value: ref("identity"), why: notPublished },
        { name: "IDENTITY_ESCROW_REF_UTXO", value: ref("escrow"), why: notPublished },
        { name: "IDENTITY_ADVERT_REF_UTXO", value: ref("advert"), why: notPublished },
      ],
    },
    {
      consumer: "identity-gateway",
      sources: "identity-gateway/.env.example, identity-gateway/README.md, deploy/mainnet/docker-compose.gateway-identity.yml",
      lines: [
        { name: "IDENTITY_POLICY_ID", value: state.identity_hash },
        { name: "IDENTITY_ADDRESS", value: state.identity_address },
        { name: "CUTOFF_SLOT", value: String(state.cutoff_slot) },
        { name: "DELEGATION_POLICY_ID", value: state.delegation_hash },
        { name: "DELEGATION_ADDRESS", value: state.scripts.delegation.address },
      ],
    },
    {
      consumer: "indexer",
      sources: "indexer/.env.example, deploy/mainnet/docker-compose.indexer.yml",
      lines: [
        { name: "IDENTITY_POLICY_ID", value: state.identity_hash },
        { name: "IDENTITY_ADDRESS", value: state.identity_address },
        { name: "IDENTITY_ADVERT_SCRIPT_ADDRESS", value: state.scripts.advert.address },
        { name: "IDENTITY_ESCROW_SCRIPT_ADDRESS", value: state.scripts.escrow.address },
      ],
    },
    {
      consumer: "MCP server (@apexfusion/vector-mcp-builder)",
      sources: "mcp/.env.example, mcp/README.md",
      lines: [
        { name: "VECTOR_IDENTITY_LEGACY_ROOT", value: state.legacy_root },
        { name: "VECTOR_IDENTITY_CONFIG_SEED", value: state.config_seed },
        { name: "VECTOR_IDENTITY_POLICY_ID", value: state.identity_hash },
        { name: "VECTOR_IDENTITY_ALLOWLIST_URL", value: null, why: "the https URL where allowlist-ids.json is published" },
        { name: "VECTOR_IDENTITY_REF_UTXO", value: ref("identity"), why: notPublished },
        { name: "VECTOR_IDENTITY_ATTESTATION_REF_UTXO", value: ref("attestation"), why: notPublished },
        { name: "VECTOR_IDENTITY_DELEGATION_REF_UTXO", value: ref("delegation"), why: notPublished },
        { name: "VECTOR_IDENTITY_VAULT_REF_UTXO", value: ref("vault"), why: notPublished },
        { name: "VECTOR_IDENTITY_ESCROW_REF_UTXO", value: ref("escrow"), why: notPublished },
        { name: "VECTOR_IDENTITY_ADVERT_REF_UTXO", value: ref("advert"), why: notPublished },
        { name: "VECTOR_IDENTITY_MODULE1_REF_UTXO", value: m1Ref, why: m1Why },
      ],
    },
    {
      consumer: "TypeScript SDK (@apexfusion/agent-sdk) and Python SDK (apex-fusion-agent-sdk)",
      sources: "sdk-ts/.env.example, sdk-ts/README.md, sdk-py/README.md",
      lines: [
        { name: "VECTOR_IDENTITY_LEGACY_ROOT", value: state.legacy_root },
        { name: "VECTOR_IDENTITY_CONFIG_SEED", value: state.config_seed },
        { name: "VECTOR_IDENTITY_POLICY_ID", value: state.identity_hash },
        { name: "VECTOR_IDENTITY_LEGACY_HASH", value: state.legacy_hash },
        { name: "VECTOR_IDENTITY_REF_UTXO", value: ref("identity"), why: notPublished },
        { name: "VECTOR_ATTESTATION_REF_UTXO", value: ref("attestation"), why: notPublished },
        { name: "VECTOR_DELEGATION_REF_UTXO", value: ref("delegation"), why: notPublished },
        { name: "VECTOR_VAULT_REF_UTXO", value: ref("vault"), why: notPublished },
        { name: "VECTOR_MODULE1_REF_UTXO", value: m1Ref, why: m1Why },
        { name: "VECTOR_IDENTITY_CONFIG_UTXO", value: configRecord, why: "the seal" },
        { name: "VECTOR_LEGACY_REGISTRY_REF_UTXO", value: null, why: "the reference script of the legacy registry, which is not part of this deployment" },
      ],
    },
    {
      consumer: "Python SDK, Module-6 client",
      sources: "sdk-py/.env.example (the other VECTOR_MODULE6_* values come from the Module-6 deployment)",
      lines: [{ name: "VECTOR_MODULE6_IDENTITY_HASH", value: state.identity_hash }],
    },
  ];
}

export function renderEnv(groups: readonly EnvGroup[]): string[] {
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`# ${group.consumer} (${group.sources})`);
    for (const line of group.lines) lines.push(line.value === null ? `# ${line.name}=  (not yet: ${line.why ?? "unknown"})` : `${line.name}=${line.value}`);
  }
  return lines;
}

export async function check(o: CommonOptions & { manifest?: string }, io: Io, env: Record<string, string | undefined>): Promise<number> {
  const { network, file } = openState(o, env);
  const state = requirePlan(file.loadFor(network.name, network.networkId), file.path);
  verifyPlan(state);
  const manifest = o.manifest === undefined ? null : readModule1Manifest(o.manifest);
  const chain = io.chain(network);
  const { tipSlot } = await buildEnv(network, chain);
  const problems: string[] = [];
  const fail = (message: string): void => {
    problems.push(message);
    io.out(`  PROBLEM: ${message}`);
  };
  io.out(`deployment: ${file.path} (${network.name}, Ogmios ${chain.label} at slot ${tipSlot})`);

  io.out("config seed:");
  const seedState = await seedStatus(chain, state);
  if (seedState.utxo !== null) {
    if (seedState.atSealSeed) io.out(`  ${state.config_seed}: unspent at the seal-seed address ${state.seal_seed_address} (${ap3x(seedState.utxo.lovelace)} AP3X)`);
    else fail(`the seed ${state.config_seed} is at ${seedState.utxo.address}, not at the seal-seed address ${state.seal_seed_address ?? "(none recorded)"}`);
  }

  const to = state.reference_address;
  io.out(`reference scripts at ${to ?? "(no address recorded)"}:`);
  for (const name of REFERENCE_NAMES) {
    const recorded = state.refs[name];
    const script = state.scripts[name];
    if (recorded === undefined) {
      io.out(`  ${name}: not yet`);
      continue;
    }
    const output = await chain.utxo(parseRef(recorded, `refs.${name}`));
    if (output === null) fail(`${name}: ${recorded} is not on chain`);
    else if (to === null || !holdsScript(output, script, to)) fail(`${name}: ${recorded} does not hold the script ${script.hash} at ${to ?? "?"}`);
    else io.out(`  ${name}: ${recorded} holds ${script.hash} (${ap3x(output.lovelace)} AP3X)`);
  }

  io.out(`configuration record at ${state.config_holder_address}:`);
  const records = (await chain.utxosAt(state.config_holder_address))
    .filter((u) => Object.keys(u.assets).some((unit) => unit.replace(".", "") === `${state.config_policy}${CONFIG_TOKEN_NAME}`));
  let m1: string | null = null;
  if (records.length === 0) {
    if (state.seal !== null) fail(`the seal ${state.seal.tx} is recorded, but the config_holder address holds no configuration token`);
    else io.out("  not yet (the seal waits for Module-1)");
    if (seedState.utxo === null && state.seal === null) fail(`the seed ${state.config_seed} is spent or not on chain, and there is no configuration record: config_seal can never mint`);
  } else if (records.length > 1) {
    fail(`the config_holder address holds ${records.length} configuration tokens`);
  } else {
    const record = records[0]!;
    try {
      m1 = readConfigRecord(record, state.config_policy, state.config_holder);
      io.out(`  ${refText(record.ref)} holds identity-config and the inline datum M1 = ${m1}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (m1 !== null && state.seal !== null && state.seal.module1_hash !== m1) fail(`the state records M1 ${state.seal.module1_hash}, the record names ${m1}`);
    if (m1 !== null && manifest !== null) {
      if (manifest.m1 === m1) io.out(`  M1 equals hashes.identity_party of ${manifest.path}`);
      else fail(`M1 ${m1} differs from hashes.identity_party ${manifest.m1} of ${manifest.path}`);
    }
    if (m1 !== null && manifest === null) io.out("  give --module1-manifest <file> to compare M1 with the Module-1 deployment");
  }
  if (manifest !== null) for (const difference of manifestDifferences(state, manifest)) fail(`Module-1 manifest: ${difference}`);

  io.out("published values (Part 1 §4):");
  io.out(`  identity registry policy ID: ${state.identity_hash}`);
  io.out(`  identity registry address: ${state.identity_address}`);
  io.out(`  cutoff slot: ${state.cutoff_slot}`);
  io.out(`  allowlist: ${state.allowlist?.count ?? "?"} identifiers, root ${state.legacy_root} (${state.allowlist?.file ?? "allowlist.json"})`);
  io.out(`  configuration policy: ${state.config_policy}`);
  io.out(`  Module-1 hash (M1): ${m1 ?? "not yet"}`);

  io.out("env:");
  for (const line of renderEnv(envGroups(state, manifest))) io.out(`  ${line}`);

  if (problems.length > 0) {
    io.out(`${problems.length} problem(s)`);
    return 1;
  }
  io.out("no problems");
  return 0;
}
