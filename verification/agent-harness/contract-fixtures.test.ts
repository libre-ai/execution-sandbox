import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkContractFixtures } from "./check-contract-fixtures";

let root: string;
const schema = "contracts/schemas/harness-profile.v2.schema.json";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-fixtures-"));
  await cp("fixtures", join(root, "fixtures"), { recursive: true });
  await mkdir(join(root, "authority"));
  await cp("fixtures/contracts", join(root, "authority/contracts"), { recursive: true });
  await cp("package.json", join(root, "package.json"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("accepts exact fixture bytes and the pinned authority", async () => {
  expect(await checkContractFixtures(root, join(root, "authority"))).toEqual([]);
});

test.each(["fixtures", "authority"])("rejects altered bytes in %s", async (location) => {
  await Bun.write(join(root, location, schema), "{}\n");
  expect(await checkContractFixtures(root, join(root, "authority"))).toContain(
    `${location}-digest-mismatch:profile`,
  );
});

test.each(["fixtures", "authority"])("rejects missing inputs in %s", async (location) => {
  await rm(join(root, location, schema));
  expect(await checkContractFixtures(root, join(root, "authority"))).toContain(
    `${location}-missing:profile`,
  );
});

test("rejects synchronized tampering in both copies", async () => {
  for (const location of ["fixtures", "authority"]) {
    await Bun.write(join(root, location, schema), "{}\n");
  }
  const failures = await checkContractFixtures(root, join(root, "authority"));
  expect(failures).toContain("fixtures-digest-mismatch:profile");
  expect(failures).toContain("authority-digest-mismatch:profile");
});

test("rejects a changed package pin even with unchanged fixture bytes", async () => {
  await Bun.write(join(root, "package.json"), JSON.stringify({ devDependencies: {} }));
  expect(await checkContractFixtures(root, join(root, "authority"))).toContain(
    "authority-pin-mismatch",
  );
});

test("checks all fixtures, including independent signature and digest vectors", async () => {
  for (const name of ["digest", "signature"]) {
    await Bun.write(
      join(root, `fixtures/contracts/fixtures/agent-orchestration-v1/${name}-vectors.v1.json`),
      "{}\n",
    );
  }
  const failures = await checkContractFixtures(root, join(root, "authority"));
  expect(failures).toContain("fixtures-digest-mismatch:digest");
  expect(failures).toContain("fixtures-digest-mismatch:signature");
});
