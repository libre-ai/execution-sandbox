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
// closes them for every literal ban, host capabilities included.
const FORBIDDEN_SOURCE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["std-alias", /\b(?:use|extern\s+crate)\s+std\s+as\b/u],
  ["ffi", /\bextern\s*"C"/u],
  ["spaced-std-env", /\bstd\s*::\s*env\b/u],
  ["spaced-std-net", /\bstd\s*::\s*net\s*::\s*(?:Tcp|Udp)/u],
  ["grouped-std-env", /\bstd\s*::\s*\{[\s\S]{0,500}\benv\b/u],
  ["grouped-std-net", /\bstd\s*::\s*\{[\s\S]{0,500}\bnet\b/u],
];

// `[[bench]]` and `[[test]]` are sections as much as `[dependencies]` is; a
// header the parser fails to see leaves it inside the previous section and
// turns that block's keys into dependency names.
const SECTION_HEADER = /^\[\[?([^\]]+)\]\]?(?:\s*#.*)?$/u;

interface UsePath {
  readonly path: string;
  readonly alias: string | undefined;
}

interface PathView {
  // The source with `::` spacing removed, followed by one flat path per
  // imported item: the text every literal ban is matched against.
  readonly text: string;
  readonly stdAliased: boolean;
  readonly unparseable: boolean;
}

// A declaration is matched wherever it appears, comments and strings
// included: a ban that fires on prose is a red to read, one that skips real
// code is a hole.
const USE_DECLARATION = /\buse\s+([^;]*);/gu;

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
      const [, path = "", alias] = /^(.*?)(?:\s+as\s+(\w+))?$/su.exec(item) ?? [];
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
  const flat: string[] = [];
  let stdAliased = false;
  let unparseable = false;
  for (const [, tree = ""] of source.matchAll(USE_DECLARATION)) {
    const paths = expandUseTree(tree.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, ""));
    if (paths === undefined) {
      unparseable = true;
      continue;
    }
    for (const { path, alias } of paths) {
      flat.push(path);
      if (path === "std" && alias !== undefined) stdAliased = true;
    }
  }
  const text = [source.replace(/\s*::\s*/gu, "::"), ...flat].join("\n");
  return { text, stdAliased, unparseable };
}

export function forbiddenEverywhere(path: string, source: string): string[] {
  const failures: string[] = [];
  const view = pathView(source);
  for (const forbidden of FORBIDDEN_EVERYWHERE) {
    if (view.text.includes(forbidden)) failures.push(`capability-forbidden:${path}:${forbidden}`);
  }
  for (const [label, pattern] of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(source)) failures.push(`capability-forbidden:${path}:${label}`);
  }
  // `use std::{self as platform};` renames std as surely as `use std as platform;`.
  const stdAlias = `capability-forbidden:${path}:std-alias`;
  if (view.stdAliased && !failures.includes(stdAlias)) failures.push(stdAlias);
  if (view.unparseable) failures.push(`capability-forbidden:${path}:use-tree-unparseable`);
  // Comments and attributes are stripped before the scan: a substring
  // exemption would let `unsafe { … } // forbid(unsafe_code)` buy a pass
  // while prose about unsafety failed the gate. The crate-level attribute is
  // the one legitimate occurrence.
  const executableUnsafe = source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/u, "").replace(/^\s*#!?\[[^\]]*\]\s*$/u, ""))
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

export function forbiddenDependencySections(manifest: string): string[] {
  const failures: string[] = [];
  for (const line of manifest.split("\n")) {
    const section = SECTION_HEADER.exec(line.trim())?.[1];
    const alternateDependencySection =
      section !== undefined &&
      section !== "dependencies" &&
      (section.endsWith("dependencies") ||
        section.startsWith("dependencies.") ||
        section.includes(".dependencies."));
    if (alternateDependencySection) failures.push(`dependency-section-forbidden:${section}`);
  }
  return failures;
}

// Parsed, not matched line by line: a key may be bare, quoted or dotted
// (`"reqwest" = "1"`, `reqwest.version = "1"`), and each spelling names the
// same dependency. A manifest that does not parse throws, and the gate fails.
export function dependencyNames(manifest: string): string[] {
  const dependencies = (Bun.TOML.parse(manifest) as Record<string, unknown>).dependencies;
  return typeof dependencies === "object" && dependencies !== null ? Object.keys(dependencies) : [];
}

export interface CapabilityBoundaryReport {
  readonly failures: string[];
  readonly sourceFiles: number;
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

  const glob = new Bun.Glob(inCrate("src/**/*.rs"));
  let sourceFiles = 0;
  for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
    sourceFiles += 1;
    const source = await Bun.file(join(root, path)).text();
    failures.push(...forbiddenEverywhere(path, source));
    failures.push(...forbiddenOutsideHost(path, source));
  }
  if (sourceFiles === 0) failures.push("runtime-source-missing");
  return { failures, sourceFiles };
}

if (import.meta.main) {
  const { failures, sourceFiles } = await checkHarnessCapabilityBoundary();
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(
    `Harness capability boundary verified: ${sourceFiles} source file(s) examined, host capability confined to src/host, network and secrets closed`,
  );
}
