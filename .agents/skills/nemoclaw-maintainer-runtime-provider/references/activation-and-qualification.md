<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Activation and Qualification

Use this reference when a candidate provider becomes production-selectable. Treat exported values
from `src/lib/onboard/runtime-provider/activation.ts` as the contract for the commit under
review.

## Separate Registration from Activation

Bundle registration validates structure, identity, methods, and capability coherence. It permits
explicit unsupported surfaces. Activation applies the stricter native-provider product profile and
requires protected qualification authority.

Do not make a provider selectable by adding it directly to the established-provider registry.
Create one `RuntimeProviderActivationRegistration` and compose it through
`createCurrentRuntimeProviderBundles(...)`.

## Activation Declaration

The current declaration uses contract version 1 and binds one provider ID to:

| Field | Current accepted value |
| --- | --- |
| `topology.hostAuthority` | `rootful`, `rootless`, or `external` |
| `topology.transport` | `operation-scoped` or `socket-free` |
| `agents` | `openclaw`, `hermes`, `langchain-deepagents-code` in canonical order |
| `platforms` | `linux/amd64`, `linux/arm64` in canonical order |
| `qualificationRootModes` | `rootless` |
| `accelerationModes` | `cpu`, `nvidia-cdi` in canonical order |
| `hostLocalInferenceServices` | `ollama`, `nim`, `vllm` in canonical order |
| `journeys` | `onboard`, `agent-turn`, `stop-start`, `snapshot-restore`, `rebuild`, `restart-reconcile`, `exact-cleanup` |
| `installer` | `releaseInstaller: true` and `dockerUnavailable: true` |
| `qualification` | Provider-qualified ID and immutable expected source identity |

The validator rejects missing, extra, duplicated, or reordered values where it requires a canonical
sequence. Re-read the exported constants before authoring the declaration.

## Complete Activated Bundle

Activation requires all 14 surfaces to report `supported: true`. It also requires:

- host-local inference, direct lifecycle, and workload cleanup capabilities;
- exact-digest managed images for Linux AMD64 and ARM64;
- `require-managed` selection and no legacy Dockerfile builds;
- accepted current managed-image startup and capability contract versions;
- Ollama, NVIDIA NIM, and vLLM services in canonical order;
- the complete canonical mutation-operation sequence;
- state mutation contract version 2;
- backup, restore, and managed-profile restore;
- operation-scoped identities for all six engine scopes; and
- release-installer qualification with Docker unavailable.

If a provider cannot truthfully meet this profile, keep it as a candidate. When a real provider
topology requires another profile, use an accepted design decision to extend activation. Do not
claim authority by emulating another provider's command surface.

## Protected Qualification Authority

Candidate code cannot self-assert activation. The trusted collector binds the qualification
authority to these immutable identities:

- protected repository and producer workflow;
- same-repository open PR and candidate repository;
- latest PR commit SHA and base SHA;
- workflow run ID, run attempt, and job ID;
- artifact ID, bounded artifact name, and SHA-256 digest; and
- qualification ID and provider ID.

The activation declaration's expected source must equal the protected authority source, including
the run attempt. The protected native-runtime-qualification producer can run only on its first
workflow attempt. A local log, vendor receipt, partial matrix, older commit, or different source
identity is supporting evidence. It is not activation authority.

## Product Decision

A successful activation catalog proves that the implementation satisfies the current technical
contract and qualification source checks. Maintainer approval under the product scope gate still
controls whether NemoClaw presents the provider as a supported surface.
