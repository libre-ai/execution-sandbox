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
  expect(await Bun.file("Cargo.toml").text()).toContain(`path = "${root}"`);
  expect(await digest(pinPath)).toBe(
    "0a5c5a90b879f31b572d91a94202336b960322ef84a26637a96584791def5033",
  );
  for (const file of pin.files) {
    expect(file.path.startsWith("/") || file.path.split("/").includes("..")).toBe(false);
    expect(await digest(`${root}/${file.path}`)).toBe(file.sha256);
  }
});
