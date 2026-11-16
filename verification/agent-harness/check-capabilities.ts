// WP-G3-H01 capability boundary of the libre-ai-harness crate (ADR-0018 D2).
// Contract-held profile assertions use tracked test fixtures; they introduce
// no runtime dependency or host capability. The existing allowlist stays closed.
// Immediate EOF cutoff retains the existing kill-before-reap runtime. Zombie
// observation belongs to test fixtures only; no new runtime capability or
// dependency is admitted by the lifecycle clarification.
// Privileged CI journeys and their precondition gate remain test tooling;
// they do not widen the runtime dependency or host-capability allowlists.
// Unbound-response fixtures drain their input to isolate binding rejection
// from incomplete socket capture; runtime refusal precedence is unchanged.
// Coverage comparison reads test reports and source inventory only; its
// tooling dependencies do not enter the runtime allowlist.
//
// The harness frontier is NOT the simulation-only frontier of the control
// core: the harness legitimately holds exactly one OS capability — spawning
// and confining a local process — and that capability lives in src/host/
// alone. Everything else stays pure and hostless. What ADR-0018 D2 keeps
// closed at this stage is banned EVERYWHERE, host module included: outbound
// network, secrets (the environment), async runtimes.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// The crate lives at the repository root: this is the only reality it has
// ever had (unlike orchestrator's agent-harness crate, which this file was
// mechanically adapted from). CRATE_ROOT exists anyway, with the same
// inCrate() indirection the bootstrap guard used — interpolating
// `${CRATE_ROOT}/src/host/` when CRATE_ROOT is "." would produce
// "./src/host/", which never matches the unprefixed paths Bun.Glob returns,
// and the gate would fail red on conforming code forever.
const CRATE_ROOT = ".";
const inCrate = (path: string): string => (CRATE_ROOT === "." ? path : `${CRATE_ROOT}/${path}`);
const HOST_PREFIX = inCrate("src/host/");

const ALLOWED_DEPENDENCIES = new Set([
  "ed25519-dalek",
  "libre-ai-contract-types",
  "serde",
  "serde_jcs",
  "serde_json",
  "sha2",
]);

// Closed by ADR-0018 D2 — banned in every module, host included. The network
// ban names the socket TYPES rather than the std::net module: UnixStream's
// own shutdown mode (std::net::Shutdown) lives there without being a network
// capability, and the types are what actually open one.
const FORBIDDEN_EVERYWHERE = [
  "std::net::Tcp",
  "std::net::Udp",
  "std::env",
  // `verifyOsPeer` is refused rather than applied by this engine, which has
  // no libc to read peer credentials with (harness-profile.v2, ADR-0030).
  // The transport is an anonymous socketpair created before the child
  // exists and handed to exactly one child, so no third party can be the
  // peer — but that argument only holds while no NAMED socket can exist in
  // the crate, which is what these bans make true rather than asserted.
  "UnixListener",
  "bind(",
  ".bind_addr",
  "tokio::",
  "reqwest::",
  "hyper::",
  "TcpStream",
  "TcpListener",
  "UdpSocket",
];

// Host capabilities: legitimate under src/host/ only. A pure module that
// touches one of these has crossed the runtime boundary of the harness
// specification (docs/apps/harness.md, "Runtime boundaries").
const FORBIDDEN_OUTSIDE_HOST = [
  "std::process",
  "std::fs",
  "std::os::unix::net",
  "std::thread",
  "std::time",
  "Utc::now",
  "Local::now",
  "SystemTime",
  "Instant::now",
  "Command::new",
  "OpenOptions",
  "UnixStream",
];

// Rust paths are whitespace-insensitive, so a literal substring ban is evaded
// by `use std :: env ;` and by grouped imports (`use std::{env, fs};`). These
// regexes close both for the surfaces closed everywhere; pathView() below
// closes them for every literal ban, host capabilities included. They are
// matched against the code view, where a string literal is reduced to `""`:
// the ffi pattern therefore refuses an extern block or function under any
// ABI string, "C" included.
const FORBIDDEN_SOURCE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["std-alias", /\b(?:use|extern\s+crate)\s+std\s+as\b/u],
  ["ffi", /\bextern\s*""/u],
  ["spaced-std-env", /\bstd\s*::\s*env\b/u],
  ["spaced-std-net", /\bstd\s*::\s*net\s*::\s*(?:Tcp|Udp)/u],
];

