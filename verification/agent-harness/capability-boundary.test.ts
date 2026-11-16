import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkHarnessCapabilityBoundary,
  dependencyNames,
  forbiddenDependencySections,
  forbiddenEverywhere,
  forbiddenOutsideHost,
} from "./check-capabilities";

describe("WP-G3-H01 harness capability boundary", () => {
  test("confines the host capability to src/host and keeps the closed surfaces closed", async () => {
    const report = await checkHarnessCapabilityBoundary();
    expect(report.failures).toEqual([]);
    expect(report.sourceFiles).toBeGreaterThan(0);
  });

  test.each([
    "use std::net::TcpStream;",
    "use std::env;",
    'let key = std::env::var("SECRET");',
    "tokio::spawn(async {});",
    "use std as platform;",
    'extern "C" { fn effect(); }',
    "unsafe { effect(); }",
  ])("closed everywhere, host included: %s", (source) => {
    expect(forbiddenEverywhere("src/host/process.rs", source).length).toBeGreaterThan(0);
  });

  test.each([
    "use std::process::Command;",
    "use std::fs;",
    "std::os::unix::net::UnixStream::pair()",
    "let started = Instant::now();",
    "OpenOptions::new()",
  ])("host capability refused outside src/host: %s", (source) => {
    expect(forbiddenOutsideHost("src/profile.rs", source).length).toBeGreaterThan(0);
  });

  // The array-of-tables header is a section too: missing it left the parser
  // inside [dependencies] and read the block's keys as dependency names.
  test("an array-of-tables header closes the dependency section", () => {
    const manifest = [
      "[dependencies]",
      'serde = "=1.0.228"',
      "",
      "[[bench]]",
      'name = "glob"',
      "harness = false",
    ].join("\n");
    expect(dependencyNames(manifest)).toEqual(["serde"]);
  });

  test.each([
    "use std::process::Command;",
    "use std::fs;",
    "std::os::unix::net::UnixStream::pair()",
  ])("host capability allowed under src/host: %s", (source) => {
    expect(forbiddenOutsideHost("src/host/process.rs", source)).toEqual([]);
  });

  // xhigh review of f27b3c9: the exemption was a substring test, so a
  // trailing comment bought real unsafe a pass, and prose containing the
  // word failed the gate.
  // The `verifyOsPeer` argument by construction is only as good as the ban
  // that keeps a named socket out of the crate.
  test.each([
    "UnixListener::bind(path)",
    'listener.bind("/tmp/s")',
  ])("a named socket is refused even inside src/host: %s", (source) => {
    expect(forbiddenEverywhere("src/host/process.rs", source).length).toBeGreaterThan(0);
  });

  test("the anonymous pair the harness actually uses stays allowed", () => {
    expect(forbiddenEverywhere("src/host/process.rs", "UnixStream::pair()")).toEqual([]);
  });

  test("real unsafe cannot buy an exemption with a comment", () => {
    expect(
      forbiddenEverywhere("src/host/process.rs", "unsafe { syscall(); } // forbid(unsafe_code)")
        .length,
    ).toBeGreaterThan(0);
  });

  test("the crate-level attribute and prose about unsafety do not fire", () => {
    expect(forbiddenEverywhere("x.rs", "#![forbid(unsafe_code)]")).toEqual([]);
    expect(forbiddenEverywhere("x.rs", "/// widening this path would be unsafe")).toEqual([]);
    expect(forbiddenEverywhere("x.rs", "// an unsafe block here would be refused")).toEqual([]);
  });

  test.each([
    "[dev-dependencies]",
    "[build-dependencies]",
    "[dependencies.reqwest]",
    "[target.'cfg(unix)'.dependencies]",
  ])("detects forbidden dependency section: %s", (manifest) => {
    expect(forbiddenDependencySections(manifest).length).toBeGreaterThan(0);
  });
});

