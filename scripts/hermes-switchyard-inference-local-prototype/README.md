<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes → Relay → Switchyard through inference.local (V3)

V3 is the third independently preserved architecture milestone for
[NemoClaw #7937](https://github.com/NVIDIA/NemoClaw/issues/7937). It is a
prototype and compatibility investigation, not a supported NemoClaw feature.

```text
normal supervised Hermes gateway
└── Hermes native Relay runtime (Hermes #77915)
    └── nvidia.switchyard plugin (Switchyard #270)
        ├── deterministic loopback classifier
        └── selected final target → https://inference.local
            └── OpenShell strips caller auth and injects the host-owned credential
```

## Architecture iteration ledger

| Iteration | Preserved implementation | Architecture | Evidence boundary |
| --- | --- | --- | --- |
| V1 | branch `codex/switchyard-relay-prototype-v1`, commit `d58276ab7` | Relay CLI launches a one-off Hermes chat using the superseded Relay #586 path | Behavioral feasibility inside a managed sandbox |
| V2 | branch `codex/switchyard-relay-prototype-v2`, commit `3c6932bdd` | Supervised Hermes loads Relay and Switchyard natively for its process lifetime | Deterministic weak/strong selection, no sidecar, restart persistence |
| V3 | branch `codex/switchyard-relay-prototype-v3`, implementation commit `28749b8844` | V2 runtime with final provider calls sent through `inference.local` | Provider endpoint mediation, credential isolation, caller-header replacement, and the current single-model limitation |
| V3.1 | branch `codex/switchyard-relay-prototype-v3`, repair commit `34d1b06706` | V3 with one fake caller marker shared coherently by the probe, host verifier, and focused test | Reproducibility repair only; no architecture or security-boundary change |

V3 layers only a new target configuration and verifier onto V2. It does not
rewrite either earlier branch. It uses the exact unreleased upstream inputs and
security exceptions documented in the V2 README.

V3.1 fixes a source/test mismatch found during the final documentation audit.
It constructs the deliberate fake caller marker in scanner-safe pieces while
the host verifier checks the resulting complete value. The V3 runtime result
and proof boundary are unchanged.

## What V3 proves

- NemoClaw still supervises the normal Hermes gateway.
- Relay and the Switchyard plugin remain in-process; no Relay CLI or
  `switchyard-server` sidecar exists.
- The deterministic classifier produces both `efficient → weak` and
  `capable → strong` decisions.
- Both selected final calls leave the sandbox only through
  `https://inference.local`.
- The sandbox sees only OpenShell's canonical or revisioned
  `COMPATIBLE_API_KEY` resolver placeholder. No raw provider credential or
  Switchyard `header_env` exists there.
- A caller-supplied authorization header can be replaced by OpenShell's
  gateway-owned credential. Passing `--provider-log` independently verifies
  that replacement at a deterministic host fixture.
- The same contract survives a managed Hermes restart.

## Validated evidence

Validated on 2026-08-05 in the independently scoped
`hermes-switchyard-v3` sandbox on gateway port `19003`. The exact final image
was `sha256:5aad8684939190b0fc68cdc67524c0fd2b7c44eaf53e5260f2cce9328a60064c`.

The baked verifier passed before and after a managed Hermes restart:

- `efficient` selected `weak`; `capable` selected `strong`.
- Both selected calls crossed `https://inference.local` and returned the
  deterministic host response.
- The native plugin was `nvidia.switchyard`; Relay sidecar process count was
  zero.
- The sandbox contained only OpenShell's credential resolver placeholder and
  no raw provider credential.
- Six host-provider requests received the gateway-owned credential; the
  untrusted caller header was absent at the provider.
- The supervised Hermes gateway PID changed from `22791` to `2929`, and the
  entire proof passed again after restart.

The host fixture and the disposable Docker Desktop TCP bridge used for this
validation are test scaffolding. They are not proposed components of the
supported NemoClaw architecture.

## Current platform gap

OpenShell's current gateway inference route contains one provider and one model,
and `openshell inference set --model` describes that model as forced for
generation calls. Consequently, Switchyard can decide weak versus strong, but
both targets are collapsed to the same host-selected model at
`inference.local`. V3 reports this as `gateway-forced-single-model`; it does not
claim simultaneous real weak/strong routing.

That leaves a production decision: either OpenShell adds a trusted multi-target
contract, or NemoClaw uses a separate host-side adapter that maps bounded tier
identifiers to provider profiles while keeping credentials outside the
sandbox. The prototype does not create that new supported surface.

## Build a V3 sandbox

Use a gateway that already has a provider and inference route. Then build or
onboard a fresh Hermes sandbox from this worktree:

```bash
npm run build:cli
NEMOCLAW_HERMES_SWITCHYARD_INFERENCE_LOCAL_PROTOTYPE=1 \
  NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD=1 \
  node bin/nemohermes.js onboard
```

The V3 sentinel implies the V2 native upstream bundle during both base and
final-image construction. Do not reuse a sandbox built without this sentinel.

## Run the credential-free or real-model lane

The active OpenShell inference route supplies the final provider and model:

```bash
openshell inference get
npm run prototype:hermes-switchyard:inference-local -- <sandbox-name> --restart
```

If that route points to a real provider, this is the optional real-model demo.
The provider credential remains stored at the OpenShell gateway; do not export
or copy it into the sandbox. To demonstrate separate weak and strong real
models today, change the host route and run one phase at a time. This is a
two-phase compatibility demonstration, not dynamic per-turn multi-model
routing.

For the deterministic credential-boundary fixture used by the managed V1/V2
setup, pass its bounded JSONL request log:

```bash
npm run prototype:hermes-switchyard:inference-local -- <sandbox-name> \
  --provider-log /absolute/path/to/provider-requests.jsonl
```

The verifier requires three or more new successful POSTs, a gateway-owned
credential on every request, one host-forced model, and absence of the
caller-supplied credential value. The log contains booleans and model IDs only;
it must never contain credential material.
