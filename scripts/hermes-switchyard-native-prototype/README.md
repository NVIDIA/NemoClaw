<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes → Relay → Switchyard native prototype (V2)

This directory is the second, independent architecture milestone for
[NemoClaw #7937](https://github.com/NVIDIA/NemoClaw/issues/7937). It is an
experimental compatibility proof, not a supported NemoClaw integration.

V1 is frozen at NemoClaw commit `d58276ab7` and must not be rewritten. V2 starts
from current NemoClaw `main` and targets the upstream replacement architecture:

```text
normal supervised Hermes gateway
└── Hermes native Relay runtime (Hermes #77915)
    └── nvidia.switchyard dynamic plugin (Switchyard #270)
        └── deterministic loopback classifier / fast / quality providers
```

Unlike V1, V2 must not launch Hermes through `nemo-relay run`. The Relay Python
binding and Switchyard plugin are loaded once by the normal Hermes process and
remain active for its lifetime.

## Architecture iteration ledger

| Iteration | Preserved implementation | Architecture | What it proves |
| --- | --- | --- | --- |
| V1 | branch `codex/switchyard-relay-prototype-v1`, commit `d58276ab7` | Relay CLI launches a one-off Hermes chat and uses the #586-era static integration | Hermes requests can be routed by Switchyard through Relay in a NemoClaw-managed sandbox |
| V2 | branch `codex/switchyard-relay-prototype-v2` (this directory) | NemoClaw supervises the normal Hermes gateway; Hermes loads Relay in-process; Relay loads the `nvidia.switchyard` plugin | Weak/strong routing remains active across turns and a supervised gateway restart, without a Relay or Switchyard sidecar |
| V3 | planned, separate iteration | V2 topology with Switchyard targets mapped through `inference.local` | Real provider selection through OpenShell without placing provider credentials in the sandbox |

Each iteration is preserved independently. V2 does not rewrite V1, and V3 will
not turn this deterministic compatibility proof into an implicit supported
integration.

## Immutable upstream inputs

- Hermes PR #77915: `08c76bb6baaa77d37821d4777b97f1026c46d5d2`
- Hermes archive SHA-256:
  `5c0923c8ec1a072b5b749085872f473d3e9c015c3fa2a2a8619d93f8af9fa5c1`
- NeMo Relay Python binding: `0.7.0rc6`
- Switchyard PR #270: `c69a8b68f7c85e4b610c077690f90db6de9053ed`
- Switchyard archive SHA-256:
  `31866653db66435772c081350d6930898b15a8baea054bacdd9c43686287f2f2`
- Hermes compatibility base: `v2026.8.3` / `0.20.0`, archive SHA-256
  `370542c7219faba6300905c3b419e14e6508a31ac698a1a5174e0386990834be`

Hermes #77915 is 153 commits ahead of the `v2026.8.3` release and expects its
0.20 model-profile contract. V2 therefore uses that release as its coherent
base before overlaying the PR files. The `hermes-agent@0.20.0` npm package is
not published, so the prototype records a narrowly guarded npm cross-check
exception. A supported dependency update must not inherit that exception.

Hermes 0.20 also changed the dependency manifest after NemoClaw's canonical
0.19 security patch was reviewed. V2 carries a separate, generated 0.20 patch
that preserves the still-required cryptography, aiohttp, and Tornado security
floors while leaving the canonical 0.19 patch untouched. Several older patch
hunks were omitted because those upgrades are already present upstream.
The existing WhatsApp proxy hardening is likewise rebased into a separate 0.20
patch so the prototype does not regress NemoClaw's egress boundary.
Because the 0.20 archive pins Python 3.11 in `.python-version`, the prototype
explicitly builds its virtual environment with the image's system Python 3.13
(within Hermes's declared `>=3.11,<3.14` range). This keeps the interpreter in
the normal non-root-readable runtime tree instead of root-owned uv storage.

The final NemoClaw image still contains compatibility patchers reviewed against
Hermes 0.19. V2 preserves the patchers whose exact 0.20 source shapes still
match, rebases the session-preview count and changed source hashes, and skips
only the named-profile defaults patch/probe whose defaults moved into new 0.20
modules. The proof uses NemoClaw's generated default home, fake providers, and
no messaging credentials; named-profile policy parity remains an explicit
support gate and this exception must not become canonical behavior.
The CLI adapter is copied into a 0.20-specific contract and validated against
the installed parser/coalescer source before the normal NemoClaw wrapper is
installed; V1's 0.19 contract remains unchanged.

The prototype base image overlays only the four Hermes runtime files changed by
Hermes PR #77915, upgrades the Relay binding to the exact RC6 wheel, and
installs the integrity-materialized Switchyard dynamic plugin bundle. It retains the normal
NemoClaw Hermes image, supervisor, configuration guard, and gateway lifecycle.

## Proof boundary

The deterministic provider accepts no authorization header. This lane proves
native plugin loading, classifier weak/strong selection, streaming, process
lifetime, routing marks, and cleanup without handling a real credential.

The later V3 lane will map Switchyard targets to `inference.local` and validate
OpenShell endpoint and credential behavior. No direct external provider egress
is authorized by this prototype.

## Run the V2 proof

Build or onboard a Hermes sandbox from this worktree so the prototype base
image is used. Then run the proof against that normal supervised sandbox:

```bash
NEMOCLAW_HERMES_SWITCHYARD_NATIVE_PROTOTYPE=1 \
  NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD=1 \
  node bin/nemohermes.js onboard
npm run prototype:hermes-switchyard:native -- <sandbox-name>
```

The second command starts only the deterministic model provider. It sends two
requests through the existing Hermes API and verifies `efficient → weak/fast`
and `capable → strong/quality`. It also verifies that the Hermes gateway PID
does not change, no Relay CLI or `switchyard-server` process exists, and no
authorization header reaches the provider.

Add `--restart` to run the same routing proof, restart the supervised Hermes
gateway through NemoClaw's lifecycle controller, and repeat the proof against a
new Hermes PID:

```bash
npm run prototype:hermes-switchyard:native -- <sandbox-name> --restart
```
