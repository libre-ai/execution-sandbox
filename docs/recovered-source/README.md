# harness

Attested execution confinement, couche 2 brick of the Libre AI constellation ([ADR-0018](https://github.com/libre-ai/governance/blob/main/docs/adr/0018-wave-3-opening-orchestrator-and-harness.md)) — the boundary a worker cannot talk its way out of.

Created 2026-08-18 by explicit owner decision (domain F chantier A). The product
specification migrated here from `orchestrator` (ADR-0018 D3, Specification Lock).
The candidate now contains a Rust library for profiles, effective controls,
filesystem policy, bounded outputs and signed attestations, plus local process
execution under `src/host/`. Cargo consumes six explicitly allowlisted
dependencies, including pinned SDK Rust contract types.

Implementation presence is not execution-guard admission. On macOS the confined
execution test checks `PlatformUnsupported`; privileged Linux attested execution
has not been qualified here. Host-process tests do not replace that proof.
Blocking coverage, remote CI qualification and a real Mission Control consumer
remain unestablished. The project card's maturity and pending phases are retained;
its freshness date records this documentation reconciliation.

## Verify

```sh
bun install --frozen-lockfile && bun run check
cargo test --locked
```

The Linux CI recipe first proves the missing-identity refusal path, then creates
an isolated runner identity and requires the privileged attestation journey.
It also verifies that native worker failure and an unbound response return
`WorkerFault` and `RunBindingUnproved` instead of an attestation. The E2E gate
checks the platform, identity transition, process exit and exact executed-test
summary; an empty or skipped test run cannot satisfy it.

Rust checks use tracked contract fixtures and can run without `node_modules`.
`bun run check:contract-fixtures` compares all three fixtures byte-for-byte via
reviewed SHA-256 digests against the pinned Contracts authority. See
[fixture provenance](fixtures/README.md) for the source and update rule.

## État du projet

<!-- libre-ai:project-status:begin -->
<!-- Section générée depuis project.v1.yaml — ne pas éditer à la main. -->

- Situation actuelle : Le candidat contient le cœur de profil, contrôles et attestation ainsi qu'un runtime hôte, et non plus seulement le bootstrap sans effet. La réconciliation e724b589 a conservé cette surface et réparé les assertions et entrées de test contractuelles. La présente actualisation est documentaire : la maturité, l'exposition et les trois phases pending sont conservées, sans décision de livraison implicite. Les tests macOS du confinement attesté vérifient PlatformUnsupported ; le parcours Linux privilégié, la couverture bloquante et l'intégration Mission Control restent non qualifiés ici.
- Maturité : specified
- Exposition : spec-published
- Confiance : medium
- Preuves vérifiées le : 2026-09-12
- Avancement : 0 % du périmètre actuellement déclaré

<!-- libre-ai:project-status:end -->

La fiche [`project.v1.yaml`](./project.v1.yaml) est l'autorité de l'état du projet ; cette section en est générée et le gate de flotte échoue si elles divergent.


Coverage policy requires non-regression of the exact line and function ratios
for each executable Rust source file on Linux x64. The candidate CI recipe
instruments the full suite and both mandatory Linux journey phases, then
exports only tracked runtime sources using the Rust toolchain's LLVM tools.
It does not claim branch coverage. Source inventory is exhaustive: missing
reports and new source files fail; module-only files without emitted coverage
regions require an unchanged source digest rather than fabricated percentages.

`check-coverage.ts` compares integer cross-products, so rounding cannot hide a
decrease. It also requires baseline bytes to match the pull request's base
revision. Initial introduction requires the exact digest of an independently
reviewed Linux x64 baseline; an absent artifact or digest fails closed. The
initial measurement is pending; no ARM64 or macOS ratios substitute for it.

This is candidate CI enforcement. Repository branch protection and independent
workflow-review enforcement have not been established; a pull request able to
change the workflow can also change its checks. The baseline comparison alone
does not establish remote admission or approval of baseline updates.
