import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function checked(command: string[]): string {
  const result = Bun.spawnSync(command, { stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error("coverage tool failed");
  return result.stdout.toString();
}

/** Export only the instrumented test binaries declared by Cargo, never stale objects. */
export function testExecutables(artifacts: string): string[] {
  const binaries = new Set<string>();
  for (const line of artifacts.split("\n")) {
    if (!line.trim()) continue;
    const artifact: unknown = JSON.parse(line);
    if (typeof artifact !== "object" || artifact === null)
      throw new Error("invalid Cargo artifact");
    const row = artifact as Record<string, unknown>;
    if (row.reason !== "compiler-artifact") continue;
    const profile = row.profile;
    if (
      typeof profile !== "object" ||
      profile === null ||
      !("test" in profile) ||
      profile.test !== true
    )
      continue;
    if (typeof row.executable !== "string" || !row.executable.startsWith("/"))
      throw new Error("test executable absent");
    binaries.add(row.executable);
  }
  if (binaries.size === 0) throw new Error("no instrumented test executables");
  return [...binaries].sort();
}

if (import.meta.main) {
  try {
    if (process.platform !== "linux" || process.arch !== "x64")
      throw new Error("coverage requires Linux x64");
    const [artifacts, output, ...extra] = process.argv.slice(2);
    if (!artifacts || !output || extra.length)
      throw new Error("usage: export-coverage.ts ARTIFACTS_JSONL OUTPUT_JSON");
    const root = process.cwd();
    const directory = resolve(root, "target/coverage");
    const profiles = readdirSync(directory)
      .filter((file) => file.endsWith(".profraw"))
      .map((file) => resolve(directory, file));
    if (!profiles.length) throw new Error("no raw coverage profiles");
    const binaries = testExecutables(readFileSync(artifacts, "utf8"));
    const sysroot = checked(["rustc", "--print", "sysroot"]).trim();
    const llvm = resolve(sysroot, "lib/rustlib/x86_64-unknown-linux-gnu/bin");
    const merged = resolve(directory, "merged.profdata");
    checked([resolve(llvm, "llvm-profdata"), "merge", "-sparse", ...profiles, "-o", merged]);
    const first = binaries[0];
    if (!first) throw new Error("test executable missing");
    const objects = binaries.slice(1).flatMap((path) => ["-object", path]);
    const sources = checked(["git", "ls-files", "--", "src"])
      .trim()
      .split("\n")
      .filter((path) => path.endsWith(".rs"))
      .map((path) => resolve(root, path));
    if (!sources.length) throw new Error("no tracked runtime sources");
    const report = checked([
      resolve(llvm, "llvm-cov"),
      "export",
      first,
      ...objects,
      `-instr-profile=${merged}`,
      "--sources",
      ...sources,
    ]);
    writeFileSync(output, report);
    console.log("Linux coverage report exported from the current instrumented Cargo artifacts");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "coverage export failed");
    process.exitCode = 1;
  }
}
