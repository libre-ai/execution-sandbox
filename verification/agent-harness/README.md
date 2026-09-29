# WP-G3-H01 capability boundary verification

This directory makes the runtime boundary of `libre-ai-harness` executable, not just documented
(`docs/apps/harness.md`, ADR-0018 D2).

The crate legitimately holds exactly one OS capability — spawning and confining a local process —
and that capability lives in `src/host/` alone. Everything else is pure and hostless.
`check-capabilities.ts` enforces this mechanically:

- **Dependency surface**: `Cargo.toml`'s `[dependencies]` section may only name the six crates the
  crate actually needs (`ed25519-dalek`, `libre-ai-contract-types`, `serde`, `serde_jcs`,
  `serde_json`, `sha2`). This is an upper bound, not a required list — a dependency that stops being
  needed must be removable without the guard forcing dead weight to stay. Alternate dependency
  sections (`[dev-dependencies]`, `[build-dependencies]`, `[dependencies.*]`, target-scoped
  sections) are refused outright, including when hidden behind an unrecognized `[[…]]`
  array-of-tables header.
- **Unsafe code is refused everywhere**, including under `src/host/`. The scan strips comments and
  attribute lines before testing for the `unsafe` keyword, so a trailing
  `// forbid(unsafe_code)` comment cannot buy a real `unsafe` block an exemption, and prose
  mentioning the word does not false-positive.
- **Network and secrets stay closed everywhere**, host module included: `std::env`, the TCP/UDP
  socket types, named Unix sockets (`UnixListener`, `bind(`, `.bind_addr`) and the async runtimes
  this crate does not use (`tokio::`, `reqwest::`, `hyper::`). The anonymous socketpair
  (`UnixStream::pair()`) the harness actually uses to talk to its worker stays allowed — it is a
  bound created before the child process exists and handed to exactly one child, never a named,
  discoverable endpoint.
- **Process, filesystem and OS-time capabilities are refused outside `src/host/`.** A pure module
  (`profile`, `controls`, `fs_policy`, `outputs`, `attestation`, `confinement`) that reaches for
  `std::process`, `std::fs`, `std::os::unix::net`, `std::thread`, `std::time`, wall-clock time or
  `OpenOptions` has crossed the runtime boundary the specification draws at `src/host/`.
- **No runtime entry point.** `build.rs`, `src/main.rs` and `src/bin/` are all refused — this crate
  is a library, never a binary the harness's own boundary would then need to police.

Every future capability this crate opens edits `check-capabilities.ts` in the same pull request
that adds the dependency or import the gate would otherwise reject — the allowlist and the runtime
surface move together, never one behind the other.

## Network admission limit

The source capability gate constrains this library; it does not intercept the
worker executable's network syscalls. `run_confined_attested` therefore refuses
otherwise admissible execution with `ControlNotEnforceable` before worker I/O or
spawn. The attestation contract has no mode for an unenforced network boundary.
The `attestation` phase of `check-linux-e2e.sh` fails before tests: successful
refusal tests cannot qualify a positive Linux attestation. The `refusal` phase
still requires Linux, no arranged worker identity, a successful process exit
and exactly three executed tests without ignored or filtered cases. Process
and transport mechanics continue to be tested separately in `host_process`.
