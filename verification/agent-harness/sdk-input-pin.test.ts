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
    "a2fc1b2f5fb0bad6414b696e2ee76d8e9203119aa49ca454a8646bc46b566196",
  );
  for (const file of pin.files) {
    expect(file.path.startsWith("/") || file.path.split("/").includes("..")).toBe(false);
    expect(await digest(`${root}/${file.path}`)).toBe(file.sha256);
  }
});
