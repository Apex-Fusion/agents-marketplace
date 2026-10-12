# Paper2Agent infrastructure for the Vector marketplace

**Status:** Paper-only submission and execution are implemented and verified locally. Live publication needs a configured wallet and separate spending approval. No real-chain funds move in these checks.

## Scope

This is reusable infrastructure for reviewed, supplier-configured MCP tools.
It is not a fixed scientific product.
An operator selects one tool from a local MCP package for each supplier.
Different suppliers can publish different packages through the existing advert system.
No scientific method needs to be selected to use the infrastructure.

The buyer UI accepts a paper as a PDF, URL, or text.
Submission starts code generation and execution under marketplace resource limits.
The coding model implements a bounded method from the paper as a Python JSON MCP tool.
No source repository, revision, task description, or user-selected build budget is required.
A separate verifier checks the implementation against the paper before human review.
This is a repository-owned workflow, not an invocation of upstream Paper2MCP.
It does not prove the paper's claims or promise to reproduce all its experiments.

```text
Buyer agent
  -> authenticated marketplace MCP
  -> approved buyer wallet and escrow
  -> supplier HTTP admission
  -> configured local MCP tool
  -> signed result and Submitted escrow
  -> verified Accept and financial record
```

## Implemented components

| Component | Contract |
|---|---|
| Shared tool contract | `@marketplace/shared/paper2agent`: manifest, bounded JSON schemas, canonical commitments, and Ed25519 receipt verification |
| Supplier | `CAPABILITY_KIND=paper2agent`: local stdio MCP, package hash checks, declared limits, and a durable job journal |
| Registration | `supplier/src/cli/register-paper2agent.ts`: local discovery and a new immutable manifest file; no chain calls |
| Buyer SDK | Node-only `@marketplace/buyer/sdk/paper2agent`: discovery, prepare, Post, execute, and read-only recovery |
| Marketplace MCP | Authenticated `/mcp`: discovery and execution through the official MCP transport |
| Spending control | Operator approval of an unused dedicated key, a full manifest hash, a supplier, price, total exposure, and call count |
| Financial recovery | Signed transaction journal, early receipt storage, exact escrow lineage, and recovery after lost responses |
| Submission UI | Buyer `/paper2agent`: paper-only submission, automatic execution, progress, actual check output, and code download; review and publication in a collapsed operator view |
| Build control | Private `paper2agent` control service: durable SQLite queue, exact paper hash, offline Docker builds, and separate verifier sessions |
| Publisher | Separate private service: reviewed archive checks, offline runtime image, dedicated wallet slots, signed advert journal, and managed tool suppliers |

The capability is `mcp.tool.execute.v1`.
The advert model is `paper2agent:<full-manifest-hash>`.
The MCP name is `p2a_<tool-name>_<first-16-hash-characters>`.
The short name does not authorize spending.
Paid calls use the approved full hash and supplier identity.
Discovery omits ambiguous short-name collisions.

## Data and execution limits

- Input and output must be JSON objects.
- The tool must declare input and output schemas.
- The local MCP result must contain `structuredContent`.
- Resource attachments and text-to-JSON result conversion are not supported.
- Maximum normalized input: 65,536 bytes.
- Maximum normalized output: 262,144 bytes.
- Maximum manifest: 131,072 bytes.
- Maximum JSON depth: 64.
- Maximum JSON nodes: 20,000.
- Maximum tool execution time: 120,000 milliseconds.

An operator sets smaller limits in each manifest.
The default advert SLA is the tool runtime limit plus 270,000 milliseconds.
This includes the buyer's Post confirmation allowance.
Supplier admission still requires the runtime limit plus 150,000 milliseconds to remain.
The buyer rejects advert SLAs above 390,000 milliseconds.

Discovery has a 128-matching-advert bound.
It filters unrelated capabilities before applying that bound.
It uses bounded concurrent probes.
A failed supplier does not remove healthy offers.
Approved calls use narrow supplier and manifest filters.

## Payment and recovery

Both bonds come from the buyer's wallet.
Normal Accept pays the supplier the service price plus the supplier bond.
The service-price ceiling is therefore not a complete cost ceiling.
The total exposure limit also covers escrow funds, fees, and collateral at risk.
The Post check keeps a separate 7,000,000-lovelace settlement allowance.

