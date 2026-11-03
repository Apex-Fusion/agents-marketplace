# Legacy registry script tests (Part 2 §12.2)

These tests run the deployed legacy agent registry script
(`legacy_hash = be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01`)
against complete, signed transactions. The evaluation is offline. No
transaction goes to a network. All keys are throwaway test keys.

## Run

From the repository root (once: `npx -y pnpm@10.33.2 install --frozen-lockfile --prefer-offline`):

```sh
npx vitest run --config tests/legacy-registry/vitest.config.ts
```

- Requirements: `aiken` v1.1.21 on `PATH` (`blueprint.test.ts` checks the version) and Node 20 or later. No network.
- Type check: `npx tsc -p tests/legacy-registry/tsconfig.json`.
- `LEGACY_REGISTRY_ARTIFACTS=<dir>` keeps `tx.hex`, `inputs.hex`, `outputs.hex` and `command.txt` of each evaluation. Use `command.txt` to run `aiken tx simulate` again by hand.
- `LEGACY_REGISTRY_REPORT=<file>` appends one JSON line per evaluation (test name, transaction ID, verdicts, execution units). The results table below comes from this file.
- `verify-source.sh` rebuilds the legacy source and compares it with the deployed bytes. It is the only part that needs a network (GitHub).

## Answers

**Minimum change back to the owner.** The legacy Deregister (check AR-10 of the
deployed source) passes only when **one** transaction output has the owner's
key hash as payment credential, with any stake credential, and holds at least
**10,000,000 base units (10 AP3X)**. Measured: 9,999,999 fails and 10,000,000
passes. Two outputs of 5 AP3X fail. An output to another payment key with the
owner's stake key fails. The script does not ask for the deposit itself: a
25 AP3X record passes with 10 AP3X to the owner. The ledger min-UTxO of that
output is far lower (857,690 base units for an enterprise address, 978,370 for
a base address). In an adoption where the legacy deposit and the new record
are both 10 AP3X, the owner adds at least 10,000,000 base units plus the fee:
1 base unit less fails.

**(a) Can a legacy Update move the token to the legacy script address with a
stake credential?** No. Update needs its continuing output at the exact address
of the spent input. Both a stake key and a script stake credential fail. A
Register cannot put a new token there either.

**(b) Can a legacy Update leave two legacy tokens in one output?** Yes, but only
together with a legacy Register in the same transaction: the Register's token
and the record's token go into one output at the legacy address, and both
scripts pass (the owner signs). Two Updates in one transaction always fail,
because Update allows only one input at the legacy address. The two-token
output can never be spent again: Update and Deregister both fail on an input
with two legacy tokens. Its tokens stay in an output that is not authentic
(Part 1 §4) for ever.

## Source of the deployed bytes

`fixtures/agent-registry.plutus.json` is a byte copy of
`Apex-Fusion/vector-ai-agents@f6ae4bb:agent-registry/deploy/agent-registry/plutus.json`
(git blob `4c79883e`). Its `compiledCode` (2,516 bytes) is one CBOR byte string
(`59 09d1`) around the 2,513-byte flat program. The script hash is
`blake2b_224(0x03 || compiledCode)` = `be1a0a29…`. The flat program alone hashes
to `4646671a…`.

| Source | Compiles to | Deployed bytes |
|---|---|---|
| `agent-registry-audit/compliant/agent-registry/{types,validation,registry}.ak` at `eb05a62` (blobs `042feedb`, `368a8948`, `2a38b101`) | `be1a0a29…` | **yes, byte for byte** |
| `agent-registry/compliant/contracts/*.ak` at `f6ae4bb` | `9992706f…` | no |
| `agent-registry/original/contracts/agent-registry/` at `f6ae4bb` | `5dd51189…` (test registry) | no |

