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
//
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
// regexes close both.
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

export function forbiddenEverywhere(path: string, source: string): string[] {
  const failures: string[] = [];
  for (const forbidden of FORBIDDEN_EVERYWHERE) {
    if (source.includes(forbidden)) failures.push(`capability-forbidden:${path}:${forbidden}`);
  }
  for (const [label, pattern] of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(source)) failures.push(`capability-forbidden:${path}:${label}`);
  }
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
  for (const forbidden of FORBIDDEN_OUTSIDE_HOST) {
    if (source.includes(forbidden))
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

export function dependencyNames(manifest: string): string[] {
  const names: string[] = [];
  let inDependencies = false;
  for (const line of manifest.split("\n")) {
    const section = SECTION_HEADER.exec(line.trim())?.[1];
    if (section !== undefined) {
      inDependencies = section === "dependencies";
      continue;
    }
    if (!inDependencies) continue;
    const name = /^([a-z0-9_-]+)(?:\.[a-z0-9_-]+)?\s*=/.exec(line.trim())?.[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

export async function checkHarnessCapabilityBoundary(): Promise<string[]> {
  const failures: string[] = [];
  const manifest = await Bun.file(inCrate("Cargo.toml")).text();
  failures.push(...forbiddenDependencySections(manifest));
  const dependencies = dependencyNames(manifest);
  for (const dependency of dependencies) {
    if (!ALLOWED_DEPENDENCIES.has(dependency)) {
      failures.push(`dependency-not-allowed:${dependency}`);
    }
  }
  // An upper bound, not a requiredlist: a dependency that stops being needed
  // must be removable without the guard forcing dead weight to stay.

  for (const forbiddenPath of [inCrate("build.rs"), inCrate("src/main.rs"), inCrate("src/bin")]) {
    if (await Bun.file(forbiddenPath).exists())
      failures.push(`runtime-entry-forbidden:${forbiddenPath}`);
  }

  const glob = new Bun.Glob(inCrate("src/**/*.rs"));
  let sourceCount = 0;
  for await (const path of glob.scan({ cwd: ".", onlyFiles: true })) {
    sourceCount += 1;
    const source = await Bun.file(path).text();
    failures.push(...forbiddenEverywhere(path, source));
    failures.push(...forbiddenOutsideHost(path, source));
  }
  if (sourceCount === 0) failures.push("runtime-source-missing");
  return failures;
}

if (import.meta.main) {
  const failures = await checkHarnessCapabilityBoundary();
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(
    "Harness capability boundary verified: host capability confined to src/host, network and secrets closed",
  );
}
