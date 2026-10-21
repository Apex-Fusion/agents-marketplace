# Paper2Agent infrastructure for the Vector marketplace

**Status:** Paper-only submission and execution are deployed and verified on the live marketplace. The mainnet publisher is deployed with six live wallet slots. Each live publication needs a funded slot wallet and separate spending approval. No real-chain funds move in these checks.

## Scope

This is reusable infrastructure for reviewed, supplier-configured MCP tools.
It is not a fixed scientific product.
An operator selects one tool from a local MCP package for each supplier.
Different suppliers can publish different packages through the existing advert system.
No scientific method needs to be selected to use the infrastructure.

The buyer UI accepts a paper as a PDF, URL, or text.
Submission starts code generation and execution. A build has no call, token, or time limit; the wallet that pays for model calls is the limit.
The coding model implements a bounded method from the paper as a Python JSON MCP tool.
No source repository, revision, task description, or user-selected build budget is required.
A separate verifier checks the implementation against the paper before human review.
This is a repository-owned workflow, not an invocation of upstream Paper2MCP.
It does not prove the paper's claims or promise to reproduce all its experiments.

```text
MCP client (no API key)
  -> public marketplace MCP (per-IP and gateway-wide limits)
  -> token-gated publisher route
  -> supplier free-call route
  -> configured local MCP tool in a new offline container
  -> JSON result, validated against the manifest
```

A direct on-chain buyer can still pay a tool supplier: escrow, supplier admission, signed result and Submitted escrow, then Accept.

## Implemented components

| Component | Contract |
|---|---|
| Shared tool contract | `@marketplace/shared/paper2agent`: manifest, bounded JSON schemas, canonical commitments, and Ed25519 receipt verification |
| Supplier | `CAPABILITY_KIND=paper2agent`: local stdio MCP, package hash checks, declared limits, and a durable job journal |
| Registration | `supplier/src/cli/register-paper2agent.ts`: local discovery and a new immutable manifest file; no chain calls |
| Buyer SDK | Node-only `@marketplace/buyer/sdk/paper2agent`: discovery and free calls without a wallet; prepare, Post, execute, and read-only recovery for direct paid buyers |
| Marketplace MCP | Public `/mcp`: free discovery and calls through the official MCP transport, with per-IP limits, a gateway-wide call limit, and a short queue |
| Paid supplier route | `POST /v1/paper2agent/run` for direct on-chain buyers: escrow admission, signed receipt, and a durable supplier journal |
| Submission UI | Buyer `/paper2agent`: paper-only submission, automatic execution, progress, actual check output, and code download; review and publication in a collapsed operator view |
| Build control | Private `paper2agent` control service: durable SQLite queue, exact paper hash, offline Docker builds, and separate verifier sessions |
| Publisher | Separate private service: reviewed archive checks, offline runtime image, dedicated wallet slots, signed advert journal, and managed tool suppliers |

The capability is `mcp.tool.execute.v1`.
The advert model is `paper2agent:<full-manifest-hash>`.
The MCP name is `p2a_<tool-name>_<first-16-hash-characters>`.
A free call sends the full manifest hash, not the short name alone.
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
The gateway caches the tool list for 30 seconds.
It also lists tools that the indexer reports as `working` or `unknown`; a call to a busy tool waits or reports busy.

## Free calls and direct payment

