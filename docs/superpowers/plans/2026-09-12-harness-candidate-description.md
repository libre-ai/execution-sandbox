# Harness candidate documentation reconciliation

Base: `e724b589e02c5b68697ba9180452eeb3912e7dc4`.

## Scope and evidence

Reconcile README, project card and agent instructions with the existing library
exports, Cargo dependencies, capability gate and tracked fixture provenance.
This is documentation only: no runtime capability, dependency pin, locked
specification, phase criterion/status, maturity, exposure or confidence changes.
The earlier bootstrap description is obsolete; implementation presence does not
close the pending qualification phases.

## Steps

1. Inspect the exact base, local instructions, immutable reconciliation evidence,
   library exports, manifest and capability gate; run the Rust baseline.
2. Describe the implemented candidate and its actual dependency/host boundary.
   Preserve the missing privileged Linux execution proof, coverage/remote-CI
   gaps and absence of runtime admission or Mission Control integration proof.
3. Generate the README status section from the edited card using the existing
   pinned Governance `renderStatusSection` function; validate card and drift.
4. Stage only these documentation changes, run the tree-walking Bun gates and
   Rust tests, and compare all other Git entries to the exact base. Commit
   locally with DCO, unsigned, for independent review; do not publish.

## Acceptance

- No claim that runtime is absent, dependencies are empty, or contracts are not
  consumed remains in the three corrected descriptions.
- `maturity`, `confidence`, `exposure`, scope stability and all phase records
  retain their base values. The freshness date denotes documentation review,
  not a new Linux or runtime qualification.
- The generated README block equals the canonical renderer output.
- Linux privileged confinement remains explicitly unqualified: macOS exercises
  `PlatformUnsupported`, not the Linux success path.
- Runtime, Cargo/Bun manifests and locks, fixtures, gates and locked product
  specification retain their exact base bytes and Git modes.