// A `std::{ … }` group that names `env` or `net`, wherever it is written: a
// group outside a `use` declaration (a macro argument) is not flattened by
// pathView(). The pattern is tested inside the group only, braces balanced:
// read over a fixed window instead, it fired on any `env` identifier that
// followed `use std::{fmt, io};`.
const FORBIDDEN_IN_STD_GROUP: ReadonlyArray<readonly [string, RegExp]> = [
  ["grouped-std-env", /\benv\b/u],
  ["grouped-std-net", /\bnet\b/u],
];
const STD_GROUP_OPENING = /\bstd\s*::\s*\{/gu;

function stdGroups(code: string): string[] {
  const groups: string[] = [];
  for (const opening of code.matchAll(STD_GROUP_OPENING)) {
    const start = opening.index + opening[0].length;
    let depth = 1;
    let end = start;
    // A group that never closes runs to the end of the file: refused wide
    // rather than read short.
    while (end < code.length && depth > 0) {
      if (code[end] === "{") depth += 1;
      else if (code[end] === "}") depth -= 1;
      end += 1;
    }
    groups.push(code.slice(start, end));
  }
  return groups;
}

// `[[bench]]` and `[[test]]` are sections as much as `[dependencies]` is; a
// header the parser fails to see leaves it inside the previous section and
// turns that block's keys into dependency names.
const SECTION_HEADER = /^\[\[?([^\]]+)\]\]?(?:\s*#.*)?$/u;

interface UsePath {
  readonly path: string;
  readonly alias: string | undefined;
}

interface PathView {
  // The code view with `::` spacing removed, followed by one flat path per
  // imported item: the text every literal ban is matched against.
  readonly text: string;
  // The code view itself: what the pattern bans are matched against.
  readonly code: string;
  readonly stdAliased: boolean;
  readonly stdGlobbed: boolean;
  readonly unparseable: boolean;
  readonly unlexable: boolean;
}

interface CodeView {
  readonly code: string;
  // A comment, string or character literal that never closes: what follows
  // cannot be told from code, so the caller refuses the file.
  readonly unterminated: boolean;
}

// The source as the Rust lexer splits it, reduced to what can name a path:
// each comment becomes one space, each string literal `""`, each character
// literal `''`, and a raw identifier loses its `r#`. Without this, the word
// "use" in a doc comment or a `;` in a comment inside a use tree read as
// code (a red on conforming code), and `std::/* x */fs` or `std::r#fs` read
// as something other than `std::fs` (a hole).
function codeView(source: string): CodeView {
  let code = "";
  let index = 0;
  const unterminated = (): CodeView => ({ code, unterminated: true });
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      code += " ";
      continue;
    }
    if (source.startsWith("/*", index)) {
      // Block comments nest in Rust.
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      if (depth > 0) return unterminated();
      code += " ";
      continue;
    }
    const character = source[index];
    if (character === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
      if (end >= source.length) return unterminated();
      code += '""';
      index = end + 1;
      continue;
    }
    const rawString = character === "r" ? /^r(#*)"/u.exec(source.slice(index, index + 300)) : null;
    if (rawString !== null) {
      const end = source.indexOf(`"${rawString[1]}`, index + rawString[0].length);
      if (end === -1) return unterminated();
      code += '""';
      index = end + 1 + (rawString[1]?.length ?? 0);
      continue;
    }
    if (character === "'") {
      if (source[index + 1] === "\\") {
        const end = source.indexOf("'", index + 3);
        if (end === -1) return unterminated();
        code += "''";
        index = end + 1;
        continue;
      }
      // 'x' is a character literal, 'x without a closing quote a lifetime.
      const width = (source.codePointAt(index + 1) ?? 0) > 0xffff ? 2 : 1;
      if (source[index + 1 + width] === "'") {
        code += "''";
        index += width + 2;
        continue;
      }
    }
    code += character;
    index += 1;
  }
  // Raw strings are gone by now, so `r#` before an identifier start is a raw
  // identifier: `std::r#fs` is `std::fs`.
  return { code: code.replace(/\br#(?=[\p{XID_Start}_])/gu, ""), unterminated: false };
}

// The keyword followed by nothing but what a use tree is made of, up to its
// `;`: identifiers, `::`, braces, commas, `*`, and `$` for `$crate`. The
// keyword needs no blank after it (`use::std::fs;`, `use{std::fs};`), and
// what the class refuses is not a declaration: `use<'a>` in a precise
// capture, `(use $x:ident) =>` in a macro matcher.
const USE_DECLARATION = /\buse\b((?:[\s:{},*$]|\p{XID_Continue})*);/gu;
const USE_ALIAS = /^(.*?)(?:\s+as\s+(\p{XID_Continue}+))?$/su;

function splitTopLevel(list: string): string[] | undefined {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const character = list[index];
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      items.push(list.slice(start, index));
      start = index + 1;
    }
    if (depth < 0) return undefined;
  }
  if (depth !== 0) return undefined;
  items.push(list.slice(start));
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

// `std::{fs, io::{self, Read}, process::Command as C}` becomes std::fs,
// std::io, std::io::Read and std::process::Command (alias C). Undefined when
// the braces do not balance: the caller refuses what it cannot read.
function expandUseTree(tree: string, prefix = ""): UsePath[] | undefined {
  const items = splitTopLevel(tree);
  if (items === undefined) return undefined;
  const paths: UsePath[] = [];
  for (const item of items) {
    const open = item.indexOf("{");
    if (open === -1) {
      const [, path = "", alias] = USE_ALIAS.exec(item) ?? [];
      const flat = `${prefix}${path}`.replace(/\s+/gu, "").replace(/^::/u, "");
      paths.push({ path: flat.replace(/::self$/u, ""), alias });
      continue;
    }
    if (!item.endsWith("}")) return undefined;
    const nested = expandUseTree(item.slice(open + 1, -1), `${prefix}${item.slice(0, open)}`);
    if (nested === undefined) return undefined;
    paths.push(...nested);
  }
  return paths;
}

function pathView(source: string): PathView {
  const { code, unterminated } = codeView(source);
  const flat: string[] = [];
  let stdAliased = false;
  let stdGlobbed = false;
  let unparseable = false;
  for (const [, tree = ""] of code.matchAll(USE_DECLARATION)) {
    const paths = expandUseTree(tree);
    if (paths === undefined) {
      unparseable = true;
      continue;
    }
    for (const { path, alias } of paths) {
      flat.push(path);
      if (path === "std" && alias !== undefined) stdAliased = true;
      // `use std::*;` brings `env`, `fs`, `process` and `thread` in scope
      // without writing one banned path; `env` is closed in the host too.
      if (path === "std::*") stdGlobbed = true;
    }
  }
  const text = [code.replace(/\s*::\s*/gu, "::"), ...flat].join("\n");
  return { text, code, stdAliased, stdGlobbed, unparseable, unlexable: unterminated };
}

export function forbiddenEverywhere(path: string, source: string): string[] {
  const failures: string[] = [];
  const view = pathView(source);
  for (const forbidden of FORBIDDEN_EVERYWHERE) {
    if (view.text.includes(forbidden)) failures.push(`capability-forbidden:${path}:${forbidden}`);
  }
  for (const [label, pattern] of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(view.code)) failures.push(`capability-forbidden:${path}:${label}`);
  }
  const groups = stdGroups(view.code);
  for (const [label, pattern] of FORBIDDEN_IN_STD_GROUP) {
    if (groups.some((group) => pattern.test(group)))
      failures.push(`capability-forbidden:${path}:${label}`);
  }
  // `use std::{self as platform};` renames std as surely as `use std as platform;`.
  const stdAlias = `capability-forbidden:${path}:std-alias`;
  if (view.stdAliased && !failures.includes(stdAlias)) failures.push(stdAlias);
  if (view.stdGlobbed) failures.push(`capability-forbidden:${path}:std-glob`);
  if (view.unparseable) failures.push(`capability-forbidden:${path}:use-tree-unparseable`);
  if (view.unlexable) failures.push(`capability-forbidden:${path}:source-unlexable`);
  // Scanned on the code view, attribute lines removed: a substring exemption
  // would let `unsafe { … } // forbid(unsafe_code)` buy a pass, while prose
  // about unsafety (line comment, block comment or string) failed the gate.
  // The crate-level attribute is the one legitimate occurrence.
  const executableUnsafe = view.code
    .split("\n")
    .map((line) => line.replace(/^\s*#!?\[[^\]]*\]\s*$/u, ""))
    .some((line) => /\bunsafe\b/.test(line));
  if (executableUnsafe) failures.push(`unsafe-forbidden:${path}`);
  return failures;
}

export function forbiddenOutsideHost(path: string, source: string): string[] {
  if (path.startsWith(HOST_PREFIX)) return [];
  const failures: string[] = [];
  const view = pathView(source);
  for (const forbidden of FORBIDDEN_OUTSIDE_HOST) {
    if (view.text.includes(forbidden))
      failures.push(`host-capability-outside-host:${path}:${forbidden}`);
  }
  return failures;
}

type TomlTable = Record<string, unknown>;

const isTable = (value: unknown): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The single place the manifest is parsed. A manifest that does not parse
// throws, and the gate fails: nothing can be said about its dependencies.
// The line break is appended because the pinned Bun (1.4.0-canary.1) refuses
// a table header that ends the file without one ("Expected line break but
// found end of file"), which is valid TOML and which Bun 1.4.4 accepts.
function parseManifest(manifest: string): TomlTable {
  return Bun.TOML.parse(`${manifest}\n`) as TomlTable;
}

// Every table whose key ends in `dependencies`, at any depth, other than the
// root `[dependencies]`: `dev-dependencies`, `dev_dependencies`,
// `target.<cfg>.dependencies`, `workspace.dependencies`.
function alternateDependencyTables(table: TomlTable, trail: readonly string[] = []): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(table)) {
    const path = [...trail, key];
    const allowedRoot = path.length === 1 && key === "dependencies";
    if (allowedRoot) continue;
    if (key.endsWith("dependencies")) found.push(path.join("."));
    else if (isTable(value)) found.push(...alternateDependencyTables(value, path));
  }
  return found;
}