The gateway's `/mcp` calls tools for free.
It needs no API key, approval, funded wallet, or escrow.
The gateway sends each call to the supplier's `POST /v1/paper2agent/call` route through the publisher.
A secret token that the gateway and the publisher share protects this route.
The gateway lists and calls only tools whose advert endpoint is under `PAPER2AGENT_PUBLISHER_PUBLIC_URL/tools/`, so the token never goes to another host.
A free result has no receipt and no chain record.
The gateway allows one call for each supplier and two calls in total.
Other calls wait for at most 60 seconds; then the call reports that the tool is busy.
See [gateway limits](gateway.md#limits).

Publication is still on chain.
A direct on-chain buyer can still pay the supplier through the Node SDK stages below.
Both bonds come from the buyer's wallet.
Normal Accept pays the supplier the service price plus the supplier bond.
The supplier admits a paid call only for a confirmed Open escrow.
A free call and a paid admission share the supplier's single slot.
During a free call, a paid admission gets HTTP 409 `supplier_busy`, and the buyer can reclaim the escrow only after its deadline.
Check that the indexer reports the tool as `free` immediately before you post an escrow.

Supplier lookup uses the original escrow reference and request preimage.
It does not admit or execute a job.
Reclaim applies only to expired Open or Claimed escrows.
There is no buyer wrong-result refund after Submitted.
Supplier Release can also take the buyer bond.
An error or lost result is not proof of a refund.

The gateway no longer pays for tool calls.
It keeps its old approval and call tables, but does not use them.

## Paper submission and review

Open `/paper2agent` in the buyer app.
The browser uses the same-origin `/v1/paper2agent/*` proxy.
Control and publisher tokens stay on the server.

1. Submit a public HTTPS paper URL, pasted text, or a PDF of at most 5 MiB.
   The service derives a title and queues attempt 1 immediately.
   It rejects submission if the builder is unavailable or its queue is full.
2. The build has no call, token, or time limit.
   When the wallet cannot pay for the next model call (HTTP 402 `insufficient_funds`), the build pauses.
   It sends the same call again every minute and continues after funds arrive. Nothing is spent while it waits.
   The job shows the pause, the wallet balance, and the amount needed. Cancel the build to stop spending.
   A paused build keeps the build slot; queued builds wait. A control service restart interrupts it.
   When the buyer app cannot reach Ogmios or the indexer before it sends the escrow (HTTP 503 `chain_unavailable`), the build waits the same way. Nothing is paid.
   The job shows no pause for this wait. The build log shows one waiting line and one resumed line.
   When the conversation passes 160,000 bytes, the agent shortens older tool results and tool-call arguments, oldest first, to about 120,000 bytes.
   The latest turn stays complete. The hard limit of 220,000 bytes stays.
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
   The service runs the check program and replays each reference case through real MCP in a fresh container when the verifier finishes.
   If a check fails, the verifier receives the error and can repair `check.py` or `cases.json` up to 2 times; the next failure ends the attempt.
   A failed check leaves no approvable artifact.
5. Read the executed check output and download the generated code as a `.zip` archive.
   The operator view contains source previews, licenses, manifest, hashes, verifier code, and review controls.
   Review approval binds the exact archive hash and separate code, data-rights/license, and result attestations.
   The collapsed view is not an access-control role. Anyone who can open the buyer app can use it.
6. Optional publication requires a configured publisher wallet slot and approved price and bonds.
   Preparation checks the archive and builds a server-owned runtime image offline.
   It does not broadcast an advert.
7. Fund the displayed address manually and approve a maximum wallet debit.
   The publisher checks the signed transaction's actual debit and journals it before broadcast.
   It confirms the advert before starting the managed supplier.

Each build model call is a marketplace purchase from the buyer wallet; see [Paid build model calls](#paid-build-model-calls).
Downloads need no publisher and no on-chain payment.
The parser accepts text-bearing PDFs of at most 200 pages.
The model receives at most 60,000 UTF-8 bytes of extracted paper text.
Image-only PDFs need text extraction before submission.
Package export omits Python bytecode caches, so the reviewed source controls execution.
The download ZIP is made from the hash-verified internal bundle, not the mutable source preview.
It contains the package files directly.
The publication bundle keeps its original TAR format and SHA-256.
That publication hash is not the ZIP download hash; the individual file hashes remain the same.

### Paid build model calls

The build agent sends OpenAI Chat Completions requests to the buyer app at `POST https://api.marketplace.vector.apexfusion.org/v1/paper2agent/model/chat/completions`.
That host is a direct A record to Traefik. Through the Cloudflare-proxied `marketplace.vector.apexfusion.org`, calls over 100 s end with HTTP 524 while the buyer still pays for them.
The buyer app checks the bearer token `PAPER2AGENT_MODEL_TOKEN` before it reads the body or the wallet.
Each request buys one marketplace call with the buyer wallet:

1. The buyer app chooses an Active `llm.text.generate.v1` advert for the requested model.
   The control sends `auto`, which allows every model whose advert offers at least 4096 output tokens, except the models in the buyer's `PAPER2AGENT_MODEL_AUTO_EXCLUDE` (comma-separated).
   Cached-free suppliers come first, then the cheapest price; equal prices are in random order, so calls spread across models.
   The buyer app reads each candidate's live `/status`, because the indexer cache can be one 20 s poll old.
   It skips a supplier that is not free or whose `/capability` refuses the request (no Responses inference, or no tool calls), before any funds move.
   A build conversation can therefore change model between calls.
   No free supplier gives HTTP 503 `model_unavailable` without a transaction.
   A supplier whose paid call fails is skipped for 15 minutes.
2. It checks the wallet like the gateway preflight: the escrow lock floor, 5 AP3X collateral, and a 2 AP3X fee reserve.
   If the wallet cannot pay, it answers HTTP 402 `insufficient_funds` with the deposit address and builds no transaction.
   If Ogmios or the indexer fails before the escrow is sent (HTTP 5xx or 429, a network error, or a timeout), it answers HTTP 503 `chain_unavailable`. No payment was made.
   A failure after the signed escrow goes to Ogmios stays HTTP 502, because the escrow can be on chain.
3. It posts the escrow and verifies the supplier receipt. It answers after Submit and sends the Accept in the background.
   A failed Accept is sent again up to 3 times, 10 s apart. The buyer app checks for confirmations every 0.5 s.

Each model call therefore creates four transactions: Post, Claim, Submit, and Accept.
The buyer app posts one escrow at a time and never sends a second call to a supplier with an open call.
The next Post does not spend the inputs or the collateral of an Accept that is not in a block yet.
If the other wallet outputs cannot pay, the call waits for the pending Accepts.
Post keeps the smallest pure-AP3X UTxO of at least 5 AP3X out of its inputs when the other outputs can pay the escrow.
Accept and Reclaim keep it out when the other outputs can pay the fee and give the collateral (at most 3 inputs, together at least 6 AP3X).
So the wallet keeps its collateral UTxO, and the preflight does not refuse the next call.
On shutdown the buyer app waits up to 60 s for background Accepts.
The buyer key stays on the production host. The build host holds only the token.
The buyer archive keeps each request, result, and signed receipt.

On 2026-10-13, one call to the `gpt-5.6-sol` advert (0.2 AP3X price, 1 AP3X bonds) cost the buyer wallet 3.003256 AP3X.
Accept pays the supplier the price and the supplier bond, raised to the 2 AP3X output minimum.
The Post and Accept fees make up the rest.
If all Accept attempts fail, the buyer log shows `accept_failed` with the Submitted escrow; accept it with `POST /v1/accept` within 10 minutes of its submission.

The build agent resends the same conversation after a failed model call (wait 10 s × the number of failures in sequence) or a reply without a tool call (no wait).
Three such results in a row fail the run.
HTTP 402 `insufficient_funds` and HTTP 503 `chain_unavailable` are waits, not failures. They do not count, and they do not reset the count.
On 2026-10-13 the build `ConsistendHashAlgoV2` failed for this reason with `gpt-5.6-sol` only: the indexer still listed the single supplier as working 134 ms after its previous call ended, the endpoint answered 503, and the agent failed on the first error.

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
- [Public MCP access and limits](gateway.md#paper2agent-tools).

The Node SDK exposes these methods.
Only the paid stages need a `walletKey`:

| Method | Effect |
|---|---|
| `discover(filters?)` | Read verified offers; `includeBusy` also returns `working` and `unknown` tools |
| `call(offer, input, { token })` | One free call through the token-gated route; no escrow or receipt |
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
A direct paid buyer supplies its own financial journal and its Accept or Reclaim step.

## Verification record

- All eight workspace type checks pass on Node 20.
- The full suite passes: 1,923 tests in 152 files.
- Ten tests remain skipped, including one fully skipped file.
- The buyer production bundle builds and loads in Chromium.
- The control, publisher, and trusted Python runtime images build locally.
- Native ledger parser checks accept long model identities, long endpoints, and UTF-8 chunks.
- Existing advert and escrow golden encodings stay unchanged.
- A real FastMCP tuple tool runs in the offline Docker runtime. Its JSON Schema 2020-12 input and output schemas validate, and wrong tuple lengths fail.

### Local paper-only execution check

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


### Production paper-only check (2026-10-12)

- Chromium uploads the same GIoU PDF through the live paper-only page.
- Attempt 1 stops at a model request deadline. The upstream service later reports HTTP 500 and a prematurely ended response.
- Attempt 2 exposes the FastMCP tuple dialect mismatch. The validator now uses JSON Schema 2020-12 and keeps its execution safeguards.
- One explicit retry after the fix reaches `awaiting_review` on attempt 3, with no review or publication.
- The build and independent verification use 19 model calls and fresh offline Docker environments on `build-nixos-2`.
- Four reference cases cover identical boxes, partial overlap, disjoint boxes with reversed predicted corners, and a degenerate prediction inside valid ground truth.
- Chromium downloads a 3,633-byte ZIP. Python verifies its CRCs and checks every file's size and SHA-256 against the verified artifact.
- ZIP SHA-256: `949c15ed534e23c0376a8c43b174a23494579ca5786084206fd477e6bdb3a096`.
- Publication bundle SHA-256: `0d82fc442103afd63dd4dc97a8815b357c1d475b1b2bce802c5d39915aa25169`.
- The gateway's public health check passes. Unauthenticated MCP access returns HTTP 401.

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
Paid tool inputs and results remain in plaintext in the supplier journal.
The gateway does not store free call inputs or results.
Use non-sensitive data unless a separate data-protection policy permits this storage.

A receipt proves a supplier statement about particular bytes.
It does not prove scientific correctness or that the declared program ran.
A free result has no receipt.
The local reference calculation verifies the adapter path, not a research method.

This work does not add arbitrary remote MCP routing, paid file transfer, long-running
scientific pipelines, new dispute protection, or automatic paid retries.
Generated packages install their dependencies from pinned wheels in offline build containers.
Real-chain publication still requires explicit spending approval.

## Sources

- [Paper2MCP workflow](https://github.com/jmiao24/Paper2Agent/blob/main/skills/paper2agent/paper2mcp/SKILL.md), [package verification](https://github.com/jmiao24/Paper2Agent/blob/main/skills/paper2agent/paper2mcp/references/output-delivery.md), and [generator license](https://github.com/jmiao24/Paper2Agent/blob/main/LICENSE).
- [Shared contract](../packages/shared/src/paper2agent/index.ts).
- [Supplier execution](../supplier/src/paper2agent/runtime.ts).
- [Operator control](../paper2agent/src/control.ts), [isolated builder](../paper2agent/src/build.ts), and [publisher](../paper2agent/src/publisher.ts).
- [Buyer SDK](../buyer/src/sdk/paper2agent.ts).
- [Gateway MCP](../gateway/src/paper2agent/mcp.ts) and [free calls](../gateway/src/paper2agent/service.ts).
- [Escrow payout and refund rules](../contracts/marketplace/validators/escrow.ak).

