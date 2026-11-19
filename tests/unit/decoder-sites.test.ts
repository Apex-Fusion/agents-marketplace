/**
 * decoder-sites.test.ts — the places where the code calls the decoder library on data from outside are named.
 *
 * The test reads the syntax tree of each source file of the repository. Tests, `node_modules` and `dist` are not source. It finds each
 * call that gives data to the decoder library:
 *
 * - a decoder of the library: `CML.*.from_cbor_hex`, `from_bech32`, `from_hex`, and the others in DECODER_NAMES;
 * - a call of Lucid that decodes inside Lucid: `pay.ToAddress`, `collectFrom`, `readFrom`, `attach.*`, `addSignerKey`, `attachMetadata`,
 *   `complete`, `utxosAt`, `utxosByOutRef`, `fromTx`, `selectWallet.*`, and `getUtxos` of the wallet;
 * - a function of Lucid or of its UPLC package that reads a text: `getAddressDetails`, `validatorToScriptHash`, `apply_params_to_script`.
 *
 * Line breaks do not matter. A name that a destructuring, a variable or an import alias gives counts as the name of the library. A
 * decoder that a call hands on (`items.map(CML.Address.from_bech32)`) counts too.
 *
 * Each call has a row in SITES: its file, its function, its callee, the number of its calls, and the reason why it is safe. The reason
 * says which check runs before the call, or why no check is needed. A new call in a file or a function that SITES does not name fails
 * the test, and so does one more call in a function that it does name.
 *
 * A reason that names a check is proved on the tree, not by a search for the text. The check must run in the same function and before
 * the call. For an address check, the call must read the text that the check read or made. A reason that relies on the Ogmios clients is
 * proved on the mapper function of each client: its first statement bounds the fields of the output (assertOutputFields), and it checks
 * the datum (and a native script) before it returns the output.
 *
 * A name can be the name of another thing: `jobs.complete` of the job store of the supplier is not a transaction builder. EXCLUDED lists
 * these calls with a reason. A call through `CML` or `lucid` is never excluded.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

// ─── The source files ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The folders that the scan must cover. The scan walks the whole repository, so a new folder is covered too. */
const SOURCE_DIRS = [
  "packages/shared/src", "gateway/src", "buyer/src", "buyer/src/ui", "buyer/scripts", "supplier/src", "paper2agent/src",
  "wallet-monitor/src", "indexer/src", "indexer-ui/src", "identity-gateway/src", "contracts/identity-marketplace/deploy",
  "contracts/identity-marketplace/bench",
];

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec)\.[^./]+$/;
const NOT_SOURCE_FOLDERS = ["node_modules", "dist", "coverage", ".git", ".vitest-cache", "test", "tests", "__tests__"];

/** The source files under `directory`, sorted. */
function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!NOT_SOURCE_FOLDERS.includes(entry.name)) files.push(...sourceFiles(path));
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/** The path from the repository root, with `/`. */
const rootPath = (path: string): string => relative(ROOT, path).split(sep).join("/");

const parseText = (path: string, text: string): ts.SourceFile => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
const parse = (path: string): ts.SourceFile => parseText(path, readFileSync(path, "utf8"));

// ─── The names ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Methods and functions that read data with the decoder library. A call of one of them is a decoder call, on any receiver. */
const DECODER_NAMES: readonly string[] = [
  // The decoders of the library.
  "from_cbor_hex", "from_cbor_bytes", "from_hex", "from_bech32", "from_raw_bytes", "from_normal_bytes", "from_base58", "from_json",
  "from_address", "from_bytes",
  // The builder of Lucid: it decodes inside Lucid.
  "collectFrom", "readFrom", "complete", "addSignerKey", "attachMetadata", "utxosByOutRef", "utxosAt", "fromTx",
  "ToAddress", "ToAddressWithData", "ToContract",
  "SpendingValidator", "MintingPolicy", "CertificateValidator", "WithdrawalValidator", "VoteValidator", "ProposeValidator",
  // The functions of Lucid and of its UPLC package that read a text.
  "getAddressDetails", "paymentCredentialOf", "credentialToAddress", "utxoToCore", "toScriptRef", "validatorToScriptHash",
  "apply_params_to_script",
  // More functions and methods of Lucid that read a text, a script or an output. `assetsToValue` is in the sources; the others are of
  // the same kind.
  "assetsToValue", "addSigner", "withPrivateKey", "assemble", "overrideUTxOs", "utxosAtWithUnit", "utxoByUnit", "datumOf", "metadataOf",
  "delegationAt", "datumToHash", "datumJsonToCbor", "fromScriptRef", "mintingPolicyToId", "scriptFromNative", "validatorToAddress",
  "validatorToRewardAddress", "credentialToRewardAddress", "stakeCredentialOf", "toPublicKey", "applyParamsToScript", "utxosToCores",
  "drepIDToCredential",
];

/** Any method of one of these namespaces of Lucid is a decoder call: `tx.pay.*`, `tx.attach.*`, `lucid.selectWallet.*`. */
const NAMESPACES = ["pay", "attach", "selectWallet"];

/** The methods of `Data` of Lucid that read a text. */
const DATA_METHODS = ["from", "fromJson", "toJson"];

/** A chain with one of these names goes through the decoder library. A call on it is never excluded. */
const LIBRARY_ROOTS = ["CML", "lucid"];

/** Modules of the decoder library and of Lucid. */
const LIBRARY_MODULE = /^@(?:lucid-evolution|anastasia-labs)\//;

/**
 * The words that make a detection possible. A file with none of them cannot hold a decoder call, and the scan does not parse it.
 * `extraWords` are the names of the functions that the guards follow.
 */
function detectionPattern(extraWords: readonly string[]): RegExp {
  const words = [...DECODER_NAMES, ...NAMESPACES, ...LIBRARY_ROOTS, ...extraWords, "getUtxos"];
  return new RegExp(`\\b(?:${words.join("|")})\\b|\\bData\\s*(?:\\?\\.|\\.|\\[)`);
}

// ─── The tree ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type FunctionLike =
  | ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
  | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
  );
}

/** The text of a node without spaces, and with `.` for `?.`: a chain over two lines reads as one line. */
const squash = (node: ts.Node): string => node.getText().replace(/\s+/g, "").replace(/\?\./g, ".");

/** The expression without parentheses, `!`, `as`, `satisfies`, `<T>`, `await`, and the left side of a comma: `(0, f)` is `f`. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) current = current.right;
    else if (
      ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current) || ts.isAwaitExpression(current)
    ) current = current.expression;
    else return current;
  }
}

/** The name of a member: `name` in `x.name` and in `x["name"]`. */
function memberName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    const key = expression.argumentExpression;
    if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return key.text;
  }
  return undefined;
}

/** The name of a callee: a member or an identifier. */
function calleeName(expression: ts.Expression): string | undefined {
  const callee = unwrap(expression);
  return ts.isIdentifier(callee) ? callee.text : memberName(callee);
}

/** The names along a chain of members and calls, from its root: `lucid.newTx().pay` gives lucid, newTx, pay. */
function chainNames(expression: ts.Expression): string[] {
  const names: string[] = [];
  let current = unwrap(expression);
  for (;;) {
    if (ts.isCallExpression(current)) {
      current = unwrap(current.expression);
    } else if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      names.push(memberName(current) ?? "[]");
      current = unwrap(current.expression);
    } else {
      if (ts.isIdentifier(current)) names.push(current.text);
      else if (current.kind === ts.SyntaxKind.ThisKeyword) names.push("this");
      break;
    }
  }
  return names.reverse();
}

const throughLibrary = (receiver: ts.Expression): boolean => chainNames(receiver).some((name) => LIBRARY_ROOTS.includes(name));

/** The functions around a node, the innermost first. */
function enclosingFunctions(node: ts.Node): FunctionLike[] {
  const functions: FunctionLike[] = [];
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) if (isFunctionLike(parent)) functions.push(parent);
  return functions;
}

const ownerName = (node: ts.Node): string =>
  (ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name !== undefined ? `${node.name.text}.` : "";

/** The name of a function: its own name, the class and the method, or the variable or the property that holds it. Else none. */
function functionName(fn: FunctionLike): string | undefined {
  if (ts.isConstructorDeclaration(fn)) return `${ownerName(fn.parent)}constructor`;
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
    return `${ownerName(fn.parent)}${fn.name.getText()}`;
  }
  if (fn.name !== undefined) return fn.name.text;
  const holder = fn.parent;
  if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
  if (ts.isPropertyDeclaration(holder) || ts.isPropertyAssignment(holder)) return `${ownerName(holder.parent)}${holder.name.getText()}`;
  return undefined;
}

/** The nearest function around a node that has a name. A callback has none. */
const namedScope = (node: ts.Node): FunctionLike | undefined => enclosingFunctions(node).find((fn) => functionName(fn) !== undefined);

/** The names of the functions around a node, the outermost first, joined with ">". `<module>` outside any function. */
function functionLabel(node: ts.Node): string {
  const names = enclosingFunctions(node).map(functionName).filter((name): name is string => name !== undefined);
  return names.length === 0 ? "<module>" : names.reverse().join(">");
}

/** A function of a file by its label. */
function functionNamed(file: ts.SourceFile, label: string): FunctionLike {
  let found: FunctionLike | undefined;
  const visit = (node: ts.Node): void => {
    if (found === undefined && isFunctionLike(node) && node.body !== undefined && functionName(node) !== undefined && functionLabel(node.body) === label) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (found === undefined) throw new Error(`${rootPath(file.fileName)} has no function ${label}`);
  return found;
}

const lineOf = (node: ts.Node): number => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

/** Every call inside a node. */
function callsWithin(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) calls.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return calls;
}

/** The names that an expression reads: its identifiers, not the member names and not the keys of an object. */
function identifiersIn(expression: ts.Node): ts.Identifier[] {
  const identifiers: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isName) identifiers.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return identifiers;
}

/** The initializers of the declarations of `identifier` inside `within`: `const x = ...`, `const { x } = ...`, `const [x] = ...`. */
function declaredInitializers(identifier: ts.Identifier, within: ts.Node): ts.Expression[] {
  const initializers: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined && ts.isIdentifier(node.name) && node.name.text === identifier.text) {
      initializers.push(node.initializer);
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === identifier.text) {
      let declaration: ts.Node = node;
      while (!ts.isVariableDeclaration(declaration) && declaration.parent !== undefined) declaration = declaration.parent;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) initializers.push(declaration.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(within);
  return initializers;
}

