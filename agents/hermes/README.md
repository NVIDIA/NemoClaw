<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes managed startup artifact

The Hermes image copies `managed-startup-image-runtime.bundle`. Rebuild and check it with:

```sh
node agents/hermes/build-managed-startup-runtime.ts
node agents/hermes/build-managed-startup-runtime.ts --check
```

The builder uses the shared direct-startup entrypoint and source. For the shared image-runtime
module only, it binds the filesystem import to `managed-startup-filesystem.ts`.
The adapter leaves Node's global filesystem object unchanged. Other imports use native Node APIs.
Other agents continue to use the existing reviewed shared artifact.

The adapter changes deletion only for the four fixed Hermes generated-policy and routing source
paths. If ordinary deletion returns `EACCES` or `EPERM`, it verifies the source, private parent,
numeric sandbox identity and Node executable. The parent retains either its existing private mode
or the exact shipped sandbox-owned `3770` mode. A bounded child deletes the unchanged source as
the sandbox user. Startup fails unless the child succeeds and the source is confirmed absent.
Policy installation, protected target ownership, private directory modes and container capabilities
are unchanged.

The integration tests check artifact freshness and deterministic cleanup failures. The image
workflows run `test/package-contract/onboard/hermes-policy-cleanup.test.ts` against the built
Hermes image. Its disposable, network-disabled container lacks DAC override and proves root deletion
denial and successful policy promotion followed by owner deletion for `0700` and `3770` parents.
The existing Hermes inference-switch E2E owns full rebuild and credential-preservation evidence.

## Switchyard preflight

Managed routing retains an expected configuration fingerprint in the startup environment.
The three protected routing files must match it before each gateway launch, including recovery.
Publication validates the proposed deployment with the installed Hermes/Relay/Switchyard loader
before replacing files. An exclusive publication lock conflicts with the startup supervisor's
shared lock. Interrupted publication fails closed and is not repaired automatically.

`switchyard-preflight.py` checks the pinned package, protected files, scoped credential references,
and the gateway PID/start identity. Native initialization and shutdown validate the complete
deployment without a model request. The existing judge qualifier separately sends its bounded
qualification request. These checks establish expected startup inputs, not gateway activation.

Host onboarding, connect readiness, and status combine this observation with fresh provider and
effective-policy reads. They compare observations before accepting verification. Status and
onboarding identify the direct capable-provider request separately from routing preflight; that
request does not establish adaptive routing. No successful result is retained across a restart.
Missing, changed, or unavailable evidence blocks verification without changing provider state.

## Switchyard event evidence

The existing Hermes plugin subscribes to Relay only for fingerprint-verified managed routing.
It does not initialize Relay or change routing, and deregisters on plugin unload.

`[switchyard-evidence]` gateway logs contain UUID ancestry, turn boundaries, classifier decisions,
judge/answer roles, and model hashes bound to the deployment. They omit token metrics, prompts,
answers, private reasoning, arbitrary metadata, provider errors, and credentials.
Decision and call marks accept only their named version-1 schema or Relay's schema-less form.

Capture stops after 4096 records plus a truncation marker. Each record, including failure markers,
has a random recorder-instance ID, PID, and sequence; the instance ID distinguishes restarts.
Installation failures identify a non-secret configuration, Relay, subscriber, or unload stage.
Missing, failed, truncated, or uncorrelated capture does not prove adaptive routing.
