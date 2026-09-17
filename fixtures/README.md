# Contract test inputs

These byte-exact copies come from `libre-ai/contracts` commit
`af6ea32c48bd470694e9bf5f8787f417f8a781a6`, the exact package.json authority pin.
They preserve the upstream paths beneath this directory and retain Apache-2.0
licensing (2026 Libre AI contributors; see REUSE.toml and LICENSES). They are
read-only test inputs, not a contract authority or a replacement schema.

Rust tests consume the tracked schema and independent digest/signature vectors
without a Bun installation. `bun run check:contract-fixtures` rejects missing
inputs, drift in either copy, coordinated drift of both copies, and a changed
package pin. It compares to independently recorded SHA-256 values in the gate.
The canonical `bun run check` executes this gate and its negative tests.

For a contract update, select and review the exact upstream revision first;
update the package pin/lock and copy these three paths byte-exact from that
revision. Recalculate digests from the upstream Git objects, update the gate,
and rerun all Rust and Bun checks. Never format these copies or derive expected
digests from an already edited local copy.
