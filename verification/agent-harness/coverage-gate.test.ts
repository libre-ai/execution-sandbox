import { expect, test } from "bun:test";
import { checkCoverage } from "./check-coverage";

const root = "/fixture";
const source = new Map([
  ["src/run.rs", "pub fn run() {}\n"],
  ["src/lib.rs", "mod run;\n"],
]);
const baseline = JSON.stringify({
  version: 1,
  target: "aarch64-unknown-linux-gnu",
  files: {
    "src/run.rs": {
      lines: { covered: 9999, count: 10000 },
      functions: { covered: 1, count: 2 },
    },
    "src/lib.rs": {
      nonExecutableSha256: new Bun.CryptoHasher("sha256")
        .update(source.get("src/lib.rs") ?? "")
        .digest("hex"),
    },
  },
});
function report(covered = 9999, count = 10000, functionCovered = 1): unknown {
  return {
    type: "llvm.coverage.json.export",
    version: "3.0.1",
    data: [
      {
        files: [
          {
            filename: `${root}/src/run.rs`,
            summary: {
              lines: { covered, count },
              functions: { covered: functionCovered, count: 2 },
            },
          },
        ],
      },
    ],
  };
}
function run(input: unknown = report(), candidate = baseline, trusted = baseline, files = source) {
  return checkCoverage({
    report: input,
    baseline: candidate,
    trustedBaseline: trusted,
    sourceFiles: files,
    root,
    target: "aarch64-unknown-linux-gnu",
  });
}

test("accepts exact per-file ratios and improvements", () => {
  expect(run()).toEqual([]);
  expect(run(report(10000, 10000, 2))).toEqual([]);
  expect(run(report(19998, 20000))).toEqual([]);
});
test("rejects a decrease hidden by percentage rounding", () => {
  expect(run(report(9998, 9999)).join(" ")).toContain("lines decreased");
});
test("rejects function regression even with full line coverage", () => {
  expect(run(report(10000, 10000, 0)).join(" ")).toContain("functions decreased");
});
test("rejects changed baseline bytes even if the new floor passes", () => {
  const changed = baseline.replace('"covered":9999', '"covered":1');
  expect(run(report(), changed).join(" ")).toContain("baseline differs");
  expect(run(report(), `${baseline}\n`).join(" ")).toContain("baseline differs");
});
test("rejects absent trusted baseline", () => {
  expect(
    checkCoverage({
      report: report(),
      baseline,
      trustedBaseline: null,
      sourceFiles: source,
      root,
      target: "aarch64-unknown-linux-gnu",
    }).join(" "),
  ).toContain("trusted baseline missing");
});
test("rejects missing and duplicate report files", () => {
  expect(run({ type: "llvm.coverage.json.export", data: [{ files: [] }] }).join(" ")).toContain(
    "missing report file",
  );
  const input = report() as { data: { files: unknown[] }[] };
  input.data[0]?.files.push(input.data[0]?.files[0]);
  expect(run(input).join(" ")).toContain("duplicate report file");
});
test("new runtime files cannot evade the baseline by being unreported", () => {
  const files = new Map(source).set("src/new.rs", "pub fn unchecked() {}\n");
  expect(run(report(), baseline, baseline, files).join(" ")).toContain("unbaselined source file");
});
test("removed source and newly executable module files are rejected", () => {
  const removed = new Map(source);
  removed.delete("src/run.rs");
  expect(run(report(), baseline, baseline, removed).join(" ")).toContain("missing source file");
  const changed = new Map(source).set("src/lib.rs", "mod run; pub fn uncovered() {}\n");
  expect(run(report(), baseline, baseline, changed).join(" ")).toContain(
    "non-executable source changed",
  );
});
test("rejects malformed metrics, unsafe integers and invalid exports", () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 10001]) {
    expect(run(report(value)).length).toBeGreaterThan(0);
  }
  expect(run(report(0, 0)).length).toBeGreaterThan(0);
  expect(run({}).length).toBeGreaterThan(0);
});
test("rejects report files outside the declared source root", () => {
  const input = report() as { data: { files: { filename: string }[] }[] };
  const file = input.data[0]?.files[0];
  if (!file) throw new Error("fixture file missing");
  file.filename = "/another/src/run.rs";
  expect(run(input).join(" ")).toContain("outside source root");
});
test("rejects measurements from a different platform", () => {
  expect(
    checkCoverage({
      report: report(),
      baseline,
      trustedBaseline: baseline,
      sourceFiles: source,
      root,
      target: "x86_64-unknown-linux-gnu",
    }).join(" "),
  ).toContain("target differs");
});

test("Cargo artifact inventory rejects empty and absent executables", async () => {
  const { testExecutables } = await import("./export-coverage");
  expect(() => testExecutables('{"reason":"build-finished","success":true}\n')).toThrow(
    "no instrumented",
  );
  expect(() => testExecutables('{"reason":"compiler-artifact","profile":{"test":true}}')).toThrow(
    "test executable absent",
  );
  const artifact =
    '{"reason":"compiler-artifact","profile":{"test":true},"executable":"/fixture/test"}';
  expect(testExecutables(`${artifact}\n${artifact}\n`)).toEqual(["/fixture/test"]);
});
