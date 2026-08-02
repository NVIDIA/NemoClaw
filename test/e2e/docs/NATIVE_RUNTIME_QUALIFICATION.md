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
The agent identity also binds its application-facing name: OpenClaw, Hermes,
or `langchain-deepagents-code` for DCode.

## Exact evidence

Activation evidence is complete only when every compiled case has:

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

Evidence paths must be relative and traversal-free. SHA and SHA-256 fields are
strict lowercase hexadecimal values. Missing, duplicate, unknown, or inexact
case evidence fails the aggregate qualification check. All cases must use the
configured protected workflow and one exact head/base/workflow source.

Raw worker receipts are never sufficient. The trusted protected-E2E controller
must supply one or more independent bindings constructed from authenticated
GitHub state. Each binding names the repository, workflow revision, run,
attempt, exact head/base pair, numeric job, and that job's downloaded artifact
root; bindings must not be derived from candidate receipt fields. The compiler
defensively clones and freezes the receipts, requires every receipt and binding
to match exactly, and returns a runtime-branded canonical reporter record.

The aggregate validator then resolves every receipt below its bound artifact
root, rejects missing, escaping, linked, conflicting, changing, or oversized
files, and hashes the actual bytes before comparing the claimed SHA-256 digest.
Only a separately branded verified-evidence object can reach final acceptance.
A syntactically complete receipt with invented provenance or artifact digests
therefore cannot qualify a runtime.

These are evidence requirements, not generated evidence. A later protected
collector must publish the receipts from real runners, while its trusted
controller constructs the reporter from authenticated GitHub run/job state,
before activation can consume them.

## Activation boundary

Keep this contract inert until an implementation PR supplies executable
provider adapters and the entire protected matrix passes on one exact head/base
pair. Public support, installer selection, production registry wiring, and
workflow dispatch are separate activation work and must not infer support from
the existence of this contract.
