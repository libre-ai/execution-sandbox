<!-- SPDX-FileCopyrightText: 2026 Libre AI contributors -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Written for the retained Libre AI portfolio on 2026-09-14; earlier source documents and revisions retain their original licensing. -->

# Libre AI Execution Sandbox

[Français](README.fr.md)

Developers running automated workers need to specify which resources a workload may use and understand how it ended. This project explores execution within an explicit confinement profile. It brings together filesystem and network access, resource limits and interruption handling for workloads whose operating conditions need to be controlled.

## Intended uses

- Restrict a worker’s filesystem and network access to a defined scope.
- Set resource limits appropriate to the workload and its target platform.
- Stop interrupted work and check which cleanup actions have actually completed.

## Availability

<!-- libre-ai:project-status:begin -->
<!-- Section générée depuis project.v1.yaml — ne pas éditer à la main. -->

- Situation actuelle : Le candidat contient le cœur de profil, contrôles et attestation ainsi qu'un runtime hôte, et non plus seulement le bootstrap sans effet. La réconciliation e724b589 a conservé cette surface et réparé les assertions et entrées de test contractuelles. La présente actualisation est documentaire : la maturité, l'exposition et les trois phases pending sont conservées, sans décision de livraison implicite. Les tests macOS du confinement attesté vérifient PlatformUnsupported ; le parcours Linux privilégié, la couverture bloquante et l'intégration Mission Control restent non qualifiés ici.
- Maturité : specified
- Exposition : spec-published
- Confiance : medium
- Preuves vérifiées le : 2026-09-12
- Avancement : 0 % du périmètre actuellement déclaré

<!-- libre-ai:project-status:end -->

Source code and tests are available in this repository; no package is published to a registry.

Attested execution currently refuses before starting a worker: the process engine
cannot enforce either network mode required by the attestation contract. A
supported Linux host receives `harness.control_not_enforceable`; unsupported
platforms retain `harness.platform_unsupported`. The lower-level process API
applies identity, time and output controls, but does not isolate the worker's
filesystem or network access. Passing its tests does not qualify a sandbox for
untrusted workloads, Linux attestation or a coverage baseline. The Linux
`attestation` qualification phase remains explicitly unavailable.

Explore the [Libre AI project catalogue](https://github.com/libre-ai/.github/blob/main/profile/README.md).
