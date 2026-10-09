import { expect, test } from "bun:test";

const root = "../schemas-and-contracts/crates/sdk-rs";

async function digest(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex");
}

test("local SDK is the reviewed current schemas-and-contracts composition", async () => {
  const pinPath = "docs/dependency-inputs/sdk-input-pin.json";
  const pin: { origin: string; files: Array<{ path: string; sha256: string }> } =
    await Bun.file(pinPath).json();
  expect(pin.origin).toBe("schemas-and-contracts/crates/sdk-rs");
  expect(pin.files.length).toBe(113);
  // The manifest pins the composed revision by git so Dependabot can resolve
  // it; the composition compiles this very sibling checkout in its place.
  const cargo = await Bun.file("Cargo.toml").text();
  expect(cargo).not.toContain('path = "../');
  const declared = cargo.match(
    /git = "https:\/\/github\.com\/libre-ai\/schemas-and-contracts", rev = "([0-9a-f]{40})"/,
  );
  expect(declared?.[1]).toBe(
    Bun.spawnSync(["git", "-C", "../schemas-and-contracts", "rev-parse", "HEAD"])
      .stdout.toString()
      .trim(),
  );
  expect(await digest(pinPath)).toBe(
    "0a5c5a90b879f31b572d91a94202336b960322ef84a26637a96584791def5033",
  );
  for (const file of pin.files) {
    expect(file.path.startsWith("/") || file.path.split("/").includes("..")).toBe(false);
    expect(await digest(`${root}/${file.path}`)).toBe(file.sha256);
  }
});
