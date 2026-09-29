import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface ProbeCase {
  phase?: "refusal" | "attestation";
  platform?: "Linux" | "Darwin";
  rootUid?: string;
  workerUid?: string;
  workerGid?: string;
  transitionUid?: string;
  transitionExit?: string;
  cargoExit?: string;
  summary?: string;
}

const script = resolve("verification/agent-harness/check-linux-e2e.sh");
const success = "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;";

function probe(options: ProbeCase = {}): { exit: number; testsStarted: boolean } {
  const root = mkdtempSync(join(tmpdir(), "harness-e2e-gate-"));
  const calls = join(root, "tests-started");
  const commands: Record<string, string> = {
    uname: 'printf "%s\\n" "$PROBE_PLATFORM"',
    id: `case "$*" in
  "-u") printf '%s\\n' "$PROBE_ROOT_UID" ;;
  "-u harness-worker") test -n "$PROBE_WORKER_UID" || exit 1; printf '%s\\n' "$PROBE_WORKER_UID" ;;
  "-g harness-worker") test -n "$PROBE_WORKER_GID" || exit 1; printf '%s\\n' "$PROBE_WORKER_GID" ;;
  "harness-worker") test -n "$PROBE_WORKER_UID" ;;
  *) exit 1 ;;
esac`,
    setpriv: 'printf "%s\\n" "$PROBE_TRANSITION_UID"; exit "$PROBE_TRANSITION_EXIT"',
    cargo:
      'printf started > "$PROBE_CALLS"; printf "%s\\n" "$PROBE_SUMMARY"; exit "$PROBE_CARGO_EXIT"',
  };
  try {
    for (const [name, body] of Object.entries(commands)) {
      writeFileSync(join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    }
    const execution = Bun.spawnSync(["/bin/sh", script, options.phase ?? "refusal"], {
      env: {
        PATH: `${root}:/usr/bin:/bin`,
        PROBE_PLATFORM: options.platform ?? "Linux",
        PROBE_ROOT_UID: options.rootUid ?? "0",
        PROBE_WORKER_UID: options.workerUid ?? "",
        PROBE_WORKER_GID: options.workerGid ?? "24001",
        PROBE_TRANSITION_UID: options.transitionUid ?? options.workerUid ?? "",
        PROBE_TRANSITION_EXIT: options.transitionExit ?? "0",
        PROBE_CARGO_EXIT: options.cargoExit ?? "0",
        PROBE_SUMMARY: options.summary ?? success,
        PROBE_CALLS: calls,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const testsStarted = existsSync(calls) && readFileSync(calls, "utf8") === "started";
    return { exit: execution.exitCode, testsStarted };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a refusal run requires Linux before starting tests", () => {
  expect(probe({ platform: "Darwin" })).toEqual({ exit: 1, testsStarted: false });
});

test("a refusal run rejects an already arranged worker identity", () => {
  const result = probe({ phase: "refusal", workerUid: "24001" });
  expect(result.exit).not.toBe(0);
  expect(result.testsStarted).toBe(false);
});

test("zero process exit without all semantic assertions is not green", () => {
  for (const summary of [
    "",
    "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;",
    "test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out;",
  ]) {
    const result = probe({ summary });
    expect(result.exit).not.toBe(0);
  }
});

test("a failing process cannot borrow a successful summary", () => {
  expect(probe({ cargoExit: "1" }).exit).not.toBe(0);
});

test("an equipped host cannot qualify attestation without worker network isolation", () => {
  expect(probe({ phase: "attestation", workerUid: "24001" })).toEqual({
    exit: 1,
    testsStarted: false,
  });
});

test("a refusal run proves the identity is absent and still checks assertions", () => {
  expect(probe({ phase: "refusal", rootUid: "1000", workerUid: "", workerGid: "" })).toEqual({
    exit: 0,
    testsStarted: true,
  });
});
