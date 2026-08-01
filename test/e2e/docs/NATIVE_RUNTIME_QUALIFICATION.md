<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native Runtime Activation Qualification

`registry/activation-qualification.ts` is a dormant release gate for a native
container-runtime candidate. It does not register a runtime, add a live target,
alter the production runtime registry, or advertise support.

The compiler consumes the same normalized activation declaration used by the
provider catalog. That one record supplies the agents, platforms,
accelerations, host-local inference services, lifecycle journeys, installer
requirements, and protected-E2E requirements. Catalog/qualification drift is
a compile error.

A candidate supplies an open provider ID and fixture bindings; the compiler
does not branch on Podman, MXC, or any other engine name. The inert Podman
candidate in `support/native-runtime-qualification-fixtures.ts` proves the
intended scope, while the fake MXC-style test proves that the same contract
accepts another provider without a central switch.

## Required protected matrix

Compilation requires 24 exact cases:

- OpenClaw, Hermes, and DCode;
- Linux `amd64` and `arm64`;
- rootless CPU with host-local Ollama;
- rootless NVIDIA GPU with CDI-backed Ollama, NIM, and vLLM;
- the release installer with Docker unavailable; and
- protected E2E for every case.

Every case must declare installation, Docker-unavailable proof, onboarding, an
agent turn, stop/start, snapshot/restore, rebuild, restart/reconciliation, and
exact cleanup. Removing one case or obligation is a compile error, not a skip.

## Exact evidence

Activation evidence is complete only when every compiled case has:

- the exact protected workflow run, job, attempt, head SHA, and base SHA;
- hashed installer script and invocation artifacts with a successful result;
- an exact provider/profile/architecture/acceleration identity;
- immutable managed-image digests;
- hashed artifacts for every lifecycle obligation;
- a host-local inference result for the selected Ollama, NIM, or vLLM lane;
- an NVIDIA CDI `nvidia.com/gpu=all` receipt for GPU cases; and
- a final cleanup receipt.

Evidence paths must be relative and traversal-free. SHA and SHA-256 fields are
strict lowercase hexadecimal values. Missing, duplicate, unknown, or inexact
case evidence fails the aggregate qualification check. All cases must use the
configured protected workflow and one exact head/base pair.

Installer evidence is normalized through the production provider-neutral
receipt contract. Its source revision must match the protected head, and its
provider authority, engine identity, and version must match the runtime receipt
for that case. The contract derives the required amd64 and arm64 targets from
the activation declaration and requires Docker to be unavailable.

## Activation boundary

Keep this contract inert until an implementation PR supplies executable
provider adapters and the entire protected matrix passes on one exact head/base
pair. Public support, installer selection, production registry wiring, and
workflow dispatch are separate activation work and must not infer support from
the existence of this contract.