All builds use Aiken v1.1.21+42babe5, `aiken-lang/stdlib` v3.0.0 and the
default trace level (silent). `verify-source.sh` repeats them. The
`compliant/` source of `f6ae4bb` is **not** the deployed script. It lacks the
datum limits, the one-input rule and the value rule of Update, the
`registered_at` rule, the change rule of Deregister and the owner signature of
Burn. It is also stricter in one place: its Register and Update allow only one
output at the legacy address. A reader of that source misses the change rule
and expects two Updates to merge two records, which the deployed script
rejects.

## Rules of the deployed script

From the source that compiles to the deployed bytes. `LA` is the legacy
address (the script, no stake credential).

- **Register { seed }** (mint): the transaction spends `seed`; the mint under the policy is exactly `{ blake2b_256(serialise(seed)): 1 }`; exactly one output is at `LA` with an inline datum, that token and at least 10 AP3X; its datum decodes as `AgentDatum`, the owner is a key hash that signs, and the datum is within the limits (name 256, description 1024, framework 128, endpoint 512 bytes; at most 32 capabilities of 128 bytes). Other outputs at `LA` and other tokens in that output are not checked.
- **Burn** (mint): the mint under the policy is exactly one name with quantity −1; the first input at `LA` that holds that name has a datum whose owner signs.
- **Update** (spend): the owner signs; the spent input holds exactly one token of the policy; exactly one input is at the input's address; the first output at that address with the token has an inline `AgentDatum` with the same `registered_at`, a key-hash owner, the datum limits, and at least the input's AP3X.
- **Deregister** (spend): the owner signs; the spent input holds exactly one token of the policy; the mint under the policy is exactly that name with quantity −1; the change rule above.

## Harness

| File | Content |
|---|---|
| `harness/cbor.ts` | Minimal CBOR writer. |
| `harness/data.ts` | Plutus Data and its ledger encoding (indefinite lists, 64-byte chunks, bignums, constructor tags 121–127, 1280–1400 and 102). |
| `harness/ledger.ts` | Hashes, throwaway keys (`testKeyPair`), CIP-19 addresses, values, outputs, the Vector slot clock and `buildTx()`. |
| `harness/simulate.ts` | `simulate()`: runs `aiken tx simulate` and gives a verdict for each redeemer. |
| `harness/blueprint.ts` | `blueprintScript()`: loads a validator from a blueprint and applies its parameters with `aiken blueprint apply`. |
| `harness/legacy.ts` | The legacy script, hash, address, `AgentDatum`, redeemers and the identifier derivation. |
| `harness/identity.ts` | The identity-marketplace test deployment (`identityWorld()`), the conversions between the shared builder types and the harness types (`harnessData`, `harnessUtxo`, `sharedUtxo`), and the evaluation of builder transactions: `simulateUnsigned()` for an unsigned transaction of the identity builders, `evaluateBuiltTx()` for a signed transaction of any builder (the redeemers come from its witness set). |
| `scenario.ts` | Test wallets, funds, the record profile, the rule-following Register, `evaluate()`. |

- **Transactions.** A test writes a `TxSpec` (inputs with redeemers, reference inputs, collateral, outputs, fee, mints, withdrawals, required signers, validity slots, scripts, datums, signers). `buildTx()` sorts the inputs, policies and reward accounts as the ledger does, gives each redeemer its index, writes the Conway body and witness set (tag 258 sets, a redeemer map), and signs the body hash with the keys.
- **Phase-1 guards.** `buildTx()` throws for a transaction that the ledger rejects before any script runs: unbalanced value (per asset); a missing key witness for a required signer, a key input, collateral or a key withdrawal; an output below the min-UTxO (4310 base units per byte); a script input or script withdrawal without a redeemer; a duplicate input. aiken itself checks that the scripts and redeemers match the script purposes; `simulate()` turns such an error into a `HarnessError`. Neither error is a script failure. The harness does not check fees, the script data hash, collateral amounts or the transaction size.
- **Evaluation.** `aiken tx simulate` with the Vector mainnet clock (zero time 1,756,485,600,000 ms, zero slot 0, 1,000 ms per slot). aiken stops at the first failing redeemer. When a transaction fails, `simulate()` evaluates it again with each redeemer first, so each redeemer gets its own verdict. The order of the redeemer map does not change the transaction ID. `evaluate()` also requires each failure to be a validator rejection ("the validator crashed / exited prematurely"), not another machine error.
- **Limits.** aiken uses its default Plutus V3 cost model and a budget of 14,000,000 memory and 10,000,000,000 CPU units per transaction. The execution units below are therefore indicative. The Vector memory limit is 16,000,000 (Part 2 §12.4).
- **Determinism.** Keys come from fixed labels, so each run builds the same transactions and gets the same results.

