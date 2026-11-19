/**
 * decoder-sites.test.ts — the places where the code calls the decoder library on data from outside are named.
 *
 * The test reads the syntax tree of each source file of the repository. The files come from `git ls-files`: a file that git does not
 * track is not read, and a new file counts after `git add`. Tests, `node_modules` and `dist` are not source. It finds each call that
 * gives data to the decoder library:
 *
 * - a decoder of the library: `CML.*.from_cbor_hex`, `from_bech32`, `from_hex`, and the others in DECODER_NAMES;
 * - a free function of the library: any call on `CML` itself, as `CML.hash_transaction(body)`, `CML.min_fee(...)` or
 *   `CML.encode_json_str_to_plutus_datum(...)`. A test reads the declarations of the library and checks each function that they export;
 * - a call of Lucid that decodes inside Lucid: `pay.ToAddress`, `collectFrom`, `readFrom`, `attach.*`, `addSignerKey`, `attachMetadata`,
 *   `complete`, `utxosAt`, `utxosByOutRef`, `fromTx`, `selectWallet.*`, and `getUtxos` of the wallet;
 * - a function of Lucid or of its UPLC package that reads a text: `getAddressDetails`, `validatorToScriptHash`, `apply_params_to_script`.
 *
 * Line breaks do not matter. A name that a destructuring, a variable or an import alias gives counts as the name of the library. The
 * same holds for `CML` itself and its free functions: `import * as X from "@dcspark/cardano-multiplatform-lib-nodejs"`, `const X = CML`,
 * `const { min_fee } = CML`, `import { min_fee } from "@dcspark/cardano-multiplatform-lib-nodejs"`, and a parameter with `CML` as its
 * default. The scan follows a name inside one file, not from one file to another. A decoder that a call hands on
 * (`items.map(CML.Address.from_bech32)`) counts too.
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
 * these calls with a reason. A call through `CML` (or a name for it) or `lucid` is never excluded.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

// ─── The source files ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The folders that the scan must cover. The scan reads each file that git tracks, so a new folder is covered too. */
const SOURCE_DIRS = [
  "packages/shared/src", "gateway/src", "buyer/src", "buyer/src/ui", "buyer/scripts", "supplier/src", "paper2agent/src",
  "wallet-monitor/src", "indexer/src", "indexer-ui/src", "identity-gateway/src", "contracts/identity-marketplace/deploy",
  "contracts/identity-marketplace/bench",
];

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec)\.[^./]+$/;
/** A folder with one of these names holds modules or output. It is not source, at any depth. */
const NOT_SOURCE_FOLDERS = ["node_modules", "dist", "coverage", ".git", ".vitest-cache"];
/** A folder with one of these names holds tests in the places that `inTestFolder` names. */
const TEST_FOLDERS = ["test", "tests"];

/**
 * True when the folders of a path hold tests. The repository keeps its tests in `tests/` at the root, in `test/` or `tests/` of a
 * package, and in `__tests__` at any depth. The folders `gateway/test`, `identity-gateway/test` and `paper2agent/test` exist today. A
 * package under `packages/` has them one level deeper (`packages/<name>/test`). A folder with one of these names under `src` holds
 * source: `gateway/src/test/helper.ts` is a source file. The `tests` folders of the Aiken project in `contracts/` hold no script today,
 * so the rule does not name them.
 */
function inTestFolder(folders: readonly string[]): boolean {
  return (
    folders[0] === "tests" || folders.includes("__tests__") || TEST_FOLDERS.includes(folders[1] ?? "") ||
    (folders[0] === "packages" && TEST_FOLDERS.includes(folders[2] ?? ""))
  );
}

/**
 * The source files among `paths`, sorted. A path goes from the repository root, with `/`. A path is a source file when its name has the
 * extension of a script and is not the name of a test, and no folder of it holds modules, output or tests.
 */