// ─── The detector ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface DecoderCall {
  file: string;
  line: number;
  /** The functions around the call, the outermost first, joined with ">". */
  fn: string;
  /** The name of the method or of the function, as the library has it. */
  callee: string;
  /** The call, or the reference to a decoder that is not called where it stands. */
  node: ts.Node;
  /** The receiver of a call of a member. */
  receiver: ts.Expression | undefined;
}

/** The names that a destructuring, a variable or an import alias gives to a name of the library. */
function decoderAliases(file: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && node.propertyName !== undefined && DECODER_NAMES.includes(node.propertyName.text)) {
      aliases.set(node.name.text, node.propertyName.text);
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const source = node.propertyName === undefined ? node.name.text : ts.isIdentifier(node.propertyName) ? node.propertyName.text : undefined;
      if (source !== undefined && DECODER_NAMES.includes(source)) aliases.set(node.name.text, source);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const value = unwrap(node.initializer);
      const source = ts.isIdentifier(value) ? (aliases.get(value.text) ?? value.text) : memberName(value);
      if (source !== undefined && DECODER_NAMES.includes(source)) aliases.set(node.name.text, source);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return aliases;
}

/** The decoder name of a call, or none. */
function decoderNameOfCall(call: ts.CallExpression, aliases: ReadonlyMap<string, string>): string | undefined {
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    const receiver = unwrap(callee.expression);
    const member = memberName(callee);
    if (member === undefined) return throughLibrary(receiver) ? "<computed>" : undefined;
    if (DECODER_NAMES.includes(member)) return member;
    if (member === "getUtxos" && ts.isCallExpression(receiver) && calleeName(receiver.expression) === "wallet") return member;
    if (ts.isIdentifier(receiver) && receiver.text === "Data" && DATA_METHODS.includes(member)) return `Data.${member}`;
    const namespace = ts.isIdentifier(receiver) ? receiver.text : memberName(receiver);
    if (namespace !== undefined && NAMESPACES.includes(namespace)) return member;
    return member.startsWith("from_") && chainNames(receiver).includes("CML") ? member : undefined;
  }
  if (!ts.isIdentifier(callee)) return undefined;
  const name = aliases.get(callee.text) ?? callee.text;
  return DECODER_NAMES.includes(name) ? name : undefined;
}

/**
 * True when `node` hands a function on and does not call it where it stands: an argument, an initializer, an array element, a returned
 * value, or the receiver of `call`, `apply` and `bind`.
 */
function isHandedOn(node: ts.Expression): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.expression !== child;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === child && ["call", "apply", "bind"].includes(parent.name.text);
  return (
    (ts.isVariableDeclaration(parent) && parent.initializer === child) || (ts.isPropertyAssignment(parent) && parent.initializer === child) ||
    ts.isShorthandPropertyAssignment(parent) || ts.isArrayLiteralExpression(parent) || ts.isReturnStatement(parent) || ts.isSpreadElement(parent)
  );
}

/** The node of the name in a callee or a reference: `name` of `x.name`, the key of `x["name"]`, or the identifier. */
const nameNode = (expression: ts.Expression): ts.Node =>
  ts.isPropertyAccessExpression(expression) ? expression.name : ts.isElementAccessExpression(expression) ? expression.argumentExpression : expression;