## Wave 2: the combined adoption test

`deregister.test.ts` already builds an adoption-shaped transaction: the legacy
Deregister and Burn next to a second Plutus V3 policy, `STAND_IN_IDENTITY`
(a script that accepts everything). For the combined test, replace the stand-in
with the identity validator:

```ts
import { blueprintScript, scriptHash, address, buildTx, withChange, BURN, DEREGISTER, LEGACY_HASH, LEGACY_SCRIPT } from "../legacy-registry/harness/index.js";
import { evaluate } from "../legacy-registry/scenario.js";

// Parameters as Plutus Data, in the order of the blueprint.
const identity = blueprintScript("contracts/identity-marketplace/plutus.json", "<module>.<validator>.mint", parameters);
const idPolicy = scriptHash(identity);
const result = evaluate(buildTx(withChange({
  inputs: [{ utxo: legacyRecord, redeemer: DEREGISTER, label: "legacy Deregister" }, { utxo: ownerFunds }],
  referenceInputs: [configRecord],
  outputs: [
    { address: address({ script: idPolicy }), value: { coin: 10_000_000n, assets: [{ policy: idPolicy, name: id, quantity: 1n }] }, datum: { inline: d0 } },
    { address: ownerAddress, value: { coin: 10_000_000n } }, // the legacy change rule
  ],
  fee,
  mint: [
    { policy: LEGACY_HASH, assets: [{ name: id, quantity: -1n }], redeemer: BURN, label: "legacy Burn" },
    { policy: idPolicy, assets: [{ name: id, quantity: 1n }], redeemer: adoptRedeemer, label: "identity Adopt" },
  ],
  validity: { invalidBefore: loSlot, invalidHereafter: hiSlot },
  requiredSigners: [ownerKeyHash, controllerKeyHash /* , listed keys and parties */],
  scripts: [LEGACY_SCRIPT, identity],
  signers: [ownerKey, controllerKey],
}, ownerAddress)));
```

`slotToPosixMs()` gives the `lo` and `hi` that the scripts see.
`harness.test.ts` shows the full path with a parameterised validator.

## Tests and results

57 tests in 5 files, all green. Execution units are memory / CPU.