const unquoted = (section: string): string => section.replace(/["'\s]/gu, "");

// Two readings, because neither sees everything. The header scan alone
// refuses `[dependencies.<name>]`, which parses to the same table as an
// inline entry. The parsed walk alone sees a table that no header the scan
// recognises announces: `[ dev-dependencies ]`, `["dev-dependencies"]`,
// `dev-dependencies = { … }`, `target.x.dependencies.y = "1"`.
export function forbiddenDependencySections(manifest: string): string[] {
  const sections: string[] = [];
  for (const line of manifest.split("\n")) {
    const section = SECTION_HEADER.exec(line.trim())?.[1];
    const alternateDependencySection =
      section !== undefined &&
      section !== "dependencies" &&
      (section.endsWith("dependencies") ||
        section.startsWith("dependencies.") ||
        section.includes(".dependencies."));
    if (alternateDependencySection) sections.push(section);
  }
  for (const table of alternateDependencyTables(parseManifest(manifest))) {
    if (!sections.some((section) => unquoted(section) === unquoted(table))) sections.push(table);
  }
  return sections.map((section) => `dependency-section-forbidden:${section}`);
}

// Parsed, not matched line by line: a key may be bare, quoted or dotted
// (`"reqwest" = "1"`, `reqwest.version = "1"`), and each spelling names the
// same dependency. The name is the package Cargo resolves, not the key:
// `serde = { package = "reqwest" }` depends on reqwest.
export function dependencyNames(manifest: string): string[] {
  const dependencies = parseManifest(manifest).dependencies;
  if (!isTable(dependencies)) return [];
  return Object.entries(dependencies).map(([key, specification]) =>
    isTable(specification) && typeof specification.package === "string"
      ? specification.package
      : key,
  );
}

export interface CapabilityBoundaryReport {
  readonly failures: string[];
  // Rust files under src that were read and judged.
  readonly sourceFiles: number;
  // Of those, the files whose path below src has a dotted segment.
  readonly dottedSourceFiles: number;
  // Regular files under src that are not `.rs`: counted, never read.
  readonly otherFiles: number;
}

interface SourceInventory {
  readonly rustFiles: string[];
  readonly otherFiles: string[];
  readonly links: string[];
}

// Every entry under src, dotted ones included: rustc compiles
// `#[path = ".h/evil.rs"] mod evil;` like any other module, and a glob that
// skips dotted entries reports a volume it did not read. Links are listed,
// not followed. A directory that cannot be read throws, and the gate fails.
async function inventory(root: string, directory: string): Promise<SourceInventory> {
  const found: SourceInventory = { rustFiles: [], otherFiles: [], links: [] };
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) found.links.push(path);
    else if (entry.isDirectory()) {
      const nested = await inventory(root, path);
      found.rustFiles.push(...nested.rustFiles);
      found.otherFiles.push(...nested.otherFiles);
      found.links.push(...nested.links);
    } else if (entry.isFile() && entry.name.endsWith(".rs")) found.rustFiles.push(path);
    else found.otherFiles.push(path);
  }
  return found;
}