The gateway reads actual signed transaction fees and wallet movements.
It counts the signed total collateral when that value is present.
It otherwise counts the full pledged collateral.
It does not count returned collateral as money at risk.
Known net costs reduce the approval budget.
An unknown cost remains `null` and keeps the reservation.

One dedicated key can have only one unresolved tool liability.
An admitted attempt consumes a call allowance, even if it later fails before payment.
Revocation stops new funding.
It does not stop result reads or financial recovery.
It does not restore access to other spending APIs or wallet withdrawal.

The gateway saves the original confirmed Post snapshot before supplier admission.
It saves a verified signed result before waiting for node or indexer visibility.
Accept still requires the exact live Submitted lineage and receipt commitment.
A signature alone never permits Accept.

After a lost response:

1. Find the job through authenticated `GET /v1/paper2agent/jobs`.
2. Read its result and financial state through `GET /v1/paper2agent/jobs/:id`.
3. Let recovery retrieve the existing supplier job and settle it.
4. Do not repeat the paid MCP call.

Supplier lookup uses the original escrow reference and request preimage.
It does not admit or execute a job.
Recovery can use the saved snapshot after the original Open output is spent.
The previous gateway owner's heartbeat must be stale before takeover.
An ambiguous broadcast can replay the same signed bytes, not a replacement purchase.

Reclaim applies only to expired Open or Claimed escrows.
There is no buyer wrong-result refund after Submitted.
Supplier Release can also take the buyer bond.
An error or lost result is not proof of a refund.

## Paper submission and review

Open `/paper2agent` in the password-protected buyer app.
The browser uses the same-origin `/v1/paper2agent/*` proxy.
Control and publisher tokens stay on the server.

1. Submit a public HTTPS paper URL, pasted text, or a PDF of at most 5 MiB.
   The service derives a title and queues attempt 1 immediately.
   It rejects submission if the builder is unavailable or its queue is full.
2. The marketplace applies the default build limits: 32 model calls, 4,096 output tokens per call, and 15 minutes.
   These are resource limits, not a currency quote.
   An operator must approve a retry; there is no automatic paid retry.
3. The control service hashes the exact submitted or fetched paper bytes.
   The coding model implements one useful method from the paper's equations and algorithm steps.
   The package states its scope, assumptions, paper references, and dependency provenance.
   Missing essential data or an unsupported method stops the build.
   Paper parsing and generated code run in offline, unprivileged containers.
   Pinned binary wheels come through restricted host-side fetches.
4. A fresh verifier session receives the paper and frozen package.
   It derives reference outputs from the paper, analytical examples, or a separate calculation.
   It must not obtain expected values from the implementation under test.
   The service runs the check program and replays each reference case through real MCP in a fresh container.
   A failed check leaves no approvable artifact.
5. Read the executed check output and download the generated code as a `.zip` archive.
   The operator view contains source previews, licenses, manifest, hashes, verifier code, and review controls.
   Review approval binds the exact archive hash and separate code, data-rights/license, and result attestations.
   The collapsed view is not a separate access-control role; the existing buyer operator session protects it.
6. Optional publication requires a configured publisher wallet slot and approved price and bonds.
   Preparation checks the archive and builds a server-owned runtime image offline.
   It does not broadcast an advert.
7. Fund the displayed address manually and approve a maximum wallet debit.
   The publisher checks the signed transaction's actual debit and journals it before broadcast.
   It confirms the advert before starting the managed supplier.

Builds and downloads do not require a publisher or an on-chain payment.
The parser accepts text-bearing PDFs of at most 200 pages.
The model receives at most 60,000 UTF-8 bytes of extracted paper text.
Image-only PDFs need text extraction before submission.
Package export omits Python bytecode caches, so the reviewed source controls execution.
The download ZIP is made from the hash-verified internal bundle, not the mutable source preview.
It contains the package files directly.
The publication bundle keeps its original TAR format and SHA-256.
That publication hash is not the ZIP download hash; the individual file hashes remain the same.

