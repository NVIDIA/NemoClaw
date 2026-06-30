<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Warm Sandbox Build Cache Evidence

This fixture records the manual cache validation for issue #4682. It is not a
user-facing guide; it gives reviewers an auditable command shape and expected
cache behavior for stabilizing the otherwise-unused per-run build ID.

## Method

The measurement keeps shared base images on the host and removes only generated
NemoClaw/OpenShell sandbox images (`openshell/sandbox-from:*`) for the cold run.
That isolates final-image layer reuse instead of measuring base-image pulls.

For each agent:

1. Delete the measurement sandbox if it exists:

   ```bash
   openshell sandbox delete warm-cache-openclaw || true
   openshell sandbox delete warm-cache-hermes || true
   ```

2. Delete the generated measurement image before the cold run:

   ```bash
   docker image rm openshell/sandbox-from:<measurement-tag>
   ```

3. Run onboard with stable inputs and record the
   `Sandbox image build completed in ...` line:

   ```bash
   NEMOCLAW_NON_INTERACTIVE=1 \
   NEMOCLAW_RECREATE_SANDBOX=1 \
   NEMOCLAW_SANDBOX_NAME=warm-cache-openclaw \
   NEMOCLAW_PROVIDER=custom \
   NEMOCLAW_MODEL=test-model \
   NEMOCLAW_ENDPOINT_URL=http://host.openshell.internal:11434/v1 \
   COMPATIBLE_API_KEY=warm-cache-dummy-key \
     node bin/nemoclaw.js onboard \
       --non-interactive --yes --fresh --recreate-sandbox \
       --name warm-cache-openclaw \
       --yes-i-accept-third-party-software
   ```

   For Hermes, add `--agent hermes` and use
   `NEMOCLAW_SANDBOX_NAME=warm-cache-hermes` / `--name warm-cache-hermes`.

4. Stop the post-build readiness wait after the timing line, delete the sandbox,
   keep the generated image, and rerun the same command for the warm run.

## Observed Results

| Agent | Cold build | Warm build | Expected warm-cache behavior |
| --- | ---: | ---: | --- |
| OpenClaw | `20.9s` | `0.1s` | Stable Dockerfile/build context reuses build-time config, plugin install, proxy, OTEL, permission, and hash layers. |
| Hermes | `21.5s` | `0.4s` | Stable Dockerfile/build context reuses runtime setup, config generation, agent-install, permission, and config-hash layers. |

Warm builds showed the derived-image Docker steps completing at `0.0s` or
`0.1s`. `ARG NEMOCLAW_BUILD_ID=default` remained stable in stock staged
Dockerfiles; custom Dockerfiles that reference `NEMOCLAW_BUILD_ID` still receive
the supplied build ID.

A separate BuildKit control probe confirmed that changing an in-scope `ARG`
invalidates a following `RUN` layer even when that instruction does not mention
the argument. This change therefore does not claim that moving `ENV` instructions
can protect layers from other changed build arguments. The automated regression
instead patches both stock Dockerfiles with two different per-run build IDs and
requires the resulting build contexts to remain byte-identical.

The post-build OpenShell GPU reconnect/readiness step is outside this cache
measurement and can be handled separately from Docker build-layer reuse.