/** The decoder calls in a file, and the decoders that the file hands on. A comment or a string holds no call. */
function findDecoderCalls(file: ts.SourceFile): DecoderCall[] {
  const aliases = decoderAliases(file);
  const found: DecoderCall[] = [];
  const add = (node: ts.Node, callee: string, target: ts.Expression): void => {
    const receiver = ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target) ? target.expression : undefined;
    found.push({ file: rootPath(file.fileName), line: lineOf(nameNode(target)), fn: functionLabel(node), callee, node, receiver: ts.isCallExpression(node) ? receiver : undefined });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = decoderNameOfCall(node, aliases);
      if (callee !== undefined) add(node, callee, unwrap(node.expression));
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) && isHandedOn(node)) {
      const name = ts.isIdentifier(node) ? (aliases.get(node.text) ?? node.text) : memberName(node);
      if (name !== undefined && DECODER_NAMES.includes(name)) add(node, name, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// ─── The calls that are not decoder calls ────────────────────────────────────────────────────────────────────────────────────────

/** The receiver of complete of the sign builder: `x.sign.withWallet()` or `x.sign.withPrivateKey(key)`. */
const SIGN_BUILDER = "the sign builder of Lucid";

interface Exclusion {
  callee: string;
  /** The files: a path, or a folder when it ends with `/`, or `anywhere`. */
  where: string;
  /** The receiver, with no spaces, or SIGN_BUILDER. */
  receiver: string;
  reason: string;
}

const SIGN_COMPLETE: Exclusion = {
  callee: "complete",
  where: "anywhere",
  receiver: SIGN_BUILDER,
  reason:
    "`sign.withWallet().complete()` and `sign.withPrivateKey(key).complete()` call complete of TxSignBuilder, not of TxBuilder. Its type " +
    "takes no argument (`complete: () => Promise<TxSigned>` in the declarations of Lucid), and its code adds the witnesses to the " +
    "transaction that the builder made. It reads no output, address, datum or script.",
};

const JOB_STORE_COMPLETE: Exclusion = {
  callee: "complete",
  where: "supplier/src/jobRunner.ts",
  receiver: "deps.jobs",
  reason: "`deps.jobs` is the JobStore of the supplier (supplier/src/jobs.ts): an in-memory table of jobs. The file imports no library.",
};

const DEPLOY_CHAIN_UTXOS_AT: Exclusion = {
  callee: "utxosAt",
  where: "contracts/identity-marketplace/deploy/",
  receiver: "chain",
  reason:
    "`chain` is the Chain of the deploy tool (deploy/chain.ts). It asks Ogmios by JSON-RPC and maps the answer by hand. The tool builds " +
    "its transactions with the encoder of this repository, and the files of these calls import no library.",
};

const EXCLUDED: readonly Exclusion[] = [SIGN_COMPLETE, JOB_STORE_COMPLETE, DEPLOY_CHAIN_UTXOS_AT];

function isSignBuilder(receiver: ts.Expression): boolean {
  const call = unwrap(receiver);
  if (!ts.isCallExpression(call)) return false;
  const method = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(method) && !ts.isElementAccessExpression(method)) return false;
  return ["withWallet", "withPrivateKey"].includes(memberName(method) ?? "") && memberName(unwrap(method.expression)) === "sign";
}

/** The exclusion of a call. A call through the decoder library has none. */
function exclusionOf(call: DecoderCall): Exclusion | undefined {
  const receiver = call.receiver;
  if (receiver === undefined || throughLibrary(receiver)) return undefined;
  return EXCLUDED.find((exclusion) => {
    const inFile = exclusion.where === "anywhere" || call.file === exclusion.where || (exclusion.where.endsWith("/") && call.file.startsWith(exclusion.where));
    const sameReceiver = exclusion.receiver === SIGN_BUILDER ? isSignBuilder(receiver) : squash(receiver) === exclusion.receiver;
    return exclusion.callee === call.callee && inFile && sameReceiver;
  });
}

// ─── The scan of the repository ──────────────────────────────────────────────────────────────────────────────────────────────────

interface TrackedCall {
  file: string;
  node: ts.CallExpression;
}

interface Scan {
  /** Each source file, also the files that cannot hold a decoder call. */
  files: string[];
  sites: DecoderCall[];
  excluded: Array<{ call: DecoderCall; exclusion: Exclusion }>;
  /** The calls of the functions that the guards follow, by the name of the function. */
  tracked: Map<string, TrackedCall[]>;
}

function scanSources(files: readonly string[], trackedNames: readonly string[]): Scan {
  const scan: Scan = { files: [], sites: [], excluded: [], tracked: new Map() };
  const pattern = detectionPattern(trackedNames);
  for (const path of files) {
    scan.files.push(rootPath(path));
    const text = readFileSync(path, "utf8");
    if (!pattern.test(text)) continue;
    const file = parseText(path, text);
    for (const call of findDecoderCalls(file)) {
      const exclusion = exclusionOf(call);
      if (exclusion === undefined) scan.sites.push(call);
      else scan.excluded.push({ call, exclusion });
    }
    for (const node of callsWithin(file)) {
      const name = calleeName(node.expression);
      if (name !== undefined && trackedNames.includes(name)) scan.tracked.set(name, [...(scan.tracked.get(name) ?? []), { file: rootPath(path), node }]);
    }
  }
  return scan;
}

// ─── The table ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A proof on the tree. */
type Guard =
  /** A call of `call` runs in the same function before the decoder call. With `arg`, that argument of the decoder call comes from it. */
  | { kind: "before"; call: string; arg?: number }
  /** The function of the row is a helper. Each call of it runs `call` before it, in the function of the call. */
  | { kind: "callers"; call: string }
  /** The first argument is a constant text. */
  | { kind: "constant" }
  /** The argument `arg` is a member with this name, as `walletKey.pubKeyHash`. */
  | { kind: "member"; name: string; arg: number };

const before = (call: string, arg?: number): Guard => ({ kind: "before", call, arg });
const afterCheckOfCallers = (call: string): Guard => ({ kind: "callers", call });
const CONSTANT: Guard = { kind: "constant" };
const KEY_HASH_OF_KEY: Guard = { kind: "member", name: "pubKeyHash", arg: 0 };

interface Site {
  file: string;
  /** The functions around the call, the outermost first, joined with ">". */
  fn: string;
  callee: string;
  /** The number of calls. */
  count: number;
  /** The check that runs before the call, or why no check is needed. */
  reason: string;
  guards: Guard[];
}

const site = (file: string, fn: string, callee: string, count: number, reason: string, ...guards: Guard[]): Site => ({ file, fn, callee, count, reason, guards });

const LIVE_CBOR = "packages/shared/src/tx/internal/liveCbor.ts";
const LIVE_IDENTITY_CBOR = "packages/shared/src/tx/internal/liveIdentityCbor.ts";
const LUCID_CONTEXT = "packages/shared/src/tx/internal/lucidContext.ts";
const SIGNED_TRANSACTION = "packages/shared/src/tx/internal/signedTransaction.ts";
const DECODER_HEALTH = "packages/shared/src/tx/internal/decoderHealth.ts";
const ANCHOR_METADATA = "packages/shared/src/tx/wallet/anchorMetadata.ts";
const CONSOLIDATE_WALLET = "packages/shared/src/tx/wallet/consolidateWallet.ts";
const WITHDRAW_WALLET = "packages/shared/src/tx/wallet/withdrawWallet.ts";
const DEPLOY_SCRIPTS = "contracts/identity-marketplace/deploy/scripts.ts";

// The reasons. Each one comes from the code of the row.

const LUCID_CHECKS =
  "The mapper of the Lucid client bounds the address, the transaction id, the policy ids and the asset names of the output " +
  "(assertOutputFields). WithheldOutputs checks its datum and its native script (chain/datumGuard.ts).";
const READ_ONLY_CHECKS =
  "The mapper of the read-only client bounds the address, the transaction id, the policy ids and the asset names of the output " +
  "(assertOutputFields). WithheldOutputs checks its datum (chain/datumGuard.ts). The client maps no native script.";
const WALLET_OUTPUTS =
  `The wallet outputs come from the Lucid client (chain/OgmiosLucidProvider.ts). ${LUCID_CHECKS} ` +
  "The Lucid context of the function is made on that client (createLucidContext takes it).";
const BUILDER_INPUTS =
  "The builder reads the wallet outputs, the outputs of collectFrom and readFrom, and the scripts of attach (their rows). The change " +
  "address is the wallet address that Lucid derives from the wallet key.";
const WALLET_KEY_HASH = "The key hash is the key hash of the wallet key of the operator. The loaders of the wallet derive it from the key and write it as hex.";
const SIGNER_KEY_HASH =
  "The key hash is the one of the wallet key of the operator, or a key hash field of a datum that this package read with its own codec " +
  "(28 bytes, written as hex).";
const OPAQUE_SCRIPT =
  "The script is the Plutus V3 script of the blueprint of this repository (loadEscrowScript, loadAdvertScript or the identity blueprint). " +
  "Plutus script bytes are opaque.";
const REFERENCE_SCRIPT_OUTPUT =
  "The output is the reference script output that resolveSpendCtx reads by an output reference that the operator sets in the " +
  `environment. The Lucid client maps it. ${LUCID_CHECKS} A Plutus script is opaque bytes. An output with a native script that fails ` +
  "the check is left out, and resolveSpendCtx then finds no output and throws.";
const SPEND_INPUT =
  "The output comes from the read-only client (chain/ReadOnlyOgmiosProvider.ts) through readEscrow or readAdvert, which read it by its " +
  `output reference. ${READ_ONLY_CHECKS} chainUtxoToLucidScriptInput keeps the datum and drops the script. The redeemer is encoded by ` +
  "this package.";
const PKH_ADDRESS =
  "The address text comes from pkhToEnterpriseAddress of this package: it writes a bech32 text from a 28-byte key hash, so the text " +
  "never comes from outside.";
const BLUEPRINT_ADDRESS = "The address text is the script address of the blueprint (loadEscrowScript): this package writes it from a script hash.";
const OWN_ESCROW_DATUM = "The datum is encoded by this package (encodeEscrowDatum) from a datum value.";
const OWN_ADVERT_DATUM = "The datum is encoded by this package (encodeAdvertDatum) from a datum value.";
const ADDRESS_CHECK =
  "checkedAddressText runs first on the address text (tx/internal/addressText.ts). It refuses the empty text and a text that is longer " +
  "than any address text.";
const SHELLEY_CHECK =
  "checkedShelleyAddress runs first on the address text (tx/internal/addressText.ts). It refuses the empty text, a text that is too long, " +
  "and a text that is not a Shelley payment address.";
const OWN_TRANSACTION = "The transaction CBOR is the result of a build in this process, or its own journal row. No bytes come from outside.";

const SITES: Site[] = [
  // ── tx/internal/liveCbor.ts: the builders of the legacy escrow and advert ───────────────────────────────────────────────────────
  site(LIVE_CBOR, "resolveSpendCtx", "utxosByOutRef", 1,
    `${REFERENCE_SCRIPT_OUTPUT} The reference comes from parseRefUtxoEnv. The Lucid context comes from the callers.`,
    before("parseRefUtxoEnv", 0), afterCheckOfCallers("createLucidContext")),
  site(LIVE_CBOR, "resolveSpendCtx", "validatorToScriptHash", 2,
    "The script is the reference script of the output that utxosByOutRef gave. A Plutus script is opaque bytes. A native script " +
    "passed WithheldOutputs in the mapper of the Lucid client, or the client left the output out.",
    before("lucid.utxosByOutRef", 0)),

  site(LIVE_CBOR, "buildLiveTxForEscrow", "getUtxos", 1, WALLET_OUTPUTS, before("createLucidContext")),
  site(LIVE_CBOR, "buildLiveTxForEscrow", "ToAddressWithData", 1,
    `${ADDRESS_CHECK} ${OWN_ESCROW_DATUM} The datum of the identity layout is encoded by the codec of this package in the caller.`,
    before("checkedAddressText", 0), before("encodeEscrowDatum", 1)),
  site(LIVE_CBOR, "buildLiveTxForEscrow", "addSignerKey", 1, WALLET_KEY_HASH, KEY_HASH_OF_KEY),
  site(LIVE_CBOR, "buildLiveTxForEscrow", "complete", 2, BUILDER_INPUTS, before("createLucidContext")),

  site(LIVE_CBOR, "buildSpendOpenOrClaimedTx", "getUtxos", 1, WALLET_OUTPUTS, before("createLucidContext")),
  site(LIVE_CBOR, "buildSpendOpenOrClaimedTx", "readFrom", 1, REFERENCE_SCRIPT_OUTPUT, before("resolveSpendCtx", 0)),
  site(LIVE_CBOR, "buildSpendOpenOrClaimedTx", "SpendingValidator", 1, OPAQUE_SCRIPT, before("resolveSpendCtx", 0)),
  site(LIVE_CBOR, "buildSpendOpenOrClaimedTx", "collectFrom", 1, SPEND_INPUT, before("chainUtxoToLucidScriptInput", 0)),
  site(LIVE_CBOR, "buildSpendOpenOrClaimedTx", "ToAddressWithData", 1, `${BLUEPRINT_ADDRESS} ${OWN_ESCROW_DATUM}`,
    before("loadEscrowScript", 0), before("encodeEscrowDatum", 1)),
  site(LIVE_CBOR, "buildSpendOpenOrClaimedTx", "addSignerKey", 1,
    "The key hash is signerPkh, which buildLiveTxForClaim and buildLiveTxForSubmit take from the key hash of the wallet key of the supplier."),
  site(LIVE_CBOR, "buildSpendOpenOrClaimedTx", "complete", 1, BUILDER_INPUTS, before("createLucidContext")),

  site(LIVE_CBOR, "buildLiveTxForAccept", "getUtxos", 1, WALLET_OUTPUTS, before("createLucidContext")),
  site(LIVE_CBOR, "buildLiveTxForAccept", "readFrom", 1, REFERENCE_SCRIPT_OUTPUT, before("resolveSpendCtx", 0)),
  site(LIVE_CBOR, "buildLiveTxForAccept", "SpendingValidator", 1, OPAQUE_SCRIPT, before("resolveSpendCtx", 0)),
  site(LIVE_CBOR, "buildLiveTxForAccept", "collectFrom", 1, SPEND_INPUT, before("chainUtxoToLucidScriptInput", 0)),
  site(LIVE_CBOR, "buildLiveTxForAccept", "ToAddress", 2, PKH_ADDRESS, before("pkhToEnterpriseAddress", 0)),
  site(LIVE_CBOR, "buildLiveTxForAccept", "addSignerKey", 1, WALLET_KEY_HASH, KEY_HASH_OF_KEY),
  site(LIVE_CBOR, "buildLiveTxForAccept", "complete", 1, BUILDER_INPUTS, before("createLucidContext")),

  site(LIVE_CBOR, "buildLiveTxForReclaim", "getUtxos", 1, WALLET_OUTPUTS, before("createLucidContext")),
  site(LIVE_CBOR, "buildLiveTxForReclaim", "readFrom", 1, REFERENCE_SCRIPT_OUTPUT, before("resolveSpendCtx", 0)),
  site(LIVE_CBOR, "buildLiveTxForReclaim", "SpendingValidator", 1, OPAQUE_SCRIPT, before("resolveSpendCtx", 0)),
  site(LIVE_CBOR, "buildLiveTxForReclaim", "collectFrom", 1, SPEND_INPUT, before("chainUtxoToLucidScriptInput", 0)),
  site(LIVE_CBOR, "buildLiveTxForReclaim", "ToAddress", 1, PKH_ADDRESS, before("pkhToEnterpriseAddress", 0)),
  site(LIVE_CBOR, "buildLiveTxForReclaim", "addSignerKey", 1, WALLET_KEY_HASH, KEY_HASH_OF_KEY),
  site(LIVE_CBOR, "buildLiveTxForReclaim", "complete", 1, BUILDER_INPUTS, before("createLucidContext")),

  site(LIVE_CBOR, "buildLiveTxForRelease", "getUtxos", 1, WALLET_OUTPUTS, before("createLucidContext")),
  site(LIVE_CBOR, "buildLiveTxForRelease", "readFrom", 1, REFERENCE_SCRIPT_OUTPUT, before("resolveSpendCtx", 0)),
  site(LIVE_CBOR, "buildLiveTxForRelease", "SpendingValidator", 1, OPAQUE_SCRIPT, before("resolveSpendCtx", 0)),
  site(LIVE_CBOR, "buildLiveTxForRelease", "collectFrom", 1, SPEND_INPUT, before("chainUtxoToLucidScriptInput", 0)),
  site(LIVE_CBOR, "buildLiveTxForRelease", "ToAddress", 1, PKH_ADDRESS, before("pkhToEnterpriseAddress", 0)),
  site(LIVE_CBOR, "buildLiveTxForRelease", "addSignerKey", 1, WALLET_KEY_HASH, KEY_HASH_OF_KEY),
  site(LIVE_CBOR, "buildLiveTxForRelease", "complete", 1, BUILDER_INPUTS, before("createLucidContext")),

  site(LIVE_CBOR, "buildLiveTxForAdvert", "ToAddressWithData", 1,
    `${ADDRESS_CHECK} ${OWN_ADVERT_DATUM} The datum of the identity layout is encoded by the codec of this package in the caller.`,
    before("checkedAddressText", 0), before("encodeAdvertDatum", 1)),
  site(LIVE_CBOR, "buildLiveTxForAdvert", "addSignerKey", 1, WALLET_KEY_HASH, KEY_HASH_OF_KEY),
  site(LIVE_CBOR, "buildLiveTxForAdvert", "complete", 1, BUILDER_INPUTS, before("createLucidContext")),

  site(LIVE_CBOR, "buildLiveTxForRetireAdvert", "getUtxos", 1, WALLET_OUTPUTS, before("createLucidContext")),
  site(LIVE_CBOR, "buildLiveTxForRetireAdvert", "readFrom", 1, REFERENCE_SCRIPT_OUTPUT, before("resolveSpendCtx", 0)),
  site(LIVE_CBOR, "buildLiveTxForRetireAdvert", "SpendingValidator", 1, OPAQUE_SCRIPT, before("resolveSpendCtx", 0)),
  site(LIVE_CBOR, "buildLiveTxForRetireAdvert", "collectFrom", 1, SPEND_INPUT, before("chainUtxoToLucidScriptInput", 0)),
  site(LIVE_CBOR, "buildLiveTxForRetireAdvert", "ToAddress", 1, PKH_ADDRESS, before("pkhToEnterpriseAddress", 0)),
  site(LIVE_CBOR, "buildLiveTxForRetireAdvert", "addSignerKey", 1, WALLET_KEY_HASH, KEY_HASH_OF_KEY),
  site(LIVE_CBOR, "buildLiveTxForRetireAdvert", "complete", 1, BUILDER_INPUTS, before("createLucidContext")),

  // ── tx/internal/liveIdentityCbor.ts: the spends of the identity layout ──────────────────────────────────────────────────────────
  site(LIVE_IDENTITY_CBOR, "minimumLovelace", "from_bech32", 1,
    `${ADDRESS_CHECK} The function is a helper: each of its callers (buildLiveScriptSpend) checks each output address before it calls it. ` +
    "The address of an output can come from the refund field of a datum.",
    afterCheckOfCallers("checkedAddressText")),
  site(LIVE_IDENTITY_CBOR, "minimumLovelace", "from_cbor_hex", 1,
    "The datum text of an output of the spend is encoded by this package from a datum value (the codec of the identity layout). The " +
    "value comes from a datum that passed the check of the client."),
  site(LIVE_IDENTITY_CBOR, "minimumLovelace", "assetsToValue", 1,
    "The units are the assets of an output that the read-only client mapped: its mapper bounds each policy ID and each asset name " +
    "(assertOutputFields)."),

  site(LIVE_IDENTITY_CBOR, "buildLiveScriptSpend", "getUtxos", 1, WALLET_OUTPUTS, before("createLucidContext")),
  site(LIVE_IDENTITY_CBOR, "buildLiveScriptSpend", "readFrom", 2,
    `${REFERENCE_SCRIPT_OUTPUT} The reference inputs (the agent record) come from the record lookup of the process. It reads the chain ` +
    `through the read-only client. ${READ_ONLY_CHECKS}`,
    before("resolveSpendCtx")),
  site(LIVE_IDENTITY_CBOR, "buildLiveScriptSpend", "SpendingValidator", 1, OPAQUE_SCRIPT, before("resolveSpendCtx", 0)),
  site(LIVE_IDENTITY_CBOR, "buildLiveScriptSpend", "collectFrom", 1, SPEND_INPUT, before("chainUtxoToLucidScriptInput", 0)),
  site(LIVE_IDENTITY_CBOR, "buildLiveScriptSpend", "ToAddress", 1,
    `${ADDRESS_CHECK} The refund address of a datum is a text from outside, so the check runs on each output address first.`,
    before("checkedAddressText", 0)),
  site(LIVE_IDENTITY_CBOR, "buildLiveScriptSpend", "ToAddressWithData", 1,
    `${ADDRESS_CHECK} The datum text is encoded by this package from a datum value.`, before("checkedAddressText", 0)),
  site(LIVE_IDENTITY_CBOR, "buildLiveScriptSpend", "addSignerKey", 1, SIGNER_KEY_HASH),
  site(LIVE_IDENTITY_CBOR, "buildLiveScriptSpend", "complete", 1, BUILDER_INPUTS, before("createLucidContext")),

  // ── tx/internal: the wallet context, the inspection of a signed transaction, the self-check ─────────────────────────────────────
  site(LUCID_CONTEXT, "createLucidContext", "fromPrivateKey", 1,
    "The key text comes from hexPrivateKeyToBech32. The hex text of the wallet key is tested first (HEX64_RE.test: 64 hex characters).",
    before("HEX64_RE.test")),
  site(LUCID_CONTEXT, "hexPrivateKeyToBech32", "from_normal_bytes", 1,
    "The bytes come from the hex text of the wallet key. The function is a helper: each of its callers (createLucidContext) tests the " +
    "text first (HEX64_RE.test: 64 hex characters).",
    afterCheckOfCallers("HEX64_RE.test")),
  site(SIGNED_TRANSACTION, "inspectSignedTransaction", "from_cbor_hex", 1, OWN_TRANSACTION),
  site(SIGNED_TRANSACTION, "inspectSignedTransactionFinancials", "from_cbor_hex", 1, OWN_TRANSACTION),
  site(DECODER_HEALTH, "decoderWorks", "from_cbor_hex", 1, "The self-check decodes one known value: the argument is a constant text.", CONSTANT),

  // ── tx/wallet: the wallet builders ──────────────────────────────────────────────────────────────────────────────────────────────
  site(ANCHOR_METADATA, "buildAnchorMetadataTx", "getUtxos", 1, WALLET_OUTPUTS, before("createLucidContext")),
  site(ANCHOR_METADATA, "buildAnchorMetadataTx", "attachMetadata", 1,
    "The metadata object is the payload of a surplus sale proof. validateSurplusSaleProofAnchorMetadata checks each field first: the " +
    "protocol name, 64 hex characters, a positive count, and printable ASCII ids of at most 64 bytes.",
    before("validateSurplusSaleProofAnchorMetadata")),
  site(ANCHOR_METADATA, "buildAnchorMetadataTx", "addSignerKey", 1, WALLET_KEY_HASH, KEY_HASH_OF_KEY),
  site(ANCHOR_METADATA, "buildAnchorMetadataTx", "complete", 1, BUILDER_INPUTS, before("createLucidContext")),

  site(CONSOLIDATE_WALLET, "buildConsolidateWalletTx", "getUtxos", 1, WALLET_OUTPUTS, before("createLucidContext")),
  site(CONSOLIDATE_WALLET, "buildConsolidateWalletTx", "ToAddress", 2,
    `${SHELLEY_CHECK} The wallet address of a service can come from the environment (SUPPLIER_ADDRESS).`, before("checkedShelleyAddress", 0)),
  site(CONSOLIDATE_WALLET, "buildConsolidateWalletTx", "addSignerKey", 1, WALLET_KEY_HASH, KEY_HASH_OF_KEY),
  site(CONSOLIDATE_WALLET, "buildConsolidateWalletTx", "complete", 1, BUILDER_INPUTS, before("createLucidContext")),

  site(WITHDRAW_WALLET, "buildWithdrawTx", "getUtxos", 1, WALLET_OUTPUTS, before("createLucidContext")),
  site(WITHDRAW_WALLET, "buildWithdrawTx", "ToAddress", 1,
    `${SHELLEY_CHECK} The destination comes from a request.`, before("checkedShelleyAddress", 0)),
  site(WITHDRAW_WALLET, "buildWithdrawTx", "addSignerKey", 1, WALLET_KEY_HASH, KEY_HASH_OF_KEY),
  site(WITHDRAW_WALLET, "buildWithdrawTx", "complete", 1, BUILDER_INPUTS, before("createLucidContext")),

  // ── The deploy tool ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  site(DEPLOY_SCRIPTS, "applyParameters", "apply_params_to_script", 1,
    "An operator tool applies parameters to a script of the blueprint file of this repository. Each caller compares the hash of the " +
    "code with the blueprint first (plutusV3Hash), and the parameters are encoded by this package.",
    afterCheckOfCallers("plutusV3Hash")),
];

