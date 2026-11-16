import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

// Rust accepts the same path under several spellings; the boundary is on the
// path, so every spelling of a host capability must fail like the plain one.
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
      expect(await checkHarnessCapabilityBoundary(root)).toEqual({ failures: [], sourceFiles: 2 });
      const run = runGate();
      expect(run.stderr.toString()).toBe("");
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toContain("2 source file(s) examined");
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