| File | Test | Expected | Result |
|---|---|---|---|
| `blueprint.test.ts` | The fixture is the `f6ae4bb` blueprint (git blob `4c79883e`) | equal | equal |
| | Mint, spend and else have one code; Aiken v1.1.21+42babe5; Plutus V3 | equal | equal |
| | `blake2b_224(0x03 ‖ compiledCode)` = `be1a0a29…` | equal | equal |
| | Address = `addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42` (Part 1 §4) | equal | equal |
| | Identifier derivation = Part 1 §3.1 test vectors | equal | equal |
| | Evaluator = `aiken v1.1.21+42babe5` | equal | equal |
| `register.test.ts` | Register that follows the rules (positive control) | pass | Register pass (171,970 / 61,720,972) |
| | **Blocker:** the seed is not an input | fail | Register fail |
| | **Blocker:** the seed is only a reference input | fail | Register fail |
| | **Blocker:** quantity 2 | fail | Register fail |
| | **Blocker:** a second name next to the seed's name | fail | Register fail |
| | **Blocker:** the name of another seed | fail | Register fail |
| | **Blocker:** the name from a definite-length seed encoding | fail | Register fail |
| | **Blocker:** the Burn redeemer mints +1 | fail | Burn fail |
| | The owner is a script credential | fail | Register fail |
| `deregister.test.ts` | Deregister + Burn by the owner, 10 AP3X to the owner (positive control) | pass | Deregister pass (123,830 / 42,050,704); Burn pass (105,145 / 33,438,460) |
| | Owner output 9,999,999 | fail | Deregister fail; Burn pass |
| | Owner output 10,000,000 | pass | Deregister pass (132,218 / 47,301,658); Burn pass (111,268 / 36,841,216) |
| | Two owner outputs of 5 AP3X | fail | Deregister fail; Burn pass |
| | Owner payment key with a stake credential | pass | Deregister pass (132,218 / 47,301,658); Burn pass (111,268 / 36,841,216) |
| | Another payment key with the owner's stake key | fail | Deregister fail; Burn pass |
| | 25 AP3X record, 10 AP3X to the owner | pass | Deregister pass (123,830 / 42,050,704); Burn pass (105,145 / 33,438,460) |
| | Ledger min-UTxO of the owner output | below 10 AP3X | 857,690 (enterprise), 978,370 (base) |
| | The owner does not sign | fail | Deregister fail; Burn fail |
| | Two records in one transaction | fail | both Deregisters fail; Burn fail |
| | Adoption shape: the owner adds 10 AP3X + fee | pass | Deregister pass (134,543 / 46,823,098); Burn pass (109,871 / 34,890,263); stand-in pass |
| | Adoption shape: 1 base unit less | fail | Deregister fail; Burn pass; stand-in pass |
| `update.test.ts` | Update at the legacy address (positive control) | pass | Update pass (215,723 / 73,628,215) |
| | The new owner is a script credential | fail | Update fail |
| | **(a)** Update to `LA` + the owner's stake key | fail | Update fail |
| | **(a)** Update to `LA` + a script stake credential | fail | Update fail |
| | **(a)** Register to `LA` + a stake key | fail | Register fail |
| | **(b)** Two Updates into one output | fail | both Updates fail |
| | **(b)** Two Updates into two outputs | fail | both Updates fail |
| | **(b)** Register + Update, both tokens in one output | pass | Update pass (224,111 / 78,879,169); Register pass (176,696 / 63,168,896); the output holds 2 legacy tokens |
| | **(b)** Spend the two-token output with Update | fail | Update fail |
| | **(b)** Spend the two-token output with Deregister + Burn | fail | Deregister fail; Burn pass |
| `harness.test.ts` | 14 Plutus Data encoding vectors | equal | equal |
| | Missing script → `HarnessError`; unbalanced value and a missing key witness are rejected | throw | throw |
| | A script withdrawal runs as `Withdraw[0]` in a transaction with both validity bounds | pass | pass |
| | Parameterised blueprint validator: applied parameter passes, another redeemer fails | pass / fail | pass (11,918 / 3,247,790) / fail |

## Findings for Part 2

1. **§9.1 Funding.** The legacy Deregister does not return the deposit. It needs one output of at least 10,000,000 base units to the owner's payment key hash (any stake credential). The rest of a larger deposit can go anywhere.
2. **§12.2.** The source that compiles to the deployed bytes is `agent-registry-audit/compliant/agent-registry/` at `eb05a62`, not `agent-registry/compliant/` at `f6ae4bb` (that one compiles to `9992706f…` and has other rules).
3. **Part 1 §7.3, rule 6.** The only non-authentic legacy state is two tokens in one output at `LA`. That output can never be spent, so the tokens never return to an authentic output, and the records can neither adopt nor deregister.
4. **§9.1 Profile copy.** The deployed Register and Update never create a record with a script owner, and every record datum decodes as `AgentDatum`. The legacy limits (name 256, description 1024, framework 128, endpoint 512 bytes; 32 capabilities of 128 bytes) are wider than the identity limits, so the builder must still ask for new values.
5. **§9.5.** One Deregister per transaction is a script rule (two records in one transaction fail). Of a deposit above 10 AP3X, only 10 AP3X must go to the owner's key.