const keyOf = (file: string, fn: string, callee: string): string => `${file} :: ${fn} :: ${callee}`;
const rowKey = (row: Site): string => keyOf(row.file, row.fn, row.callee);

/** The check functions that a reason can name. A reason that names one needs a proof of it. */
const CHECK_NAMES = [
  "checkedAddressText", "checkedShelleyAddress", "validateSurplusSaleProofAnchorMetadata", "HEX64_RE.test", "pkhToEnterpriseAddress", "plutusV3Hash",
];

type FoundSite = Pick<DecoderCall, "file" | "fn" | "callee" | "line">;

/** The calls that the table does not name, and the counts that differ. Empty when the tree and the table agree. */
function compareSites(found: readonly FoundSite[], table: readonly Site[]): string[] {
  const named = new Map(table.map((row) => [rowKey(row), row.count]));
  const namedFiles = table.map((row) => row.file);
  const seen = new Map<string, { count: number; lines: number[]; file: string }>();
  for (const call of found) {
    const key = keyOf(call.file, call.fn, call.callee);
    const entry = seen.get(key) ?? { count: 0, lines: [], file: call.file };
    entry.count += 1;
    entry.lines.push(call.line);
    seen.set(key, entry);
  }
  const problems: string[] = [];
  for (const [key, entry] of seen) {
    const count = named.get(key);
    const lines = `(line ${entry.lines.join(", ")})`;
    if (count === undefined) problems.push(`${key} ${lines}: ${namedFiles.includes(entry.file) ? "this function is not in the table" : "this file is not in the table"}`);
    else if (count !== entry.count) problems.push(`${key} ${lines}: the table says ${count}, the tree has ${entry.count}`);
  }
  for (const key of named.keys()) if (!seen.has(key)) problems.push(`${key}: the table names a call that the tree does not have`);
  return problems.sort();
}

