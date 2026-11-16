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
  array-of-tables header. Dependency names are read from the parsed manifest, so a quoted or
  dotted key (`"reqwest" = "1"`, `reqwest.version = "1"`) names the same dependency as a bare
  one, and a renamed dependency is named by its package (`serde = { package = "reqwest" }`
  depends on `reqwest`). Alternate dependency tables are also looked for in the parsed manifest,
  so `[ dev-dependencies ]`, `["dev-dependencies"]`, `dev-dependencies = { … }` and
  `target.x.dependencies.y = "1"` are refused like the plain header. A manifest that does not
  parse fails the gate.
- **The gate reads text, and closes a list of spellings, not every spelling.** The source is
  first reduced to a code view: comments, string contents and character literals are removed and
  `r#` is dropped from raw identifiers, so prose and literals neither trigger a ban nor hide one.
  Each literal ban is then matched against that view with `::` spacing removed, and against every
  `use` tree flattened to one path per imported item. The spellings closed this way, each with a
  test: grouped, nested, renamed and multi-line imports (`use std::{fs, io};`,
  `use std::{process::Command as C};`), spaced paths (`use std :: fs;`), `use` glued to its tree
  (`use::std::fs;`, `use{std::fs};`), raw identifiers (`std::r#fs`), a comment inside a path
  (`std::/* x */fs`), and a glob import of `std` (`use std::*;`, refused everywhere as
  `std-glob`). A `use` tree whose braces do not balance, and a file whose comment or string never
  closes, are refused, not skipped. What this does not close is under "Known limits" below.
- **Unsafe code is refused everywhere**, including under `src/host/`. The scan reads the code view (below) with
  attribute lines removed, so a trailing `// forbid(unsafe_code)` comment cannot buy a real
  `unsafe` block an exemption, and the word in a comment or a string does not fail the gate.
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
- **The gate reports its volume.** Every entry under `src/` is listed, dotted files and
  directories included (`#[path = ".h/evil.rs"] mod evil;` compiles a dotted file like any
  other). A pass prints the number of `.rs` files examined, how many of them sit under a dotted
  path, and how many other files under `src/` were not read. Zero `.rs` files is a failure, never
  a pass; a symbolic link under `src/` is a failure, never followed and never skipped.

Every future capability this crate opens edits `check-capabilities.ts` in the same pull request
that adds the dependency or import the gate would otherwise reject — the allowlist and the runtime
surface move together, never one behind the other.

## Known limits

**This gate cannot guarantee the boundary it describes.** It reads Rust as text. Whether a path
reaches `std::fs` is decided by name resolution, which only the compiler performs. Every correction
made here closes one spelling and leaves a next one: the review that closed grouped imports found
the glued `use`, the `std` glob, raw identifiers and the comment inside a path; closing those
leaves the entries below. A green run means "none of the listed spellings was found", not "no
pure module holds a host capability".

Each of the following compiles (rustc 1.97.0, edition 2024) and passes the gate with zero
failure:

| Entry, in a module outside `src/host/` | Why the text does not show it |
| --- | --- |
| `std::path::Path::new("/etc/passwd").exists()`, `Path::new("/").read_dir()` | filesystem access through a method of a type no ban names |
| `pub use std::fs as files;` in `src/host/mod.rs`, then `crate::host::files::read("x")` | the capability is re-exported by the module allowed to hold it; the pure module writes no banned path |
| `macro_rules! p { ($a:ident, $b:ident) => { $a::$b::read("x") }; }` then `p!(std, fs)` | the path is assembled by macro expansion |
| `macro_rules! u { ($($t:tt)*) => { use $($t)*; }; }` then `u!(std::{fs});` | the `use` declaration is assembled by macro expansion; only `env` and `net` are looked for inside a `std::{…}` group outside a declaration |
| `#[path = "../outside/evil.rs"] mod evil;` with `std::fs` and `std::env` in that file | the file is outside `src/`, so it is not listed; `include!` has the same reach |

Further limits of the same reading:

- A file under `src/` that is not `.rs` is counted and never read, whatever `include!` does with it.
- `grouped-std-net` refuses `std::{net::Shutdown}` although `std::net::Shutdown` alone is allowed.
- Doc comments are not code for this gate, so a doctest is not examined; neither is `tests/`.
- A dependency is judged by its package name only. Its source (`git`, `path`, `[patch]`,
  `[replace]`) is not judged by this gate; `deny.toml` carries a separate `sources` policy.

What would hold by construction — a design decision of this repository, not taken here:

- **A compiler-resolved deny list.** Clippy's `disallowed-methods`, `disallowed-types` and
  `disallowed-macros` (in `clippy.toml`) are checked after name resolution, so aliases, globs,
  re-exports, raw identifiers and macro-built paths are the same item to them, and
  `Path::exists` can be listed like `std::fs::read`. Consequences: the lists name items one by one,
  not modules, so every function and type of `std::fs`, `std::process`, `std::thread`, `std::time`
  and `std::env` that matters has to be enumerated, and an item std adds later is open until
  listed; the configuration applies to the whole crate, so `src/host/` needs an
  `#[allow(clippy::disallowed_methods, clippy::disallowed_types)]` on its module, and something
  must then keep that `allow` out of the pure modules (a much narrower text check than this one,
  but still one); the verdict moves from `check:capabilities` to the `cargo clippy` step of
  `check:rust`. Not implemented and not tested in this repository.
- **A crate split.** The pure modules move to a crate declared `#![no_std]` (with `alloc`), which
  cannot name `std` at all; the host capability stays in a second crate that depends on it. This
  is the only option where the compiler itself refuses the import. Consequences: the package
  layout and the public paths of `libre-ai-harness` change; every dependency of the pure part has
  to build without `std`, which has not been checked for the six allowed crates; and the split
  does nothing for the surfaces closed inside the host crate too (`std::env`, sockets), which
  still need the deny list above or a text check. A split without `no_std` separates the files
  and guarantees nothing: any crate can name `std`.

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