// Rust accepts the same path under several spellings. The gate reads text,
// so it closes the spellings listed here and in the blocks below, not every
// spelling: README, "Known limits".
describe("host capability spellings and gate volume", () => {
  test.each([
    ["grouped import", "use std::{fs, io};", "std::fs"],
    ["nested grouped import", "use std::{io::{self, Read}, time::Duration};", "std::time"],
    ["grouped and renamed import", "use std::{process::Command as C};", "std::process"],
    ["spaced path", "use std :: fs;", "std::fs"],
    ["spaced path in an expression", "let bytes = std :: fs\n    :: read(path);", "std::fs"],
    [
      "multi-line grouped import",
      "pub use std::{\n    io,\n    thread, // worker\n};",
      "std::thread",
    ],
  ])("%s is refused outside src/host: %s", (_label, source, capability) => {
    expect(forbiddenOutsideHost("src/profile.rs", source)).toContain(
      `host-capability-outside-host:src/profile.rs:${capability}`,
    );
  });

  test.each([
    "use std::{fs, io};",
    "use std::{process::Command as C};",
    "use std :: fs;",
  ])("the same spelling stays allowed under src/host: %s", (source) => {
    expect(forbiddenOutsideHost("src/host/process.rs", source)).toEqual([]);
    expect(forbiddenEverywhere("src/host/process.rs", source)).toEqual([]);
  });

  test("imports that name no host capability stay allowed outside src/host", () => {
    const source = "use std::path::{Path, PathBuf};\nuse serde_json::{Value, json};";
    expect(forbiddenOutsideHost("src/profile.rs", source)).toEqual([]);
    expect(forbiddenEverywhere("src/profile.rs", source)).toEqual([]);
  });

  test.each([
    ["use tokio::{spawn, task};", "tokio::"],
    ["use std::{self as platform};", "std-alias"],
    ["use std::{fs, io;", "use-tree-unparseable"],
  ])("closed everywhere under a grouped spelling: %s", (source, label) => {
    expect(forbiddenEverywhere("src/host/process.rs", source)).toContain(
      `capability-forbidden:src/host/process.rs:${label}`,
    );
  });

  test.each([
    '"reqwest" = "1"',
    "'reqwest' = \"1\"",
    '"reqwest".version = "1"',
    'Reqwest = "1"',
  ])("a dependency key is read whatever its quoting: %s", (line) => {
    const manifest = ["[dependencies]", 'serde = "=1.0.228"', line].join("\n");
    expect(dependencyNames(manifest)).toEqual(["serde", line.replace(/^["']?(\w+).*$/u, "$1")]);
  });

  describe("on a fixture crate", () => {
    let root: string;
    const gate = join(import.meta.dir, "check-capabilities.ts");
    // The child inherits nothing: an ambient variable must not decide the verdict.
    const runGate = () =>
      Bun.spawnSync([process.execPath, gate], {
        cwd: root,
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      });

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "harness-capabilities-"));
      await Bun.write(join(root, "Cargo.toml"), '[dependencies]\nserde = "1"\n');
      await Bun.write(join(root, "src/lib.rs"), "mod host;\n");
      await Bun.write(join(root, "src/host/mod.rs"), "use std::{fs, process::Command};\n");
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test("a conforming crate passes and reports the files it examined", async () => {
      expect(await checkHarnessCapabilityBoundary(root)).toEqual({
        failures: [],
        sourceFiles: 2,
        dottedSourceFiles: 0,
        otherFiles: 0,
      });
      const run = runGate();
      expect(run.stderr.toString()).toBe("");
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toContain("2 source file(s) examined");
    });

    // `#[path = ".h/evil.rs"] mod evil;` compiles a dotted file like any
    // other: it is examined, and counted apart so the volume says so.
    test("dotted files and directories under src are examined and counted apart", async () => {
      await Bun.write(join(root, "src/.h/evil.rs"), "use std::fs;\n");
      await Bun.write(join(root, "src/.dot.rs"), "use std::env;\n");
      const report = await checkHarnessCapabilityBoundary(root);
      expect(report.failures).toEqual([
        "capability-forbidden:src/.dot.rs:std::env",
        "capability-forbidden:src/.dot.rs:spaced-std-env",
        "host-capability-outside-host:src/.h/evil.rs:std::fs",
      ]);
      expect(report.sourceFiles).toBe(4);
      expect(report.dottedSourceFiles).toBe(2);
      expect(runGate().exitCode).toBe(1);
    });

    test("a pass prints the dotted files it examined and the files it did not read", async () => {
      await Bun.write(join(root, "src/.hidden/pure.rs"), "pub fn f() {}\n");
      await Bun.write(join(root, "src/notes.txt"), "use std::fs;\n");
      await Bun.write(join(root, "src/.cache/data.bin"), "\n");
      expect(await checkHarnessCapabilityBoundary(root)).toEqual({
        failures: [],
        sourceFiles: 3,
        dottedSourceFiles: 1,
        otherFiles: 2,
      });
      const run = runGate();
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toContain(
        "3 source file(s) examined (1 under a dotted path), 2 other file(s) under src not examined",
      );
    });

    // A link is not followed: its target may sit outside src, and the
    // verdict would be attributed to a path the gate did not read.
    test.each([
      ["src/link.rs", "outside/evil.rs"],
      ["src/linked", "outside"],
    ])("a symbolic link under src is a failure, never a skip: %s", async (link, target) => {
      await Bun.write(join(root, "outside/evil.rs"), "use std::env;\n");
      await symlink(join(root, target), join(root, link));
      const report = await checkHarnessCapabilityBoundary(root);
      expect(report.failures).toEqual([`source-link-not-examined:${link}`]);
      expect(report.sourceFiles).toBe(2);
      expect(runGate().exitCode).toBe(1);
    });

    test("a renamed dependency outside the allowlist fails the whole gate", async () => {
      await Bun.write(
        join(root, "Cargo.toml"),
        '[dependencies]\nserde = { package = "reqwest", version = "1" }\n',
      );
      expect((await checkHarnessCapabilityBoundary(root)).failures).toEqual([
        "dependency-not-allowed:reqwest",
      ]);
      expect(runGate().exitCode).toBe(1);
    });

    test("an alternate dependency table under a spaced header fails the whole gate", async () => {
      await Bun.write(
        join(root, "Cargo.toml"),
        '[dependencies]\nserde = "1"\n\n[ dev-dependencies ]\nreqwest = "1"\n',
      );
      expect((await checkHarnessCapabilityBoundary(root)).failures).toEqual([
        "dependency-section-forbidden:dev-dependencies",
      ]);
    });

    // Present and readable, but not TOML: nothing can be said about its
    // dependencies, so the gate must not answer "none".
    test("a manifest that does not parse is a failure", async () => {
      await Bun.write(join(root, "Cargo.toml"), "[dependencies\nserde = \n");
      await expect(checkHarnessCapabilityBoundary(root)).rejects.toThrow();
      const run = runGate();
      expect(run.exitCode).not.toBe(0);
      expect(run.stdout.toString()).toBe("");
    });

    test("a grouped host import in a pure module fails the whole gate", async () => {
      await Bun.write(join(root, "src/profile.rs"), "use std::{fs, io};\n");
      expect((await checkHarnessCapabilityBoundary(root)).failures).toEqual([
        "host-capability-outside-host:src/profile.rs:std::fs",
      ]);
      expect(runGate().exitCode).toBe(1);
    });

    test("a quoted dependency key outside the allowlist fails the whole gate", async () => {
      await Bun.write(join(root, "Cargo.toml"), '[dependencies]\n"reqwest" = "1"\n');
      expect((await checkHarnessCapabilityBoundary(root)).failures).toEqual([
        "dependency-not-allowed:reqwest",
      ]);
    });

    test.each([
      "src/bin/tool.rs",
      "src/bin/.keep",
      "src/main.rs",
      "build.rs",
    ])("a runtime entry is refused: %s", async (entry) => {
      await Bun.write(join(root, entry), "\n");
      const expected = entry.startsWith("src/bin/") ? "src/bin" : entry;
      expect((await checkHarnessCapabilityBoundary(root)).failures).toContain(
        `runtime-entry-forbidden:${expected}`,
      );
    });

    test("zero source files is a failure, never a pass", async () => {
      await rm(join(root, "src"), { recursive: true });
      expect(await checkHarnessCapabilityBoundary(root)).toEqual({
        failures: ["runtime-source-missing"],
        sourceFiles: 0,
        dottedSourceFiles: 0,
        otherFiles: 0,
      });
      const run = runGate();
      expect(run.exitCode).toBe(1);
      expect(run.stderr.toString()).toContain("runtime-source-missing");
      expect(run.stdout.toString()).toBe("");
    });

    test("an unreadable manifest is a failure", async () => {
      await rm(join(root, "Cargo.toml"));
      await expect(checkHarnessCapabilityBoundary(root)).rejects.toThrow();
      expect(runGate().exitCode).not.toBe(0);
    });
  });
});

// Review of 4f46ffe. The gate reads a lexed view of the source: comments
// and literal contents are not code, and a ban must neither fire on them nor
// be evaded through them.
describe("the gate reads code, not prose", () => {
  test.each([
    [
      "the word in a doc comment",
      "/// Callers use this to parse.\npub fn parse(input: &str) -> Value { inner(input); }",
    ],
    ["the word in a string", 'fn f() { let m = "do not use {} here"; g(m); }'],
    ["an unbalanced tree in a line comment", "// use std::{fs\nfn f() { g(); }"],
    ["an unbalanced tree in a raw string", 'fn f() { let s = r#"use std::{fs;"#; g(s); }'],
    ["a nested block comment", "/* outer /* inner */ use std::{fs; */\nfn f() { g(); }"],
    ["a quote held by a char literal", 'fn f() { let q = \'"\'; let m = "use {"; g(q, m); }'],
    ["a precise capture", "fn f<'a>(x: &'a str) -> impl Sized + use<'a> { g(x); x }"],
    ["a raw identifier named use", "fn r#use() { g(); }"],
    ["a macro matcher holding the keyword", "macro_rules! m { (use $x:ident) => { g($x); }; }"],
    [
      "prose naming a closed surface",
      "/// Neither std::fs nor TcpStream is reachable from here.\nfn f() { g(); }",
    ],
    ["a string naming a closed surface", 'const HINT: &str = "std::env is closed; tokio:: too";'],
    ["unsafety named in a string", 'const HINT: &str = "an unsafe default";'],
    ["unsafety named in a block comment", "/*\n unsafe here is prose\n*/\nfn f() { g(); }"],
    [
      "an identifier named env after a std group",
      "use std::{fmt, io};\nfn f(env: u8, net: u8) -> u8 { env + net }",
    ],
  ])("conforming code is not refused: %s", (_label, source) => {
    expect(forbiddenOutsideHost("src/profile.rs", source)).toEqual([]);
    expect(forbiddenEverywhere("src/profile.rs", source)).toEqual([]);
  });

  test("a semicolon in a comment inside a use tree does not cut the tree", () => {
    const source = "use std::{\n    io, // a; b\n    fs,\n};";
    expect(forbiddenOutsideHost("src/profile.rs", source)).toEqual([
      "host-capability-outside-host:src/profile.rs:std::fs",
    ]);
    expect(forbiddenEverywhere("src/profile.rs", source)).toEqual([]);
  });

  test.each([
    ["block comment inside a use tree", "use std::{io, /* x */ fs};", "std::fs"],
    ["block comment inside a use path", "use std::/* x */fs;", "std::fs"],
    [
      "block comment inside an expression path",
      "fn f(p: &str) { std::/* x */fs::read(p); }",
      "std::fs",
    ],
    [
      "line comment inside an expression path",
      "fn f(p: &str) { std:: // why\n    thread::yield_now(); }",
      "std::thread",
    ],
    ["use glued to its path", "use::std::{fs, io};", "std::fs"],
    ["use glued to its group", "use{std::{fs, io}};", "std::fs"],
    ["raw identifier in a use path", "use std::r#fs;", "std::fs"],
    ["raw identifier in a group", "use std::{r#fs, io};", "std::fs"],
    ["raw identifiers in an expression path", "fn f(p: &str) { r#std::r#fs::read(p); }", "std::fs"],
  ])("%s is refused outside src/host: %s", (_label, source, capability) => {
    expect(forbiddenOutsideHost("src/profile.rs", source)).toContain(
      `host-capability-outside-host:src/profile.rs:${capability}`,
    );
  });

  test.each([
    ['fn f() { std::/**/env::var("S"); }', "std::env"],
    ["use std::r#env;", "std::env"],
    ["use std::{self as r#p};", "std-alias"],
    ["use std::*;", "std-glob"],
    ["use std::{*};", "std-glob"],
    ["use ::std::*;", "std-glob"],
    ["pub use std :: * ;", "std-glob"],
    ["use {std::{self, *}};", "std-glob"],
    ["use r#std::*;", "std-glob"],
    ["import!(std::{io::{self, Read}, env});", "grouped-std-env"],
    ["import!(std::{io, net::{TcpStream}});", "grouped-std-net"],
    ["import!(std::{io, env", "grouped-std-env"],
    ['fn f() { let s = "never closed; }', "source-unlexable"],
    ["fn f() {} /* never closed", "source-unlexable"],
    ['fn f() { let s = r#"closed by the wrong fence"; }', "source-unlexable"],
  ])("closed everywhere, host included: %s", (source, label) => {
    expect(forbiddenEverywhere("src/host/process.rs", source)).toContain(
      `capability-forbidden:src/host/process.rs:${label}`,
    );
  });

  test.each([
    "/* reviewed */ unsafe { effect(); }",
    'let hint = "safe"; unsafe { effect(); }',
  ])("real unsafe next to prose is still refused: %s", (source) => {
    expect(forbiddenEverywhere("src/host/process.rs", source)).toEqual([
      "unsafe-forbidden:src/host/process.rs",
    ]);
  });

  test("a glob that brings no closed surface in scope stays allowed", () => {
    const source = "use std::io::*;\nuse super::*;\nuse serde_json::*;";
    expect(forbiddenEverywhere("src/profile.rs", source)).toEqual([]);
    expect(forbiddenOutsideHost("src/profile.rs", source)).toEqual([]);
  });
});

describe("the manifest is judged as Cargo resolves it", () => {
  test.each([
    'serde = { package = "reqwest", version = "1" }',
    'serde.package = "reqwest"',
  ])("a renamed dependency is named by its package: %s", (line) => {
    expect(dependencyNames(["[dependencies]", line].join("\n"))).toEqual(["reqwest"]);
  });

  test("a renamed dependency declared as a table is named by its package", () => {
    expect(dependencyNames('[dependencies.serde]\npackage = "reqwest"')).toEqual(["reqwest"]);
  });

  test.each([
    ['[ dev-dependencies ]\nreqwest = "1"', "dev-dependencies"],
    ['["dev-dependencies"]\nreqwest = "1"', "dev-dependencies"],
    ['dev-dependencies = { reqwest = "1" }', "dev-dependencies"],
    ['[dev_dependencies]\nreqwest = "1"', "dev_dependencies"],
    ['target.x.dependencies.y = "1"', "target.x.dependencies"],
    ['[workspace]\ndependencies = { reqwest = "1" }', "workspace.dependencies"],
  ])("an alternate dependency table is refused whatever its spelling: %s", (manifest, path) => {
    expect(forbiddenDependencySections(manifest)).toEqual([`dependency-section-forbidden:${path}`]);
  });

  test.each([
    "[dev-dependencies]",
    "[target.'cfg(unix)'.dependencies]\nreqwest = \"1\"",
    "[target.'cfg(target_os = \"linux\")'.build-dependencies]",
  ])("a section seen both ways is reported once: %s", (manifest) => {
    expect(forbiddenDependencySections(manifest)).toHaveLength(1);
  });

  test("the allowed section alone is not refused", () => {
    expect(
      forbiddenDependencySections('[package]\nname = "x"\n\n[dependencies]\nserde = "1"'),
    ).toEqual([]);
  });
});
