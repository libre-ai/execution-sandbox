import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const BASELINE_PATH = "verification/agent-harness/coverage-baseline.json";
// Filled only after the first successful Linux x64 measurement is independently
// reviewed. A missing artifact or approval digest cannot bootstrap itself.
const INITIAL_BASELINE_SHA256: string | null = null;

interface CoverageInput {
  report: unknown;
  baseline: string;
  trustedBaseline: string | null;
  sourceFiles: ReadonlyMap<string, string>;
  root: string;
  target: string;
}
interface Metric {
  covered: number;
  count: number;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid coverage object");
  }
  return value as Record<string, unknown>;
}
function metric(value: unknown): Metric {
  const row = object(value);
  const covered = row.covered;
  const count = row.count;
  if (
    typeof covered !== "number" ||
    typeof count !== "number" ||
    !Number.isSafeInteger(covered) ||
    !Number.isSafeInteger(count) ||
    covered < 0 ||
    count <= 0 ||
    covered > count
  ) {
    throw new Error("invalid coverage metric");
  }
  return { covered, count };
}
function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
function sourcePath(path: string): boolean {
  return /^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.rs$/.test(path);
}

/** The trusted baseline comes from the event's Git base, never the PR file. */
export function checkCoverage(input: CoverageInput): string[] {
  const errors: string[] = [];
  if (input.trustedBaseline === null) {
    if (INITIAL_BASELINE_SHA256 === null || digest(input.baseline) !== INITIAL_BASELINE_SHA256) {
      errors.push("trusted baseline missing: reviewed bootstrap digest required");
    }
  } else if (input.baseline !== input.trustedBaseline) {
    errors.push("baseline differs from the trusted base revision");
  }
  try {
    const baseline = object(JSON.parse(input.baseline));
    if (baseline.version !== 1) throw new Error("invalid baseline version");
    if (baseline.target !== input.target) errors.push("coverage target differs from baseline");
    const files = object(baseline.files);
    if (Object.keys(files).length === 0) throw new Error("empty baseline inventory");
    for (const path of input.sourceFiles.keys()) {
      if (!Object.hasOwn(files, path)) errors.push(`unbaselined source file: ${path}`);
    }
    const report = object(input.report);
    if (
      report.type !== "llvm.coverage.json.export" ||
      !Array.isArray(report.data) ||
      report.data.length !== 1
    ) {
      throw new Error("invalid LLVM coverage export");
    }
    const rows = object(report.data[0]).files;
    if (!Array.isArray(rows)) throw new Error("invalid LLVM file inventory");
    const reported = new Map<string, Record<string, unknown>>();
    for (const entry of rows) {
      const row = object(entry);
      if (typeof row.filename !== "string") throw new Error("invalid report filename");
      const path = relative(resolve(input.root), resolve(row.filename));
      if (!sourcePath(path)) {
        errors.push("report file outside source root");
        continue;
      }
      if (reported.has(path)) errors.push(`duplicate report file: ${path}`);
      if (!Object.hasOwn(files, path)) errors.push(`unbaselined report file: ${path}`);
      reported.set(path, object(row.summary));
    }
    for (const [path, entry] of Object.entries(files)) {
      if (!sourcePath(path)) throw new Error("invalid baseline source path");
      const source = input.sourceFiles.get(path);
      if (source === undefined) errors.push(`missing source file: ${path}`);
      const row = object(entry);
      if (Object.hasOwn(row, "nonExecutableSha256")) {
        if (
          Object.keys(row).length !== 1 ||
          typeof row.nonExecutableSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.nonExecutableSha256)
        ) {
          throw new Error("invalid non-executable baseline entry");
        }
        if (source !== undefined && digest(source) !== row.nonExecutableSha256) {
          errors.push(`non-executable source changed: ${path}`);
        }
        if (reported.has(path)) errors.push(`non-executable source now reported: ${path}`);
        continue;
      }
      const actual = reported.get(path);
      if (actual === undefined) errors.push(`missing report file: ${path}`);
      for (const kind of ["lines", "functions"] as const) {
        const expected = metric(row[kind]);
        if (actual === undefined) continue;
        const observed = metric(actual[kind]);
        // Cross multiplication with integers detects decreases hidden by
        // rounded percentages and avoids Number multiplication overflow.
        if (
          BigInt(observed.covered) * BigInt(expected.count) <
          BigInt(expected.covered) * BigInt(observed.count)
        ) {
          errors.push(`${path}: ${kind} decreased`);
        }
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "invalid coverage input");
  }
  return errors;
}

function sourceFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  function visit(directory: string): void {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("symlink in runtime source inventory");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith(".rs"))
        files.set(path, readFileSync(resolve(root, path), "utf8"));
    }
  }
  visit("src");
  return files;
}

if (import.meta.main) {
  try {
    const [reportPath, baseRevision, ...extra] = process.argv.slice(2);
    if (!reportPath || !baseRevision || extra.length || !/^[a-f0-9]{40}$/.test(baseRevision)) {
      throw new Error("usage: check-coverage.ts REPORT BASE_COMMIT_SHA");
    }
    if (process.platform !== "linux" || process.arch !== "x64")
      throw new Error("coverage requires Linux x64");
    const root = process.cwd();
    const tree = Bun.spawnSync([
      "git",
      "ls-tree",
      "--name-only",
      baseRevision,
      "--",
      BASELINE_PATH,
    ]);
    if (tree.exitCode !== 0) throw new Error("trusted base revision unavailable");
    let trustedBaseline: string | null = null;
    if (tree.stdout.toString().trim() !== "") {
      const show = Bun.spawnSync(["git", "show", `${baseRevision}:${BASELINE_PATH}`]);
      if (show.exitCode !== 0) throw new Error("trusted baseline unreadable");
      trustedBaseline = show.stdout.toString();
    }
    const errors = checkCoverage({
      report: JSON.parse(readFileSync(reportPath, "utf8")),
      baseline: readFileSync(BASELINE_PATH, "utf8"),
      trustedBaseline,
      sourceFiles: sourceFiles(root),
      root,
      target: "x86_64-unknown-linux-gnu",
    });
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("Per-file Linux line/function coverage verified against the trusted baseline");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "coverage gate failed");
    process.exitCode = 1;
  }
}
