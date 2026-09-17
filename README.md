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

Source code and tests are available in this repository; no package is published to a registry.

Explore the [Libre AI project catalogue](https://github.com/libre-ai/.github/blob/main/profile/README.md).