An unknown publication outcome permits status recovery, not a new advert.
An interrupted build does not restart model spending.
Startup removes only containers owned by the recorded build attempt.
Failed cleanup stops the queue until recovery succeeds.
The control and publisher databases and supplier journals need durable storage.

The paper-only migration saves complete old rows in the private `legacy_jobs` table.
It preserves original artifact files and publication records.
Old artifacts lack the new paper hash, so old approvals cannot authorize a new publication.
Old queued work stops without another model call.
An operator can explicitly retry a non-publication job.
Existing publications remain available for read-only outcome recovery.
Back up the database before migration; malformed saved JSON stops and rolls back migration.

The runtime supports bounded JSON input and output through Python/FastMCP.
It does not support arbitrary language builds, interactive notebooks, large remote datasets,
file-returning tools, or long-running research jobs.
The current tool deadline is at most 120 seconds.
Model test reports are evidence for review, not proof of scientific correctness.

## Operator entry points

- [Supplier preparation and registration](DEPLOY_NEW_SUPPLIER.md#9-paper2agent-tools).
- [Agent-assisted build and publisher deployment](DEPLOY_NEW_SUPPLIER.md#agent-assisted-operator-workflow).
- [Gateway approval, MCP access, and job recovery](gateway.md#paper2agent-tools).

The Node SDK exposes explicit stages:

| Method | Effect |
|---|---|
| `discover(filters?)` | Read verified available offers |
| `prepare(options)` | Check the manifest, supplier, input, and service-price ceiling |
| `post(prepared, beforeSubmit?)` | Sign, journal through the hook, submit, and confirm one escrow |
| `execute(posted, options?)` | Admit once, verify the receipt, and prove Submitted lineage |
| `recover(posted, options?)` | Read the existing job without another paid admission |

Persist `PostedPaper2Agent`, including its `escrowUtxo`, before `execute`.
Preserve bigint values when storing and restoring the snapshot.
`onJobAccepted` records the supplier job ID.
`onReceiptVerified` records cryptographic evidence before chain visibility.
That callback does not prove settlement.
`recover` accepts a known job ID or uses request-preimage lookup.
Its default deadline is 30 seconds.
The gateway supplies the financial journal and Accept/Reclaim integration.

## Verification record

- All eight workspace type checks pass on Node 20.
- The full suite passes: 1,916 tests in 152 files.
- Ten tests remain skipped, including one fully skipped file.
- The buyer production bundle builds and loads in Chromium.
- The control, publisher, and trusted Python runtime images build locally.
- Native ledger parser checks accept long model identities, long endpoints, and UTF-8 chunks.
- Existing advert and escrow golden encodings stay unchanged.

### Paper-only execution check

- Chromium submits only the URL of [Generalized Intersection over Union](https://arxiv.org/abs/1902.09630).
- The real `gpt-5.6-sol` endpoint generates an implementation from the PDF in 17 total model calls.
- A separate verifier checks Algorithm 2 against independent geometric calculations.
- Three reference cases cover identical boxes, reversed corners with partial overlap, and separated/degenerate predicted boxes.
- Invalid-input checks cover empty input, invalid ground truth, and unsupported fields.
- The control service runs the check program and all three cases through real MCP containers.
- The page shows actual program output and a ZIP code download, without repository or build-budget fields.
- Chromium saves the ZIP attachment. Python's independent ZIP reader checks every file against the verified bundle.
- The job reaches `awaiting_review` on attempt 1 without a review or publication.
- Paper SHA-256: `56fceedbbe952fd132eb75a6e6bc637028c365fa5a8c6b584e4020ddf01f291e`.
- This checks the metric implementation. It does not reproduce detector training or benchmark scores.


### Earlier paid-execution check

- A real Python FastMCP 4.0.11 process runs a least-squares tool through supplier HTTP and marketplace MCP.
- Its result matches direct Python execution: `{"slope":2,"intercept":1}`.
- The normal scenario verifies the receipt and completes Post, Claim, Submit, and Accept.
- A second scenario drops the supplier's admission response.
- That scenario reopens the gateway database and supplier runtime.
- It simulates a stale owner heartbeat and runs the normal recovery dispatcher.
- Recovery finds the job through authenticated listing and unpaid supplier lookup.
- Each scenario records exactly one tool invocation and one paid admission.
- Missing approval, a second purchase, another key's job access, and legacy spending after revoke are denied.

The tool process, HTTP paths, signatures, and signed transaction CBOR are real.
The ledger, indexer, evaluation responses, and confirmations are local simulations.
The simulated buyer debit is 4,003,256 lovelace per scenario.
That includes a 2,000,000 service price, a 1,000,000 supplier bond, and 1,003,256 in buyer fees.
These values are not a mainnet fee quote.
No real funds move.

### Earlier publication and recovery check

This check uses the earlier source-based input format.
It verifies publication and recovery behavior, not the current paper-only submission contract.

- The UI displays the package, test program, output, review attestations, and publication state.
- The reviewed archive SHA-256 is `8d558a3658d7ea24e9cbf8b8f70b8a2dd1b8cbd67e6c7453ced68930d7a9c3a4`.
- A 2.1 AP3X publication limit blocks the signed advert before broadcast.
- A 3 AP3X limit permits one simulated-ledger broadcast with a 2.548878 AP3X wallet debit.
- The actual published image returns the expected runs for `[3,3,-2,3,3,3]`.
- Restarting the publisher in its service image preserves the advert and sends no second transaction.
- Killing an active build leaves an owned Docker container.
  Control startup removes that container and marks the attempt interrupted without another model call.
- Offline runtime preparation also succeeds from inside the publisher service image.

The paper fixture is a software integration check, not a scientific reproduction.
The earlier model bridge makes real model calls; the current paper-only check also exercises the production GPT endpoint.
The advert CBOR, signatures, containers, HTTP services, and browser are real.
The ledger and confirmations are simulated.
No real-chain funds move.


## Trust and exclusions

Review the tool code, dependencies, data rights, and licenses before registration.
The generator's license does not grant rights to a tool or its data.
Pin the artifact and its runtime dependencies.
The package digest covers one regular artifact file, not the whole host.

The manual local-process configuration runs operator-trusted code.
Environment filtering alone is not a sandbox.
The managed build and publisher paths run package code in offline Docker containers.
They use read-only roots, unprivileged users, dropped capabilities, and resource limits.
Docker is not a virtual-machine boundary.
Run build control on a wallet-free host with its own Docker daemon.
On a shared build host, use a dedicated rootless daemon and account, not the CI runner's root Docker socket.
Rootless Docker shares the host kernel and gives less isolation than a VM.
The trusted publisher also has root-equivalent Docker socket access on its host.
The supplier sees the input.
Tool inputs and results remain in plaintext in the gateway database and supplier journal.
Use non-sensitive data unless a separate data-protection policy permits this storage.

A receipt proves a supplier statement about particular bytes.
It does not prove scientific correctness or that the declared program ran.
The local reference calculation verifies the adapter path, not a research method.

This work does not add arbitrary remote MCP routing, paid file transfer, long-running
scientific pipelines, new dispute protection, or automatic paid retries.
Generated packages install their dependencies from pinned wheels in offline build containers.
Real-chain publication and paid execution still require explicit spending approval.

## Sources

- [Paper2MCP workflow](https://github.com/jmiao24/Paper2Agent/blob/main/skills/paper2agent/paper2mcp/SKILL.md), [package verification](https://github.com/jmiao24/Paper2Agent/blob/main/skills/paper2agent/paper2mcp/references/output-delivery.md), and [generator license](https://github.com/jmiao24/Paper2Agent/blob/main/LICENSE).
- [Shared contract](../packages/shared/src/paper2agent/index.ts).
- [Supplier execution](../supplier/src/paper2agent/runtime.ts).
- [Operator control](../paper2agent/src/control.ts), [isolated builder](../paper2agent/src/build.ts), and [publisher](../paper2agent/src/publisher.ts).
- [Buyer SDK](../buyer/src/sdk/paper2agent.ts).
- [Gateway MCP](../gateway/src/paper2agent/mcp.ts) and [financial recovery](../gateway/src/paper2agent/recovery.ts).
- [Escrow payout and refund rules](../contracts/marketplace/validators/escrow.ak).