function selectSourcePaths(paths: readonly string[]): string[] {
  return paths
    .filter((path) => {
      const parts = path.split("/");
      const name = parts[parts.length - 1]!;
      const folders = parts.slice(0, -1);
      return (
        SOURCE_FILE.test(name) && !TEST_FILE.test(name) && !folders.some((folder) => NOT_SOURCE_FOLDERS.includes(folder)) &&
        !inTestFolder(folders)
      );
    })
    .sort();
}

/**
 * The files that git tracks in `root`, as paths from `root` with `/`. None when git cannot give a list: the folder has no `.git` (a copy
 * of the sources), or git is not installed. The scan then walks the folders. A walk also reads the files that git does not track, so it
 * is the second choice. Any other failure of git is an error, not a reason to walk.
 */
function gitFiles(root: string, command = "git"): string[] | undefined {
  if (!existsSync(join(root, ".git"))) return undefined;
  try {
    const output = execFileSync(command, ["ls-files", "-z"], {
      cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    return [...new Set(output.split("\0").filter((path) => path !== ""))];
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Every file under `directory`, as a path from `directory` with `/`. The walk skips the folders that hold modules or output. */
function walkFiles(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (!entry.isDirectory()) files.push(path);
    else if (!NOT_SOURCE_FOLDERS.includes(entry.name)) files.push(...walkFiles(directory, path));
  }
  return files;
}

/**
 * The source files of the repository at `root`, as absolute paths, sorted. `listed` is the list of the files that git tracks (gitFiles).
 * With none, the files come from a walk. A path that the list names and the work tree no longer has is left out.
 */
function sourceFiles(root: string, listed: readonly string[] | undefined): string[] {
  return selectSourcePaths(listed ?? walkFiles(root)).map((path) => join(root, path)).filter((path) => existsSync(path));
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

/** `CML` is the namespace of the decoder library. It holds its classes (`CML.Transaction`) and its free functions (`CML.hash_transaction`). */
const CML_NAME = "CML";

/** The packages of the decoder library, one for each target: `@dcspark/cardano-multiplatform-lib-nodejs`, `@anastasia-labs/...-browser`. */
const CML_MODULE = /^@(?:dcspark|anastasia-labs)\/cardano-multiplatform-lib(?:-[a-z]+)?(?:\/|$)/;

/** A chain with one of these names goes through the decoder library. A call on it is never excluded. */
const LIBRARY_ROOTS = [CML_NAME, "lucid"];

/** Modules of the decoder library and of Lucid. */
const LIBRARY_MODULE = /^@(?:lucid-evolution|anastasia-labs|dcspark)\//;

/**
 * The words that make a detection possible. A file with none of them cannot hold a decoder call, and the scan does not parse it.
 * `extraWords` are the names of the functions that the guards follow. The name of the package of the decoder library is one of the
 * words: a file that imports the package can give its namespace and its functions names of its own.
 */
function detectionPattern(extraWords: readonly string[]): RegExp {
  const words = [...DECODER_NAMES, ...NAMESPACES, ...LIBRARY_ROOTS, "cardano-multiplatform-lib", ...extraWords, "getUtxos"];
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

/** True when a chain goes through the library: one of its names is `CML` or `lucid`, or a name that `cml` holds. */
const throughLibrary = (receiver: ts.Expression, cml: ReadonlySet<string> = new Set()): boolean =>
  chainNames(receiver).some((name) => LIBRARY_ROOTS.includes(name) || cml.has(name));

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
  /** True when the receiver goes through the library: `CML.Transaction`, `lucid.newTx()`, or a name that the file gives to `CML`. */
  library: boolean;
}

/** The names that a file gives to the decoder library. */
interface LibraryNames {
  /** The names of `CML` itself: `CML`, and each name that an import, a variable or a parameter gives to it. */
  cml: ReadonlySet<string>;
  /** The names that stand for one name of the library: a destructuring, a variable or an import gives them. The key is the name in the file. */
  aliases: ReadonlyMap<string, string>;
}

/**
 * True when `name` is the name of a function of the library and not of a class. The classes and the enums of the library start with a
 * capital letter and its free functions do not. A test reads the declarations of the library to check it.
 */
const isFunctionName = (name: string): boolean => /^[a-z]/.test(name);

/** True when `expression` loads a module that `pattern` matches: `require("m")` or `import("m")`. */
function loadsModule(expression: ts.Expression, pattern: RegExp): boolean {
  const call = unwrap(expression);
  if (!ts.isCallExpression(call)) return false;
  const first = call.arguments[0];
  const loads = call.expression.kind === ts.SyntaxKind.ImportKeyword || squash(call.expression) === "require";
  return loads && first !== undefined && ts.isStringLiteralLike(first) && pattern.test(first.text);
}

/**
 * True when `expression` is `CML` itself: a name for it, a member named `CML` (`lucid.CML`), a load of its package, or a choice between
 * values where one is `CML` (`options.library ?? CML`).
 */
function isCml(expression: ts.Expression, cml: ReadonlySet<string>): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return cml.has(value.text);
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) return memberName(value) === CML_NAME;
  if (ts.isBinaryExpression(value)) {
    const operator = value.operatorToken.kind;
    const isChoice = operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken;
    return isChoice && (isCml(value.left, cml) || isCml(value.right, cml));
  }
  if (ts.isConditionalExpression(value)) return isCml(value.whenTrue, cml) || isCml(value.whenFalse, cml);
  return loadsModule(value, CML_MODULE);
}

/**
 * The name of the function of the library that `expression` is, when the code does not call it where it stands: a name that stands for
 * one, a member with a decoder name, or a member of `CML` itself with the name of a function (`CML.hash_transaction`). Else none.
 */
function functionOf(expression: ts.Expression, names: LibraryNames): string | undefined {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) {
    const alias = names.aliases.get(value.text);
    if (alias === undefined) return DECODER_NAMES.includes(value.text) ? value.text : undefined;
    return DECODER_NAMES.includes(alias) || isFunctionName(alias) ? alias : undefined;
  }
  if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return undefined;
  const member = memberName(value);
  if (member === undefined) return undefined;
  if (DECODER_NAMES.includes(member)) return member;
  return isFunctionName(member) && isCml(value.expression, names.cml) ? member : undefined;
}

/** The names that a file gives to `CML` and to the names of the library: by an import, a destructuring, a variable or a parameter. */
function libraryNames(file: ts.SourceFile): LibraryNames {
  const cml = new Set([CML_NAME]);
  const aliases = new Map<string, string>();
  const names: LibraryNames = { cml, aliases };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // An import of the package of the library gives its namespace, or its functions by name.
      const clause = node.importClause;
      const named = clause?.namedBindings;
      if (clause !== undefined && ts.isStringLiteral(node.moduleSpecifier) && CML_MODULE.test(node.moduleSpecifier.text)) {
        if (clause.name !== undefined) cml.add(clause.name.text);
        if (named !== undefined && ts.isNamespaceImport(named)) cml.add(named.name.text);
        if (named !== undefined && ts.isNamedImports(named)) {
          for (const element of named.elements) aliases.set(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression) && CML_MODULE.test(reference.expression.text)) {
        cml.add(node.name.text);
      }
    } else if (ts.isImportSpecifier(node)) {
      const original = (node.propertyName ?? node.name).text;
      if (original === CML_NAME) cml.add(node.name.text);
      else if (node.propertyName !== undefined && DECODER_NAMES.includes(original)) aliases.set(node.name.text, original);
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const key = node.propertyName ?? node.name;
      const source = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
      // A name in the pattern of a declaration whose value is `CML`: `const { min_fee } = CML`.
      const holder = ts.isObjectBindingPattern(node.parent) ? node.parent.parent : undefined;
      const fromCml =
        holder !== undefined && (ts.isVariableDeclaration(holder) || ts.isParameter(holder)) && holder.initializer !== undefined &&
        isCml(holder.initializer, cml);
      if (node.dotDotDotToken !== undefined) {
        if (fromCml) cml.add(node.name.text);
      } else if (source === CML_NAME) {
        cml.add(node.name.text);
      } else if (source !== undefined && (fromCml || DECODER_NAMES.includes(source))) {
        aliases.set(node.name.text, source);
      }
    } else if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      const value = node.initializer;
      const typed = node.type !== undefined && ts.isTypeQueryNode(node.type) && ts.isIdentifier(node.type.exprName) && cml.has(node.type.exprName.text);
      if (typed || (value !== undefined && isCml(value, cml))) cml.add(node.name.text);
      const alias = value === undefined ? undefined : functionOf(value, names);
      if (alias !== undefined) aliases.set(node.name.text, alias);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** The decoder name of a call, or none. */
function decoderNameOfCall(call: ts.CallExpression, names: LibraryNames): string | undefined {
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    const receiver = unwrap(callee.expression);
    const member = memberName(callee);
    if (member === undefined) return throughLibrary(receiver, names.cml) ? "<computed>" : undefined;
    if (DECODER_NAMES.includes(member)) return member;
    // A free function of the library: any member of `CML` itself.
    if (isCml(receiver, names.cml)) return member;
    if (member === "getUtxos" && ts.isCallExpression(receiver) && calleeName(receiver.expression) === "wallet") return member;
    if (ts.isIdentifier(receiver) && receiver.text === "Data" && DATA_METHODS.includes(member)) return `Data.${member}`;
    const namespace = ts.isIdentifier(receiver) ? receiver.text : memberName(receiver);
    if (namespace !== undefined && NAMESPACES.includes(namespace)) return member;
    return member.startsWith("from_") && chainNames(receiver).some((name) => names.cml.has(name)) ? member : undefined;
  }
  if (!ts.isIdentifier(callee)) return undefined;
  return names.aliases.get(callee.text) ?? (DECODER_NAMES.includes(callee.text) ? callee.text : undefined);
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
  const names = libraryNames(file);
  const found: DecoderCall[] = [];
  const add = (node: ts.Node, callee: string, target: ts.Expression): void => {
    const object = ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target) ? target.expression : undefined;
    const receiver = ts.isCallExpression(node) ? object : undefined;
    found.push({
      file: rootPath(file.fileName), line: lineOf(nameNode(target)), fn: functionLabel(node), callee, node, receiver,
      library: receiver !== undefined && throughLibrary(receiver, names.cml),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = decoderNameOfCall(node, names);
      if (callee !== undefined) add(node, callee, unwrap(node.expression));
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) && isHandedOn(node)) {
      const name = functionOf(node, names);
      if (name !== undefined) add(node, name, node);
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
  if (receiver === undefined || call.library) return undefined;
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
  site(SIGNED_TRANSACTION, "inspectSignedTransaction", "hash_transaction", 1,
    "The argument is the transaction body object that CML.Transaction.from_cbor_hex made in the same function. The function takes an " +
    `object, not a text or bytes, and it only hashes it. ${OWN_TRANSACTION}`,
    before("CML.Transaction.from_cbor_hex")),
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

/** The scan of the repository: the files that git tracks, or the files of a walk when git gives no list. */
const scanRepository = (): Scan => scanSources(sourceFiles(ROOT, gitFiles(ROOT)), trackedNamesOf(SITES));

const SCAN = scanRepository();

/** False when git gives no list. The scan walks the folders then, and the tests of the list do not apply. */
const GIT_LISTS_FILES = gitFiles(ROOT) !== undefined;

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
    // The free functions of the library.
    ["a free function of CML", "const hash = CML.hash_transaction(body);", ["hash_transaction"]],
    ["a free function over several lines", "const datum = CML\n  .encode_json_str_to_plutus_datum(\n    text,\n    schema,\n  );", ["encode_json_str_to_plutus_datum"]],
    ["a free function with comments between the parts", "CML /* the library */\n  // the function\n  .hash_transaction(\n    body, // the body\n  );", ["hash_transaction"]],
    ["a free function with an optional call", "CML?.make_vkey_witness?.(hash, key);", ["make_vkey_witness"]],
    ["a free function with an element access", 'CML["min_fee"](tx, fee, prices, 0n);', ["min_fee"]],
    ["a free function with a template key", "CML[`hash_plutus_data`](data);", ["hash_plutus_data"]],
    ["a free function in a comma expression", "(0, CML.hash_transaction)(body);", ["hash_transaction"]],
    ["a free function of CML after a cast", "(CML as typeof CML).min_fee(tx, fee, prices, 0n);", ["min_fee"]],
    ["a key that is not a string, on CML itself", "CML[name](value);", ["<computed>"]],
    ["a free function that a call hands on", "const hashes = bodies.map(CML.hash_transaction);", ["hash_transaction"]],
    ["a free function that `call` applies", "CML.hash_transaction.call(CML, body);", ["hash_transaction"]],
    ["a free function that a variable holds", "const hash = CML.hash_transaction;\nhash(body);", ["hash_transaction", "hash_transaction"]],
    ["a destructured free function", "const { encode_json_str_to_plutus_datum } = CML;\nencode_json_str_to_plutus_datum(text, schema);", ["encode_json_str_to_plutus_datum"]],
    ["a destructured free function with a new name", "const { hash_transaction: hash } = CML;\nhash(body);", ["hash_transaction"]],
    ["a free function through the rest of a destructuring", "const { Transaction, ...library } = CML;\nlibrary.hash_transaction(body);", ["hash_transaction"]],
    ["a free function through a namespace import", 'import * as Library from "@dcspark/cardano-multiplatform-lib-nodejs";\nLibrary.hash_transaction(body);', ["hash_transaction"]],
    ["a namespace import over several lines", 'import * as Library\n  from "@dcspark/cardano-multiplatform-lib-nodejs";\nLibrary\n  .hash_transaction(\n    body,\n  );', ["hash_transaction"]],
    ["a free function through a default import", 'import Library from "@anastasia-labs/cardano-multiplatform-lib-browser";\nLibrary.hash_transaction(body);', ["hash_transaction"]],
    ["a key that is not a string, on a name for CML", 'import * as Library from "@dcspark/cardano-multiplatform-lib-nodejs";\nLibrary[name](value);', ["<computed>"]],
    ["a free function through CML under a new name", 'import { CML as Library } from "@lucid-evolution/lucid";\nLibrary.min_fee(tx, fee, prices, 0n);', ["min_fee"]],
    ["a free function through a variable", "const library = CML;\nlibrary.min_fee(tx, fee, prices, 0n);", ["min_fee"]],
    ["a free function through a member named CML", "const hash = lucid.CML.hash_transaction(body);", ["hash_transaction"]],
    ["a free function through a parameter with CML as its default", "function f(library = CML) {\n  return library.hash_transaction(body);\n}", ["hash_transaction"]],
    ["a free function through a choice between libraries", "const library = options.library ?? CML;\nlibrary.hash_transaction(body);", ["hash_transaction"]],
    ["a free function through a parameter of the type of CML", "function f(library: typeof CML) {\n  return library.hash_transaction(body);\n}", ["hash_transaction"]],
    ["a named import of a free function", 'import { hash_transaction } from "@anastasia-labs/cardano-multiplatform-lib-nodejs";\nhash_transaction(body);', ["hash_transaction"]],
    ["a named import of a free function under a new name", 'import { make_vkey_witness as witness } from "@dcspark/cardano-multiplatform-lib-nodejs";\nwitness(hash, key);', ["make_vkey_witness"]],
    ["a free function of a package that require loads", 'const { hash_transaction } = require("@dcspark/cardano-multiplatform-lib-nodejs");\nhash_transaction(body);', ["hash_transaction"]],
    ["a free function of a package that import() loads", 'const library = await import("@anastasia-labs/cardano-multiplatform-lib-nodejs");\nlibrary.hash_transaction(body);', ["hash_transaction"]],
    ["a free function of a package that an import equals names", 'import library = require("@dcspark/cardano-multiplatform-lib-nodejs");\nlibrary.hash_transaction(body);', ["hash_transaction"]],
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

  it("does not see a free function in a comment or in a string", () => {
    const code = "// CML.hash_transaction(body)\n/* CML.min_fee(tx) */\nconst note = 'CML.hash_transaction(body)';\nconst text = `CML.min_fee(${tx})`;";
    expect(calleesIn(code)).toEqual([]);
  });

  it("does not see a free function of another name or of another module", () => {
    for (const code of [
      "const hash = CMLX.hash_transaction(body);", "const hash = cml.hash_transaction(body);", "const hash = Library.hash_transaction(body);",
      'import { hash_transaction } from "./hash.js";\nhash_transaction(body);',
      'import * as Library from "node:crypto";\nLibrary.hash_transaction(body);',
      'const { hash_transaction } = require("node:crypto");\nhash_transaction(body);',
    ]) expect(calleesIn(code), code).toEqual([]);
  });

  it("does not take a class of CML for a function", () => {
    for (const code of [
      "const Transaction = CML.Transaction;", "const { Transaction } = CML;\nconst list = [Transaction];",
      'import { Transaction } from "@dcspark/cardano-multiplatform-lib-nodejs";\nconst list = [Transaction];',
    ]) expect(calleesIn(code), code).toEqual([]);
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

  it("excludes no call through a name that the file gives to CML", () => {
    const call = "await Library.sign.withWallet().complete();";
    expect(exclusionOf(firstCallIn(`import * as Library from "@dcspark/cardano-multiplatform-lib-nodejs";\n${call}`))).toBeUndefined();
    expect(exclusionOf(firstCallIn(`const Library = CML;\n${call}`))).toBeUndefined();
    // The same call with no such name is the call of the sign builder.
    expect(exclusionOf(firstCallIn(call))).toBe(SIGN_COMPLETE);
  });
});

describe("the free functions of the library", () => {
  const PACKAGES = [
    "@dcspark/cardano-multiplatform-lib-nodejs", "@dcspark/cardano-multiplatform-lib-browser",
    "@anastasia-labs/cardano-multiplatform-lib-nodejs", "@anastasia-labs/cardano-multiplatform-lib-browser",
  ];

  /** The names that the declaration file of the package of the library exports: its free functions, and its classes and enums. */
  interface LibraryExports {
    functions: string[];
    types: string[];
  }

  /** The exports of the package that Lucid loads as the decoder library. */
  function readExports(): LibraryExports {
    const lucid = createRequire(join(ROOT, "packages/shared/package.json")).resolve("@lucid-evolution/lucid");
    const folder = dirname(createRequire(lucid).resolve("@anastasia-labs/cardano-multiplatform-lib-nodejs"));
    const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { types: string };
    const functions: string[] = [];
    const types: string[] = [];
    for (const statement of parse(join(folder, manifest.types)).statements) {
      const exported = ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) functions.push(statement.name.text);
      else if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name !== undefined) types.push(statement.name.text);
    }
    return { functions, types };
  }

  let declared: LibraryExports | undefined;
  const exportsOfLibrary = (): LibraryExports => (declared ??= readExports());

  it("reads the free functions from the declarations of the library", () => {
    const { functions } = exportsOfLibrary();
    expect(functions.length).toBeGreaterThan(0);
    // The sources call this one (tx/internal/signedTransaction.ts).
    expect(functions).toContain("hash_transaction");
  });

  it("tells a free function from a class by its first letter", () => {
    const { functions, types } = exportsOfLibrary();
    expect(types.length).toBeGreaterThan(0);
    expect(functions.filter((name) => !isFunctionName(name))).toEqual([]);
    expect(types.filter((name) => isFunctionName(name))).toEqual([]);
  });

  it("sees each free function that is called on CML", () => {
    for (const name of exportsOfLibrary().functions) {
      expect(calleesIn(`CML.${name}(value);`), name).toEqual([name]);
      expect(calleesIn(`CML\n  .${name}(\n    value,\n  );`), name).toEqual([name]);
      expect(calleesIn(`const { ${name} } = CML;\n${name}(value);`), name).toEqual([name]);
      expect(calleesIn(`const library = CML;\nlibrary.${name}(value);`), name).toEqual([name]);
      expect(calleesIn(`import { CML as Library } from "@lucid-evolution/lucid";\nLibrary.${name}(value);`), name).toEqual([name]);
      expect(calleesIn(`items.map(CML.${name});`), name).toEqual([name]);
    }
  });

  it("sees each free function that an import of the package names", () => {
    for (const name of exportsOfLibrary().functions) {
      for (const module of PACKAGES) {
        const at = `${name} from ${module}`;
        expect(calleesIn(`import { ${name} } from "${module}";\n${name}(value);`), at).toEqual([name]);
        expect(calleesIn(`import { ${name} as use } from "${module}";\nuse(value);`), at).toEqual([name]);
        expect(calleesIn(`import * as Library from "${module}";\nLibrary.${name}(value);`), at).toEqual([name]);
      }
    }
  });

  it("parses a file that holds a call of one of them", () => {
    const pattern = detectionPattern([]);
    for (const name of exportsOfLibrary().functions) {
      expect(pattern.test(`CML.${name}(value);`), name).toBe(true);
      for (const module of PACKAGES) expect(pattern.test(`import { ${name} } from "${module}";\n${name}(value);`), `${name} from ${module}`).toBe(true);
    }
  });
});

describe("the source files", () => {
  const folders: string[] = [];
  afterAll(() => {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  });

  const relativeNames = (folder: string, paths: readonly string[]): string[] => paths.map((path) => relative(folder, path).split(sep).join("/"));

  /** A folder in the temporary folder of the system, with these files in it. */
  const folderWith = (files: readonly string[]): string => {
    const folder = mkdtempSync(join(tmpdir(), "decoder-sites-"));
    folders.push(folder);
    for (const file of files) {
      mkdirSync(dirname(join(folder, file)), { recursive: true });
      writeFileSync(join(folder, file), "export {};\n");
    }
    return folder;
  };

  it("takes each type of source file and leaves out tests, modules and output", () => {
    const source = [
      "scripts/j.ts", "pkg/src/a.ts", "pkg/src/b.tsx", "pkg/src/c.mts", "pkg/src/d.cts", "pkg/src/e.js", "pkg/src/f.jsx", "pkg/src/g.mjs",
      "pkg/src/h.cjs", "pkg/src/ui/i.tsx", "pkg/src/test/k.ts", "pkg/src/tests/l.ts", "packages/shared/src/test/p.ts",
    ];
    const other = [
      "pkg/src/a.test.ts", "pkg/src/b.spec.mts", "pkg/src/c.test.tsx", "pkg/test/n.ts", "pkg/tests/q.ts", "packages/shared/test/r.ts",
      "tests/s.ts", "pkg/src/__tests__/m.ts", "node_modules/pkg/index.js", "pkg/src/node_modules/pkg/index.js", "dist/o.js",
      "pkg/src/notes.md", "pkg/src/style.css",
    ];
    const folder = folderWith([...source, ...other]);
    expect(relativeNames(folder, sourceFiles(folder, undefined))).toEqual([...source].sort());
  });

  const PATHS: Array<[path: string, source: boolean]> = [
    ["gateway/src/test/helper.ts", true],
    ["gateway/src/tests/helper.ts", true],
    ["packages/shared/src/test/x.ts", true],
    ["buyer/src/ui/test/x.tsx", true],
    ["buyer/scripts/run-agent-a.ts", true],
    ["vitest.config.ts", true],
    ["gateway/test/sweeper.test.ts", false],
    ["gateway/test/helper.ts", false],
    ["identity-gateway/test/vectors/case.ts", false],
    ["paper2agent/tests/x.ts", false],
    ["packages/shared/test/x.ts", false],
    ["packages/shared/tests/x.ts", false],
    ["tests/fixtures/x.ts", false],
    ["tests/unit/__helpers__/x.ts", false],
    ["buyer/src/ui/__tests__/x.tsx", false],
    ["gateway/src/sweeper.test.ts", false],
    ["buyer/src/b.spec.tsx", false],
    ["gateway/node_modules/pkg/index.js", false],
    ["gateway/dist/index.js", false],
    ["gateway/src/notes.md", false],
  ];

  it.each(PATHS)("%s is a source file: %s", (path, source) => {
    expect(selectSourcePaths([path])).toEqual(source ? [path] : []);
  });

  it("scans the paths of the list and no other file", () => {
    const listed = ["gateway/src/a.ts", "buyer/src/b.ts"];
    // `scratch/x.ts` and `gateway/src/c.ts` are in the folder, and the list does not name them.
    const folder = folderWith([...listed, "scratch/x.ts", "gateway/src/c.ts"]);
    expect(relativeNames(folder, sourceFiles(folder, listed))).toEqual(["buyer/src/b.ts", "gateway/src/a.ts"]);
    // A walk finds all of them. The scan walks only when git gives no list.
    expect(relativeNames(folder, sourceFiles(folder, undefined))).toEqual(["buyer/src/b.ts", "gateway/src/a.ts", "gateway/src/c.ts", "scratch/x.ts"]);
    // A path of the list that the folder does not have is left out.
    expect(relativeNames(folder, sourceFiles(folder, [...listed, "gateway/src/gone.ts"]))).toEqual(["buyer/src/b.ts", "gateway/src/a.ts"]);
  });

  it("gets no list when the folder has no .git or git is not installed", () => {
    expect(gitFiles(folderWith([]))).toBeUndefined();
    expect(gitFiles(ROOT, "git-that-is-not-installed")).toBeUndefined();
  });

  it("does not walk when git fails for another reason", () => {
    const folder = folderWith([]);
    mkdirSync(join(folder, ".git"));
    // A command that exists and exits with an error stands in for a git that fails.
    expect(() => gitFiles(folder, process.execPath)).toThrow();
  });

  it.skipIf(!GIT_LISTS_FILES)("scans the files that git tracks, and no other file", () => {
    const output = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const tracked = output.split("\0").filter((path) => path !== "");
    // A tracked file that the work tree no longer has is not read.
    const expected = selectSourcePaths(tracked).filter((path) => existsSync(join(ROOT, path)));
    expect(expected.length).toBeGreaterThan(0);
    expect([...SCAN.files].sort()).toEqual(expected);
  });

  it.skipIf(!GIT_LISTS_FILES)("does not read a file that git does not track", () => {
    // The folder is in the repository, and git does not track it. A call of the library is in its file.
    const scratch = mkdtempSync(join(ROOT, ".scratch-sites-"));
    const scratchFile = `${relative(ROOT, scratch)}/x.ts`;
    try {
      writeFileSync(join(scratch, "x.ts"), "CML.Address.from_bech32(x);\n");
      // The rules call the file source. Only the list of git leaves it out.
      expect(selectSourcePaths([scratchFile])).toEqual([scratchFile]);
      const scan = scanRepository();
      expect(scan.files).not.toContain(scratchFile);
      expect(scan.files).toEqual(SCAN.files);
      expect(scan.sites).toHaveLength(SCAN.sites.length);
      expect(compareSites(scan.sites, SITES)).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each(SOURCE_DIRS)("scans the files of %s", (folder) => {
    expect(SCAN.files.filter((file) => file.startsWith(`${folder}/`)).length).toBeGreaterThan(0);
  });

  it("scans the user interface and the scripts of the buyer", () => {
    expect(SCAN.files).toContain("buyer/src/ui/App.tsx");
    expect(SCAN.files).toContain("buyer/scripts/run-agent-a.ts");
  });

  it("scans no test file, no module and no output", () => {
    const notSource = [
      /(?:^|\/)(?:node_modules|dist)\//, /^tests\//, /^[^/]+\/tests?\//, /^packages\/[^/]+\/tests?\//, /(?:^|\/)__tests__\//, TEST_FILE,
    ];
    expect(SCAN.files.filter((file) => notSource.some((pattern) => pattern.test(file)))).toEqual([]);
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
