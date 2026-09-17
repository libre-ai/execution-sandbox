import { join } from "node:path";

// Reviewed source identity; updates must change the package pin and these
// independently captured digests together, never regenerate them from copies.
const AUTHORITY_PIN = "file:../schemas-and-contracts";
const FIXTURES = [
  {
    id: "profile",
    path: "contracts/schemas/harness-profile.v2.schema.json",
    sha256: "effbf2f1ff100588df44e37a64f165a0f0261e84b0781054a80c911cf1305634",
  },
  {
    id: "digest",
    path: "contracts/fixtures/agent-orchestration-v1/digest-vectors.v1.json",
    sha256: "f4ab94b10d6a5c5804f4bf8e61db9218a0c9fd765e0a8ed439d2aaf2a93c27c3",
  },
  {
    id: "signature",
    path: "contracts/fixtures/agent-orchestration-v1/signature-vectors.v1.json",
    sha256: "28862f8b808e554d2d18ba1cf250a98e871480b9ee210eb4f23b65f53012703b",
  },
] as const;

export async function checkContractFixtures(
  root = ".",
  authority = join(root, "node_modules/@libre-ai/contracts-authority"),
): Promise<string[]> {
  const failures: string[] = [];
  try {
    const manifest: unknown = await Bun.file(join(root, "package.json")).json();
    const dependencies =
      typeof manifest === "object" && manifest !== null && "devDependencies" in manifest
        ? manifest.devDependencies
        : null;
    if (
      typeof dependencies !== "object" ||
      dependencies === null ||
      !("@libre-ai/contracts-authority" in dependencies) ||
      dependencies["@libre-ai/contracts-authority"] !== AUTHORITY_PIN
    ) {
      failures.push("authority-pin-mismatch");
    }
  } catch {
    failures.push("authority-manifest-unreadable");
  }

  for (const fixture of FIXTURES) {
    for (const [location, directory] of [
      ["fixtures", join(root, "fixtures")],
      ["authority", authority],
    ] as const) {
      try {
        const file = Bun.file(join(directory, fixture.path));
        if (!(await file.exists())) {
          failures.push(`${location}-missing:${fixture.id}`);
          continue;
        }
        const digest = new Bun.CryptoHasher("sha256")
          .update(await file.arrayBuffer())
          .digest("hex");
        if (digest !== fixture.sha256) failures.push(`${location}-digest-mismatch:${fixture.id}`);
      } catch {
        // Do not expose raw filesystem errors, contents or local paths.
        failures.push(`${location}-unreadable:${fixture.id}`);
      }
    }
  }
  return failures;
}

if (import.meta.main) {
  const failures = await checkContractFixtures();
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Contract fixtures match their pinned authority and reviewed digests");
  }
}