/** The calls of a table, as the scan would give them. */
const expandTable = (table: readonly Site[]): FoundSite[] =>
  table.flatMap((row) => Array.from({ length: row.count }, (_unused, index) => ({ file: row.file, fn: row.fn, callee: row.callee, line: index + 1 })));

// ─── The proof of an order ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The calls of `callText` that run before `node` in its function: in the same named function, in the same function or in one that holds
 * it (not in a callback beside it), and that end before `node` ends. A call inside the arguments of `node` runs before it too.
 */
function earlierCalls(node: ts.Node, callText: string): ts.CallExpression[] {
  const named = namedScope(node);
  const around = enclosingFunctions(node);
  return callsWithin(named ?? node.getSourceFile()).filter((candidate) => {
    if (candidate === node || squash(candidate.expression) !== callText || candidate.getEnd() > node.getEnd()) return false;
    if (namedScope(candidate) !== named) return false;
    const scope = enclosingFunctions(candidate)[0];
    return scope === undefined ? around.length === 0 : around.includes(scope);
  });
}

/** True when `argument` holds the text that `check` read or made: the check itself, the same text, or a name that the check gives. */
function argumentCarries(argument: ts.Expression, check: ts.CallExpression, within: ts.Node): boolean {
  if (argument.getStart() <= check.getStart() && check.getEnd() <= argument.getEnd()) return true;
  const first = check.arguments[0];
  if (first !== undefined && squash(argument) === squash(first)) return true;
  return identifiersIn(argument).some((identifier) =>
    declaredInitializers(identifier, within).some((initializer) => initializer.getStart() <= check.getStart() && check.getEnd() <= initializer.getEnd()));
}

/** The name of the function of a row: the last part of its label. */
const helperName = (fn: string): string => fn.split(">").pop()!.split(".").pop()!;

/** True when a module-level `const` gives `name` a string. */
const isConstantText = (file: ts.SourceFile, name: string): boolean =>
  file.statements.some((statement) =>
    ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    statement.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer !== undefined && ts.isStringLiteralLike(declaration.initializer)));

/** A message when the guard does not hold for a call, else undefined. */
function guardProblem(call: DecoderCall, guard: Guard, tracked: ReadonlyMap<string, TrackedCall[]>): string | undefined {
  const node = call.node;
  const argumentAt = (index: number): ts.Expression | undefined => (ts.isCallExpression(node) ? node.arguments[index] : undefined);
  if (guard.kind === "constant") {
    const argument = argumentAt(0);
    if (argument === undefined) return "the call has no argument";
    const constant = ts.isStringLiteralLike(argument) || (ts.isIdentifier(argument) && isConstantText(node.getSourceFile(), argument.text));
    return constant ? undefined : "the first argument is not a constant text";
  }
  if (guard.kind === "member") {
    const argument = argumentAt(guard.arg);
    if (argument === undefined) return `the call has no argument ${guard.arg}`;
    return memberName(unwrap(argument)) === guard.name ? undefined : `argument ${guard.arg} is not a ${guard.name}`;
  }
  if (guard.kind === "callers") {
    const helper = helperName(call.fn);
    const callers = tracked.get(helper) ?? [];
    if (callers.length === 0) return `nothing calls ${helper}`;
    const unchecked = callers.find((caller) => earlierCalls(caller.node, guard.call).length === 0);
    return unchecked === undefined ? undefined : `${unchecked.file}:${lineOf(unchecked.node)} calls ${helper} with no call of ${guard.call} before it in its function`;
  }
  const checks = earlierCalls(node, guard.call);
  if (checks.length === 0) return `no call of ${guard.call} runs before it in the same function`;
  if (guard.arg === undefined) return undefined;
  const argument = argumentAt(guard.arg);
  if (argument === undefined) return `the call has no argument ${guard.arg}`;
  const within = namedScope(node) ?? node.getSourceFile();
  return checks.some((check) => argumentCarries(argument, check, within)) ? undefined : `argument ${guard.arg} does not come from ${guard.call}`;
}

/** The names of the functions that the guards follow: the helpers of the table and the functions of the Lucid context. */
const trackedNamesOf = (table: readonly Site[]): string[] => [
  "createLucidContext", "buildLucidProvider",
  ...table.filter((row) => row.guards.some((guard) => guard.kind === "callers")).map((row) => helperName(row.fn)),
];

// ─── The proof on the Ogmios clients ─────────────────────────────────────────────────────────────────────────────────────────────

const LUCID_CLIENT = "packages/shared/src/chain/OgmiosLucidProvider.ts";
const READ_ONLY_CLIENT = "packages/shared/src/chain/ReadOnlyOgmiosProvider.ts";
const LIVE_CLIENT = "packages/shared/src/chain/LiveOgmiosProvider.ts";
const DATUM_GUARD = "packages/shared/src/chain/datumGuard.ts";

/** The object literals that a function returns. */
function returnedObjects(fn: FunctionLike): ts.ObjectLiteralExpression[] {
  const objects: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const value = unwrap(node.expression);
      if (ts.isObjectLiteralExpression(value)) objects.push(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return objects;
}

/** The value of a property of an object literal. A shorthand property gives its name. */
function propertyValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
  }
  return undefined;
}

/** True when `value` holds a call of `callText`, or is a name that a declaration in `fn` gives from such a call. */
function derivesFromCall(value: ts.Expression | undefined, callText: string, fn: FunctionLike): boolean {
  if (value === undefined) return false;
  const hasCall = (node: ts.Node): boolean => callsWithin(node).some((call) => squash(call.expression) === callText);
  return hasCall(value) || (ts.isIdentifier(value) && declaredInitializers(value, fn).some(hasCall));
}

/** The methods of a class by name. */
function methodsOf(file: ts.SourceFile, className: string): ts.MethodDeclaration[] {
  const methods: ts.MethodDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) if (ts.isMethodDeclaration(member)) methods.push(member);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return methods;
}

/**
 * The problems of a function that maps the answer of Ogmios: every call of `mapper` in the file is in `answer`, and passes a guard that
 * `answer` makes with `new WithheldOutputs()` before the call.
 */
function mapperProblems(file: ts.SourceFile, answerLabel: string, mapperName: string): string[] {
  const answer = functionNamed(file, answerLabel);
  const calls = callsWithin(file).filter((call) => squash(call.expression) === mapperName);
  const problems: string[] = [];
  if (calls.length === 0) problems.push(`${answerLabel} does not call ${mapperName}`);
  for (const call of calls) {
    if (namedScope(call) !== answer) problems.push(`line ${lineOf(call)}: ${mapperName} is called outside ${answerLabel}`);
    const guard = call.arguments[1];
    const made = guard !== undefined && ts.isIdentifier(guard) ? declaredInitializers(guard, answer) : [];
    const early = made.some((value) => ts.isNewExpression(value) && squash(value.expression) === "WithheldOutputs" && value.getEnd() <= call.getStart());
    if (!early) problems.push(`line ${lineOf(call)}: the guard of ${mapperName} is not a WithheldOutputs that ${answerLabel} makes before the call`);
  }
  return problems;
}

/** The methods of a class that return outputs (their type holds `typeName`) and neither use `answerName` nor ask the node. */
function unmappedMethods(file: ts.SourceFile, className: string, typeName: string, answerName: string): string[] {
  return methodsOf(file, className)
    .filter((method) => (method.type?.getText() ?? "").includes(typeName))
    .filter((method) => {
      const calls = callsWithin(method).map((call) => squash(call.expression));
      return !calls.includes(answerName) && calls.some((text) => text.startsWith("this.rpc"));
    })
    .map((method) => method.name.getText());
}

/** The fields of an output that assertOutputFields bounds, as members of the output: `o.transaction.id`, `o.address`, `o.value`. */
const BOUNDED_FIELDS = ["transaction", "address", "value"];

/**
 * The problems of a mapper of an Ogmios output (its first parameter): its first statement is a call of assertOutputFields on that
 * output, and no read of the transaction, the address or the value of the output starts before that call ends.
 */