export async function checkHarnessCapabilityBoundary(
  root = ".",
): Promise<CapabilityBoundaryReport> {
  const failures: string[] = [];
  const manifest = await Bun.file(join(root, inCrate("Cargo.toml"))).text();
  failures.push(...forbiddenDependencySections(manifest));
  const dependencies = dependencyNames(manifest);
  for (const dependency of dependencies) {
    if (!ALLOWED_DEPENDENCIES.has(dependency)) {
      failures.push(`dependency-not-allowed:${dependency}`);
    }
  }
  // An upper bound, not a requiredlist: a dependency that stops being needed
  // must be removable without the guard forcing dead weight to stay.

  // existsSync, not Bun.file().exists(): the latter answers false for a
  // directory, so src/bin was never seen.
  for (const forbiddenPath of [inCrate("build.rs"), inCrate("src/main.rs"), inCrate("src/bin")]) {
    if (existsSync(join(root, forbiddenPath)))
      failures.push(`runtime-entry-forbidden:${forbiddenPath}`);
  }

  const sourceRoot = inCrate("src");
  const { rustFiles, otherFiles, links } = existsSync(join(root, sourceRoot))
    ? await inventory(root, sourceRoot)
    : { rustFiles: [], otherFiles: [], links: [] };
  for (const link of links.sort()) failures.push(`source-link-not-examined:${link}`);
  let dottedSourceFiles = 0;
  for (const path of rustFiles.sort()) {
    if (path.slice(sourceRoot.length).includes("/.")) dottedSourceFiles += 1;
    const source = await Bun.file(join(root, path)).text();
    failures.push(...forbiddenEverywhere(path, source));
    failures.push(...forbiddenOutsideHost(path, source));
  }
  const sourceFiles = rustFiles.length;
  if (sourceFiles === 0) failures.push("runtime-source-missing");
  return { failures, sourceFiles, dottedSourceFiles, otherFiles: otherFiles.length };
}

if (import.meta.main) {
  const { failures, sourceFiles, dottedSourceFiles, otherFiles } =
    await checkHarnessCapabilityBoundary();
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(
    `Harness capability boundary verified: ${sourceFiles} source file(s) examined (${dottedSourceFiles} under a dotted path), ${otherFiles} other file(s) under src not examined, host capability confined to src/host, network and secrets closed`,
  );
}
