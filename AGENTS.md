# Execution Sandbox Agent Rules

## Authority

Attested execution confinement for agent workers (ADR-0018), couche 2 of the
Libre AI constellation. Doctrine lives upstream:
https://raw.githubusercontent.com/libre-ai/project-governance/HEAD/AGENTS.md
Contract vectors come from
https://github.com/libre-ai/schemas-and-contracts at a pinned revision.

## Boundaries

- No confinement decision is delegated to the worker; a control that cannot
  be enforced is a refusal, never a warning followed by execution.
- Process, filesystem and time capabilities stay in `src/host/`;
  `verification/agent-harness/` enforces the capability boundary.
- Scheduling, budgets and liveness belong to
  `libre-ai/execution-continuity-evaluator`; contract shapes are canonical in
  `libre-ai/schemas-and-contracts` (verified projections only here).
- The specification is under Specification Lock (`docs/apps/harness.md`);
  state and exit criteria live in `project.v1.yaml`, never restated here.

## Quality gates

Install through the shared local composition (`docs/development.md`), then
run `bun run check`. Never hide a red test.

## Agents

- Read actual state before editing.
- Stage files before running tree-walking gates.
- Security > quality > performance > completeness.