function fieldCheckProblems(mapper: FunctionLike): string[] {
  const output = mapper.parameters[0]?.name;
  const body = mapper.body;
  if (output === undefined || !ts.isIdentifier(output) || body === undefined || !ts.isBlock(body)) return ["the mapper has no output parameter or no body"];
  const check = callsWithin(body).find((call) => squash(call.expression) === "assertOutputFields");
  if (check === undefined) return ["the mapper does not call assertOutputFields"];
  const problems: string[] = [];
  const first = body.statements[0];
  if (first === undefined || !ts.isExpressionStatement(first) || first.expression !== check) problems.push("the first statement is not the call of assertOutputFields");
  const argument = check.arguments[0];
  if (argument === undefined || !ts.isIdentifier(argument) || argument.text !== output.text) problems.push(`assertOutputFields does not take ${output.text}`);
  const visit = (node: ts.Node): void => {
    const reads = ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === output.text && BOUNDED_FIELDS.includes(node.name.text);
    if (reads && node.getStart() < check.getEnd()) problems.push(`line ${lineOf(node)}: ${squash(node)} is read before the check`);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return problems;
}

// ─── The tests ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The decoder calls of a piece of code. */
const calleesIn = (code: string, fileName = "snippet.ts"): string[] => findDecoderCalls(parseText(fileName, code)).map((call) => call.callee);

/** The first decoder call of a piece of code, as if the code were in a file of the repository. */
function firstCallIn(code: string, fileName = "packages/shared/src/snippet.ts"): DecoderCall {
  const calls = findDecoderCalls(parseText(join(ROOT, fileName), code));
  if (calls.length === 0) throw new Error("the snippet has no decoder call");
  return calls[0]!;
}

/** The first call of a name in a piece of code. */
function firstCallOf(code: string, name: string): ts.CallExpression {
  const call = callsWithin(parseText("snippet.ts", code)).find((candidate) => calleeName(candidate.expression) === name);
  if (call === undefined) throw new Error(`no call of ${name}`);
  return call;
}

const SCAN = scanSources(sourceFiles(ROOT), trackedNamesOf(SITES));

describe("the detector", () => {
  const SHAPES: Array<[shape: string, code: string, callees: string[]]> = [
    ["a destructured name", "const { from_cbor_hex } = CML.Transaction;\nfrom_cbor_hex(hex);", ["from_cbor_hex"]],
    ["a destructured name with a new name", "const { from_cbor_hex: decode } = CML.Transaction;\ndecode(hex);", ["from_cbor_hex"]],
    ["a name in a nested destructuring", "const { Transaction: { from_hex: read } } = CML;\nread(hex);", ["from_hex"]],
    ["a call over two lines", "CML.Transaction\n  .from_cbor_hex(\n    hex,\n  );", ["from_cbor_hex"]],
    ["pay and ToAddress on two lines", "tx.pay\n  .ToAddress(address, assets);", ["ToAddress"]],
    ["pay and ToAddressWithData on separate lines", "lucid\n  .newTx()\n  .pay\n  .ToAddressWithData(address, datum, assets);", ["ToAddressWithData"]],
    ["an element access with a string", 'CML.Transaction["from_cbor_hex"](hex);', ["from_cbor_hex"]],
    ["an element access with a template", "CML.Transaction[`from_cbor_hex`](hex);", ["from_cbor_hex"]],
    ["complete of a builder", "const signed = await builder.complete();", ["complete"]],
    ["complete with options", "await txBuilder.complete({ presetWalletInputs, localUPLCEval: false });", ["complete"]],
    ["addSignerKey", "builder.addSignerKey(keyHash);", ["addSignerKey"]],
    ["paymentCredentialOf", "const credential = paymentCredentialOf(address);", ["paymentCredentialOf"]],
    ["from_json", "const metadata = CML.TransactionMetadatum.from_json(text);", ["from_json"]],
    ["an aliased import", 'import { getAddressDetails as details } from "@lucid-evolution/lucid";\ndetails(address);', ["getAddressDetails"]],
    ["an aliased variable", "const decode = CML.Address.from_bech32;\ndecode(text);", ["from_bech32", "from_bech32"]],
    ["getUtxos of the wallet", "const utxos = await lucid.wallet().getUtxos();", ["getUtxos"]],
    ["getUtxos of the wallet over several lines", "const utxos = await this.lucid\n  .wallet()\n  .getUtxos();", ["getUtxos"]],
    ["utxosByOutRef", "const [output] = await lucid.utxosByOutRef([reference]);", ["utxosByOutRef"]],
    ["utxosAt", "const outputs = await lucid.utxosAt(address);", ["utxosAt"]],
    ["fromTx", "const builder = lucid.fromTx(cbor);", ["fromTx"]],
    ["attach.SpendingValidator", "lucid.newTx().attach.SpendingValidator(script);", ["SpendingValidator"]],
    ["another method of attach", "lucid.newTx().attach.Script(script);", ["Script"]],
    ["attachMetadata", "lucid.newTx().attachMetadata(674, metadata);", ["attachMetadata"]],
    ["apply_params_to_script", "const applied = apply_params_to_script(parameters, script);", ["apply_params_to_script"]],
    ["validatorToScriptHash", "const hash = validatorToScriptHash(script);", ["validatorToScriptHash"]],
    ["a method of selectWallet", "lucid.selectWallet.fromPrivateKey(key);", ["fromPrivateKey"]],
    ["Data.from", "const value = Data.from(hex);", ["Data.from"]],
    ["a decoder that a call hands on", "const texts = hexes.map(CML.Transaction.from_cbor_hex);", ["from_cbor_hex"]],
    ["a decoder that `call` applies", "CML.Address.from_bech32.call(CML.Address, text);", ["from_bech32"]],
    ["a decoder with an optional call", "CML?.Transaction?.from_cbor_hex?.(hex);", ["from_cbor_hex"]],
    ["a call of a comma expression", "(0, CML.Transaction.from_cbor_hex)(hex);", ["from_cbor_hex"]],
    ["a key that is not a string, on the library", "CML.Transaction[method](hex);", ["<computed>"]],
    ["a call in a callback", "items.map((item) => CML.Transaction.from_cbor_hex(item.hex));", ["from_cbor_hex"]],
    ["an import call beside a decoder call", "const module = await import('x');\nconst bytes = CML.Transaction.from_bytes(raw);", ["from_bytes"]],
  ];

  it.each(SHAPES)("sees %s", (_shape, code, callees) => {
    expect(calleesIn(code)).toEqual(callees);
  });

  it("reads each kind of file", () => {
    expect(calleesIn("const view = <b>{CML.Transaction.from_hex(hex)}</b>;", "snippet.tsx")).toEqual(["from_hex"]);
    expect(calleesIn("export const read = (hex) => CML.Transaction.from_hex(hex);", "snippet.mjs")).toEqual(["from_hex"]);
    expect(calleesIn("module.exports = (hex) => CML.Transaction.from_hex(hex);", "snippet.cjs")).toEqual(["from_hex"]);
    expect(calleesIn("export const read = (hex: string) => CML.Transaction.from_hex(hex);", "snippet.mts")).toEqual(["from_hex"]);
  });

  it("does not see a call that is not a decoder call", () => {
    for (const code of [
      "const copy = Array.from(items);", "const bytes = Buffer.from(hex, 'hex');", "const pairs = Object.fromEntries(entries);",
      "const from = 1;", "const done = new Map<string, number>();", "const utxos = store.getUtxos();",
      "const text = utxos.map((u) => u.address).join(',');", "const hash = blake2b(bytes);",
    ]) expect(calleesIn(code), code).toEqual([]);
  });

  it("does not see a name in a comment or in a string", () => {
    expect(calleesIn("// CML.Transaction.from_cbor_hex(hex)\n/* tx.pay.ToAddress(a, v) */\nconst note = 'builder.complete()';")).toEqual([]);
  });

  it("parses a file when it has a name of the detector, and only then", () => {
    const pattern = detectionPattern(["helper"]);
    for (const [, code] of SHAPES) expect(pattern.test(code), code).toBe(true);
    expect(pattern.test("helper(value);")).toBe(true);
    expect(pattern.test("const copy = Array.from(items);\nfoo(bar);")).toBe(false);
    expect(pattern.test("const payload = attachment + Database + incomplete;")).toBe(false);
  });

  it("excludes a call by its file and its receiver, and never a call through the library", () => {
    expect(exclusionOf(firstCallIn("deps.jobs.complete(id, payload);", "supplier/src/jobRunner.ts"))).toBe(JOB_STORE_COMPLETE);
    expect(exclusionOf(firstCallIn("await completed.sign.withWallet().complete();"))).toBe(SIGN_COMPLETE);
    expect(exclusionOf(firstCallIn("await completed\n  .sign.withPrivateKey(key)\n  .complete();"))).toBe(SIGN_COMPLETE);
    expect(exclusionOf(firstCallIn("await chain.utxosAt(address);", "contracts/identity-marketplace/deploy/commands.ts"))).toBe(DEPLOY_CHAIN_UTXOS_AT);
    // Another file, another receiver, and a chain through `lucid`: counted.
    expect(exclusionOf(firstCallIn("deps.jobs.complete(id, payload);", "supplier/src/other.ts"))).toBeUndefined();
    expect(exclusionOf(firstCallIn("store.complete(id, payload);", "supplier/src/jobRunner.ts"))).toBeUndefined();
    expect(exclusionOf(firstCallIn("await chain.utxosAt(address);"))).toBeUndefined();
    expect(exclusionOf(firstCallIn("await completed.complete();"))).toBeUndefined();
    expect(exclusionOf(firstCallIn("await lucid.fromTx(cbor).sign.withWallet().complete();"))).toBeUndefined();
    expect(exclusionOf(firstCallIn("await lucid.newTx().complete();", "supplier/src/jobRunner.ts"))).toBeUndefined();
  });
});

describe("the source files", () => {
  const folders: string[] = [];
  afterAll(() => {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  });

  it("takes each type of source file and leaves out tests, modules and output", () => {
    const folder = mkdtempSync(join(tmpdir(), "decoder-sites-"));
    folders.push(folder);
    const source = [
      "scripts/j.ts", "src/a.ts", "src/b.tsx", "src/c.mts", "src/d.cts", "src/e.js", "src/f.jsx", "src/g.mjs", "src/h.cjs", "src/ui/i.tsx",
    ];
    const other = [
      "src/a.test.ts", "src/b.spec.mts", "src/c.test.tsx", "src/test/k.ts", "src/tests/l.ts", "src/__tests__/m.ts", "test/n.ts",
      "node_modules/pkg/index.js", "src/node_modules/pkg/index.js", "dist/o.js", "src/notes.md", "src/style.css",
    ];
    for (const file of [...source, ...other]) {
      mkdirSync(dirname(join(folder, file)), { recursive: true });
      writeFileSync(join(folder, file), "export {};\n");
    }
    expect(sourceFiles(folder).map((path) => relative(folder, path).split(sep).join("/"))).toEqual([...source].sort());
  });

  it.each(SOURCE_DIRS)("scans the files of %s", (folder) => {
    expect(SCAN.files.filter((file) => file.startsWith(`${folder}/`)).length).toBeGreaterThan(0);
  });

  it("scans the user interface and the scripts of the buyer", () => {
    expect(SCAN.files).toContain("buyer/src/ui/App.tsx");
    expect(SCAN.files).toContain("buyer/scripts/run-agent-a.ts");
  });

  it("scans no test file, no module and no output", () => {
    expect(SCAN.files.filter((file) => /(?:^|\/)(?:node_modules|dist|tests?)\//.test(file) || TEST_FILE.test(file))).toEqual([]);
  });
});

describe("the decoder sites", () => {
  it("names each call of the decoder library, function by function", () => {
    const hint = "Add each call to SITES with its reason. Add it to EXCLUDED instead when the name is not a call of the decoder library.";
    expect(compareSites(SCAN.sites, SITES), hint).toEqual([]);
  });

  it("names a function once", () => {
    const keys = SITES.map(rowKey);
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  });

  it("names a file that the scan reads", () => {
    for (const row of SITES) expect(SCAN.files, rowKey(row)).toContain(row.file);
  });

  it("gives a reason for each call, and no call is unchecked", () => {
    for (const row of SITES) expect(row.reason.length, rowKey(row)).toBeGreaterThan(40);
    expect(SITES.filter((row) => row.reason.startsWith("UNCHECKED")).map(rowKey)).toEqual([]);
  });

  it("proves each check that a reason names", () => {
    for (const row of SITES) {
      for (const name of CHECK_NAMES.filter((check) => row.reason.includes(check))) {
        const proved = row.guards.some((guard) => (guard.kind === "before" || guard.kind === "callers") && guard.call === name);
        expect(proved, `${rowKey(row)} names ${name} and has no proof of it`).toBe(true);
      }
    }
  });

  it("runs each check before the call that it guards", () => {
    const problems: string[] = [];
    for (const call of SCAN.sites) {
      const row = SITES.find((candidate) => rowKey(candidate) === keyOf(call.file, call.fn, call.callee));
      for (const guard of row?.guards ?? []) {
        const problem = guardProblem(call, guard, SCAN.tracked);
        if (problem !== undefined) problems.push(`${call.file}:${call.line} ${call.fn} ${call.callee}: ${problem}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("makes the Lucid context of each builder on the checking client", () => {
    const context = functionNamed(parse(join(ROOT, LUCID_CONTEXT)), "createLucidContext");
    expect(context.parameters[0]?.type?.getText()).toBe("OgmiosLucidProvider");
    const contexts = SCAN.tracked.get("createLucidContext") ?? [];
    expect(contexts.length).toBeGreaterThan(0);
    for (const { file, node } of contexts) {
      const provider = node.arguments[0];
      const made = provider !== undefined && ts.isIdentifier(provider) ? declaredInitializers(provider, namedScope(node) ?? node.getSourceFile()) : [];
      const onClient = made.map(unwrap).some((value) =>
        (ts.isNewExpression(value) && squash(value.expression) === "OgmiosLucidProvider") ||
        (ts.isCallExpression(value) && squash(value.expression) === "buildLucidProvider"));
      expect(onClient, `${file}:${lineOf(node)} makes its context on another provider`).toBe(true);
    }
    const provider = functionNamed(parse(join(ROOT, LIVE_CBOR)), "buildLucidProvider");
    const returned: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression !== undefined) returned.push(unwrap(node.expression));
      ts.forEachChild(node, visit);
    };
    visit(provider);
    expect(returned.some((value) => ts.isNewExpression(value) && squash(value.expression) === "OgmiosLucidProvider")).toBe(true);
  });
});

describe("the guard of the table", () => {
  it("fails on a new call in a file that the table does not name", () => {
    const found = [...expandTable(SITES), { file: "gateway/src/new.ts", fn: "decode", callee: "from_cbor_hex", line: 7 }];
    expect(compareSites(found, SITES)).toEqual(["gateway/src/new.ts :: decode :: from_cbor_hex (line 7): this file is not in the table"]);
  });

  it("fails on a new call in a function that a named file does not name", () => {
    const found = [...expandTable(SITES), { file: LIVE_CBOR, fn: "newBuilder", callee: "complete", line: 9 }];
    expect(compareSites(found, SITES)).toEqual([`${LIVE_CBOR} :: newBuilder :: complete (line 9): this function is not in the table`]);
  });

  it("fails on one more call in a function that the table names", () => {
    const row = SITES[3]!;
    const found = [...expandTable(SITES), { file: row.file, fn: row.fn, callee: row.callee, line: 99 }];
    const lines = [...Array.from({ length: row.count }, (_unused, index) => index + 1), 99].join(", ");
    expect(compareSites(found, SITES)).toEqual([`${rowKey(row)} (line ${lines}): the table says ${row.count}, the tree has ${row.count + 1}`]);
  });

  it("fails when a call of the table is gone", () => {
    const row = SITES[0]!;
    const found = expandTable(SITES).filter((call) => keyOf(call.file, call.fn, call.callee) !== rowKey(row));
    expect(compareSites(found, SITES)).toEqual([`${rowKey(row)}: the table names a call that the tree does not have`]);
  });

  it("passes when the tree and the table agree", () => {
    expect(compareSites(expandTable(SITES), SITES)).toEqual([]);
  });

  describe("the proof of an order", () => {
    const CHECK = before("checkedAddressText", 0);
    const ORDER: Array<[title: string, code: string, guard: Guard, holds: boolean]> = [
      ["a check that runs first in the same function", "function f(a) {\n  const x = checkedAddressText(a, 'n');\n  tx.pay.ToAddress(x, v);\n}", CHECK, true],
      ["a check of the same text", "function f(o) {\n  checkedAddressText(o.address, 'n');\n  tx.pay.ToAddress(o.address, v);\n}", CHECK, true],
      ["a check inside the arguments", "function f(a) {\n  tx.pay.ToAddress(checkedAddressText(a, 'n'), v);\n}", CHECK, true],
      ["a check before the callback of the call", "function f(a, l) {\n  checkedAddressText(a, 'n');\n  l.map((u) => tx.pay.ToAddress(a, u));\n}", CHECK, true],
      ["a check in a loop before the call", "function f(os) {\n  for (const o of os) checkedAddressText(o.a, 'n');\n  for (const o of os) tx.pay.ToAddress(o.a, v);\n}", CHECK, true],
      ["a check that runs after the call", "function f(a) {\n  tx.pay.ToAddress(a, v);\n  checkedAddressText(a, 'n');\n}", before("checkedAddressText"), false],
      ["a check in another function", "function c(a) {\n  checkedAddressText(a, 'n');\n}\nfunction f(a) {\n  tx.pay.ToAddress(a, v);\n}", before("checkedAddressText"), false],
      ["a check in a callback beside the call", "function f(a, l) {\n  l.forEach((u) => checkedAddressText(u, 'n'));\n  l.map((u) => tx.pay.ToAddress(u, v));\n}", before("checkedAddressText"), false],
      ["a check in a function inside the function", "function f(a) {\n  const c = () => checkedAddressText(a, 'n');\n  tx.pay.ToAddress(a, v);\n}", before("checkedAddressText"), false],
      ["a check of another text", "function f(a, b) {\n  checkedAddressText(a, 'n');\n  tx.pay.ToAddress(b, v);\n}", CHECK, false],
      ["a name that another call gives", "function f(a, b) {\n  const x = checkedAddressText(a, 'n');\n  const y = other(b);\n  tx.pay.ToAddress(y, v);\n}", CHECK, false],
      ["a constant text", "const KNOWN = 'd87980';\nfunction f() {\n  CML.PlutusData.from_cbor_hex(KNOWN);\n}", CONSTANT, true],
      ["a text that is not constant", "function f(hex) {\n  CML.PlutusData.from_cbor_hex(hex);\n}", CONSTANT, false],
      ["a text of a variable that changes", "let KNOWN = 'd87980';\nfunction f() {\n  CML.PlutusData.from_cbor_hex(KNOWN);\n}", CONSTANT, false],
      ["a key hash of a key", "function f(k) {\n  builder.addSignerKey(k.pubKeyHash);\n}", KEY_HASH_OF_KEY, true],
      ["a key hash from a request", "function f(r) {\n  builder.addSignerKey(r.keyHash);\n}", KEY_HASH_OF_KEY, false],
    ];

    it.each(ORDER)("%s", (_title, code, guard, holds) => {
      expect(guardProblem(firstCallIn(code), guard, new Map()) === undefined).toBe(holds);
    });

    const HELPER = "function helper(a) {\n  CML.Address.from_bech32(a);\n}";

    it("accepts a helper that each caller calls after its check", () => {
      const calls = new Map([["helper", [{ file: "x.ts", node: firstCallOf("function f(a) {\n  check(a);\n  helper(a);\n}", "helper") }]]]);
      expect(guardProblem(firstCallIn(HELPER), afterCheckOfCallers("check"), calls)).toBeUndefined();
    });

    it("fails on a helper that a caller calls before its check", () => {
      const calls = new Map([["helper", [{ file: "x.ts", node: firstCallOf("function f(a) {\n  helper(a);\n  check(a);\n}", "helper") }]]]);
      expect(guardProblem(firstCallIn(HELPER), afterCheckOfCallers("check"), calls)).toContain("calls helper with no call of check before it");
    });

    it("fails on a helper that nothing calls", () => {
      expect(guardProblem(firstCallIn(HELPER), afterCheckOfCallers("check"), new Map())).toBe("nothing calls helper");
    });
  });
});

describe("the excluded calls", () => {
  it("excludes only calls that the tree has", () => {
    for (const exclusion of EXCLUDED) expect(SCAN.excluded.some((hit) => hit.exclusion === exclusion), exclusion.reason).toBe(true);
  });

  it("excludes no call through the decoder library", () => {
    for (const { call } of SCAN.excluded) expect(call.receiver !== undefined && throughLibrary(call.receiver), `${call.file}:${call.line}`).toBe(false);
  });

  it("takes complete of the sign builder from the types of Lucid", () => {
    const lucid = createRequire(join(ROOT, "packages/shared/package.json")).resolve("@lucid-evolution/lucid");
    const declarations = parse(join(dirname(lucid), "index.d.ts"));
    const membersOf = (name: string): readonly ts.TypeElement[] => {
      for (const statement of declarations.statements) {
        if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) return statement.members;
        if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name && ts.isTypeLiteralNode(statement.type)) return statement.type.members;
      }
      throw new Error(`no declaration ${name}`);
    };
    const typeOf = (members: readonly ts.TypeElement[], member: string): ts.TypeNode | undefined =>
      members.find((candidate): candidate is ts.PropertySignature => ts.isPropertySignature(candidate) && candidate.name.getText() === member)?.type;
    const describeFunction = (type: ts.TypeNode | undefined): string =>
      type !== undefined && ts.isFunctionTypeNode(type) ? `(${type.parameters.length}) => ${type.type.getText()}` : "not a function";

    const signBuilder = membersOf("TxSignBuilder");
    expect(describeFunction(typeOf(signBuilder, "complete"))).toBe("(0) => Promise<TxSigned>");
    const sign = typeOf(signBuilder, "sign");
    const signMembers = sign !== undefined && ts.isTypeLiteralNode(sign) ? sign.members : [];
    expect(describeFunction(typeOf(signMembers, "withWallet"))).toBe("(0) => TxSignBuilder");
    expect(describeFunction(typeOf(signMembers, "withPrivateKey"))).toBe("(1) => TxSignBuilder");
    expect(describeFunction(typeOf(membersOf("TxBuilder"), "complete"))).toBe("(1) => Promise<TxSignBuilder>");
  });

  it("excludes by file only files that import no library", () => {
    const holders = new Set(SCAN.excluded.filter((hit) => hit.exclusion !== SIGN_COMPLETE).map((hit) => hit.call.file));
    expect(holders.size).toBeGreaterThan(0);
    for (const path of [...holders, "supplier/src/jobs.ts", "contracts/identity-marketplace/deploy/chain.ts"]) {
      const modules: string[] = [];
      const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
          modules.push(node.moduleSpecifier.text);
        }
        const first = ts.isCallExpression(node) ? node.arguments[0] : undefined;
        if (ts.isCallExpression(node) && first !== undefined && ts.isStringLiteralLike(first) && (squash(node.expression) === "require" || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
          modules.push(first.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(parse(join(ROOT, path)));
      expect(modules.filter((name) => LIBRARY_MODULE.test(name)), path).toEqual([]);
    }
  });

  it("reads the job store and the deploy chain as the reasons say", () => {
    const store = methodsOf(parse(join(ROOT, "supplier/src/jobs.ts")), "JobStore").find((method) => method.name.getText() === "complete");
    expect(store?.type?.getText()).toBe("void");
    const types: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isPropertySignature(node) && node.name.getText() === "jobs" && node.type !== undefined) types.push(node.type.getText());
      ts.forEachChild(node, visit);
    };
    visit(parse(join(ROOT, "supplier/src/jobRunner.ts")));
    expect(types).toContain("JobStore");
    expect(methodsOf(parse(join(ROOT, "contracts/identity-marketplace/deploy/chain.ts")), "OgmiosChain").some((method) => method.name.getText() === "utxosAt")).toBe(true);
  });
});

describe("the Ogmios clients", () => {
  const lucidClient = parse(join(ROOT, LUCID_CLIENT));
  const readOnlyClient = parse(join(ROOT, READ_ONLY_CLIENT));

  it("checks the datum before the Lucid client returns an output", () => {
    const mapper = functionNamed(lucidClient, "ogmiosUtxoToLucidUtxo");
    const objects = returnedObjects(mapper);
    expect(objects.length).toBeGreaterThan(0);
    for (const object of objects) {
      expect(derivesFromCall(propertyValue(object, "datum"), "withheld.datum", mapper), "the datum comes from withheld.datum").toBe(true);
      expect(derivesFromCall(propertyValue(object, "scriptRef"), "ogmiosScriptToLucidScript", mapper), "the script comes from its mapper").toBe(true);
    }
  });

  it("leaves out of the answer the output with a native script that fails the check", () => {
    const mapper = functionNamed(lucidClient, "ogmiosUtxoToLucidUtxo");
    const returnsNull: string[] = [];
    const visitMapper = (node: ts.Node): void => {
      if (ts.isIfStatement(node)) returnsNull.push(squash(node));
      ts.forEachChild(node, visitMapper);
    };
    visitMapper(mapper);
    expect(returnsNull).toContain("if(scriptRef===undefined)returnnull;");

    const script = functionNamed(lucidClient, "ogmiosScriptToLucidScript");
    const clauses: ts.CaseClause[] = [];
    const visitScript = (node: ts.Node): void => {
      if (ts.isCaseClause(node)) clauses.push(node);
      ts.forEachChild(node, visitScript);
    };
    visitScript(script);
    const native = clauses.find((clause) => ts.isStringLiteral(clause.expression) && clause.expression.text === "native");
    const decision = native?.statements.flatMap((statement) =>
      ts.isReturnStatement(statement) && statement.expression !== undefined && ts.isConditionalExpression(statement.expression) ? [statement.expression] : [])[0];
    expect(decision !== undefined ? squash(decision.condition) : "").toMatch(/^withheld\.nativeScriptReadable\(/);
    expect(decision !== undefined ? squash(decision.whenFalse) : "").toBe("undefined");
    // A Plutus script is opaque bytes: the native case is the only one that calls the check.
    expect(callsWithin(script).map((call) => squash(call.expression)).filter((text) => text.startsWith("withheld."))).toEqual(["withheld.nativeScriptReadable"]);
  });

  it("makes the guard of an answer before the Lucid client maps an output", () => {
    expect(mapperProblems(lucidClient, "ogmiosAnswerToLucidUtxos", "ogmiosUtxoToLucidUtxo")).toEqual([]);
    expect(unmappedMethods(lucidClient, "OgmiosLucidProvider", "UTxO", "ogmiosAnswerToLucidUtxos")).toEqual([]);
  });

  it("checks the datum before the read-only client returns an output", () => {
    const mapper = functionNamed(readOnlyClient, "ogmiosUtxoToUtxo");
    const objects = returnedObjects(mapper);
    expect(objects.length).toBeGreaterThan(0);
    for (const object of objects) expect(derivesFromCall(propertyValue(object, "datumHex"), "withheld.datum", mapper), "the datum comes from withheld.datum").toBe(true);
  });

  it("maps no native script in the read-only client", () => {
    const script = functionNamed(readOnlyClient, "ogmiosScriptRef");
    const languages: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && (node.text.startsWith("plutus:") || node.text === "native")) languages.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(script);
    expect(languages).toEqual(["plutus:v3"]);
  });

  it("makes the guard of an answer before the read-only client maps an output", () => {
    expect(mapperProblems(readOnlyClient, "ogmiosAnswerToUtxos", "ogmiosUtxoToUtxo")).toEqual([]);
    expect(unmappedMethods(readOnlyClient, "ReadOnlyOgmiosProvider", "Utxo", "ogmiosAnswerToUtxos")).toEqual([]);
  });

  it("reads outputs through the read-only client in the live client", () => {
    const outputs = methodsOf(parse(join(ROOT, LIVE_CLIENT)), "LiveOgmiosProvider").filter((method) => (method.type?.getText() ?? "").includes("Utxo"));
    expect(outputs.length).toBeGreaterThan(0);
    for (const method of outputs) {
      expect(callsWithin(method).some((call) => squash(call.expression).startsWith("this.read.")), method.name.getText()).toBe(true);
    }
  });

  it("bounds the fields of an output before the Lucid client reads it", () => {
    expect(fieldCheckProblems(functionNamed(lucidClient, "ogmiosUtxoToLucidUtxo"))).toEqual([]);
  });

  it("bounds the fields of an output before the read-only client reads it", () => {
    expect(fieldCheckProblems(functionNamed(readOnlyClient, "ogmiosUtxoToUtxo"))).toEqual([]);
  });

  it("refuses a long transaction id, address, policy id and asset name in assertOutputFields", () => {
    const guard = functionNamed(parse(join(ROOT, DATUM_GUARD)), "assertOutputFields");
    const fields: string[] = [];
    const visit = (node: ts.Node): void => {
      const first = ts.isNewExpression(node) ? node.arguments?.[0] : undefined;
      if (ts.isNewExpression(node) && squash(node.expression) === "OutputFieldError" && first !== undefined && ts.isStringLiteralLike(first)) fields.push(first.text);
      ts.forEachChild(node, visit);
    };
    visit(guard);
    expect(fields.sort()).toEqual(["address", "asset name", "policy id", "transaction id"]);
  });

  const MAPPER_CASES: Array<[title: string, code: string, problems: number]> = [
    ["a guard that the answer function makes first", "function answer(r) {\n  const withheld = new WithheldOutputs();\n  return r.map((o) => mapper(o, withheld));\n}", 0],
    ["a mapper call with no guard", "function answer(r) {\n  return r.map((o) => mapper(o, withheld));\n}", 1],
    ["a guard that another call makes", "function answer(r) {\n  const withheld = other();\n  return r.map((o) => mapper(o, withheld));\n}", 1],
    ["a guard that the function makes after the call", "function answer(r) {\n  const out = r.map((o) => mapper(o, withheld));\n  const withheld = new WithheldOutputs();\n  return out;\n}", 1],
    ["a mapper call in another function", "function answer(r) {\n  const withheld = new WithheldOutputs();\n  return r.map((o) => mapper(o, withheld));\n}\nfunction other(o) {\n  return mapper(o, null);\n}", 2],
    ["an answer function that does not call the mapper", "function answer(r) {\n  return r;\n}", 1],
  ];

  it.each(MAPPER_CASES)("judges %s", (_title, code, problems) => {
    expect(mapperProblems(parseText("client.ts", code), "answer", "mapper")).toHaveLength(problems);
  });

  const FIELD_CASES: Array<[title: string, code: string, problems: number]> = [
    ["the check as the first statement", "function map(o) {\n  assertOutputFields(o);\n  const ref = `${o.transaction.id}#${o.index}`;\n  return [ref, o.address, o.value];\n}", 0],
    ["the check after the line that makes the reference", "function map(o) {\n  const ref = `${o.transaction.id}#${o.index}`;\n  assertOutputFields(o);\n  return ref;\n}", 2],
    ["no check", "function map(o) {\n  const ref = `${o.transaction.id}#${o.index}`;\n  return ref;\n}", 1],
    ["the check after a read of the address", "function map(o) {\n  const a = o.address;\n  assertOutputFields(o);\n  return a;\n}", 2],
    ["the check after a read of the value", "function map(o) {\n  const v = o.value;\n  assertOutputFields(o);\n  return v;\n}", 2],
    ["a check of another value", "function map(o, p) {\n  assertOutputFields(p);\n  return o.address;\n}", 1],
    ["a check in a condition", "function map(o, c) {\n  if (c) assertOutputFields(o);\n  return o.address;\n}", 1],
  ];

  it.each(FIELD_CASES)("judges the field check: %s", (_title, code, problems) => {
    expect(fieldCheckProblems(functionNamed(parseText("client.ts", code), "map"))).toHaveLength(problems);
  });
});
