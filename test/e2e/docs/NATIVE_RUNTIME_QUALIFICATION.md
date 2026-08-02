<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native Runtime Activation Qualification

`registry/activation-qualification.ts` is a dormant release gate for a native
container-runtime candidate. It does not register a runtime, add a live target,
alter the production runtime registry, or advertise support.

The compiler has one provider-neutral contract. A candidate supplies an open
provider ID and fixture bindings; the compiler does not branch on Podman, MXC,
or any other engine name. The inert Podman candidate in
`support/native-runtime-qualification-fixtures.ts` proves the intended scope,
while the fake MXC-style test proves that the same contract accepts another
provider without a central switch.

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

Every compiled case declares the evidence categories that the protected
collector must eventually produce. Those categories preserve the complete
activation target:

- the exact protected workflow revision, run, job, attempt, head SHA, and base
  SHA;
- hashed installer script and invocation artifacts with a successful result;
- an exact provider/profile/architecture/acceleration identity and persisted
  host-local engine authority;
- immutable agent and probe image references, plus an immutable inference image
  reference for provider-managed NIM and vLLM;
- the exact provider-native host, port, network, gateway provider URL, and the
  canonical `https://inference.local/v1` application route;
- the serialized host-local inference authority digest, including the exact
  provider-owned runtime/container identity and specification digest for NIM
  and vLLM;
- the exercised model ID and a hashed inference-result artifact;
- hashed artifacts for every lifecycle obligation, all bound to that same
  durable authority;
- a reconciliation receipt proving recovery retained the same authority;
- an NVIDIA CDI `nvidia.com/gpu=all` receipt for GPU cases; and
- exact cleanup proving external Ollama was retained or provider-owned NIM and
  vLLM were removed, with no provider-owned runtime IDs remaining.

These are compile-time requirements, not a receipt schema or generated
evidence. This slice intentionally does not export a reporter, artifact
verifier, or process-local evidence brand before a protected workflow consumes
that API. The protected-collector slice must add those pieces together: obtain
authenticated GitHub run/job state independently of worker receipts, verify
every artifact below its downloaded job root, and fail closed on incomplete,
inexact, linked, escaping, conflicting, changing, or oversized evidence. All
cases must bind to one exact protected workflow/head/base source before the
runtime can activate.

## Activation boundary

Keep this contract inert until an implementation PR supplies executable
provider adapters and the entire protected matrix passes on one exact head/base
pair. Public support, installer selection, production registry wiring, and
workflow dispatch are separate activation work and must not infer support from
the existence of this contract.
