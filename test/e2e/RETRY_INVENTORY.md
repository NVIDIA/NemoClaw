<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Live E2E retry inventory

| Operation | Owner | Limit | Retry condition | Safety basis | Evidence |
| --- | --- | --- | --- | --- | --- |
| `external-gateway-health.tcp-readiness` | `openshell-gateway` | 10 attempts, one second apart | The newly started gateway listener rejects a TCP connection with `ECONNREFUSED` | The probe is read-only. Other errors stop without retry. The Blueprint Runner health operation runs once after the listener opens. | `external-gateway-readiness-retry.json` |
| `openclaw-plugin-runtime-exdev.onboard-pairing` | `openclaw-plugin-runtime-exdev` | Two attempts | Fresh onboarding reports that canonical CLI device pairing did not appear. | The retry uses `onboard --resume` only when OpenShell reports the sandbox as Ready, the registry resolves an ordinary OpenClaw pairing target, and the saved in-progress session matches the sandbox, gateway, agent, `post_verify` state, and custom Dockerfile. Other errors stop without retry. | `openclaw-plugin-exdev-onboard-retry.json` |
