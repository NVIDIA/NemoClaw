<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Live E2E retry inventory

| Operation | Owner | Limit | Retry condition | Safety basis | Evidence |
| --- | --- | --- | --- | --- | --- |
| `external-gateway-health.tcp-readiness` | `openshell-gateway` | 10 attempts, one second apart | The newly started gateway listener rejects a TCP connection with `ECONNREFUSED` | The probe is read-only. Other errors stop without retry. The Blueprint Runner health operation runs once after the listener opens. | `external-gateway-readiness-retry.json` |
| `openclaw-plugin-runtime-exdev.onboard-pairing` | `openclaw-plugin-runtime-exdev` | One attempt | None. | If fresh onboarding reports that canonical CLI device pairing did not appear, the test records structured failure diagnostics and `failed-no-retry` evidence. It does not automatically resume an ambiguously mutated onboarding session. | `openclaw-plugin-exdev-onboard-retry.json` |
| `openclaw-plugin-runtime-exdev.recreate-pairing` | `openclaw-plugin-runtime-exdev` | One attempt | None. | If recreation reports the same pairing failure, the test records distinct structured diagnostics and `failed-no-retry` evidence. A later attempt requires a new E2E dispatch after failure classification. | `openclaw-weather-plugin-recreate-retry.json` |
