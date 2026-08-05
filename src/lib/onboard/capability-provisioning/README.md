<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Capability provisioning contract

This internal, dormant contract replaces Dockerfile-shaped customization intent with a portable capability manifest. A trusted catalog resolves requested tools, runtimes, and skills into an exact, secret-free bill of materials (BOM) for one agent and platform.

The first slice intentionally has no onboarding caller and no runtime-provider implementation. It accepts only digest-pinned OCI artifacts, fixed managed install prefixes, relative `PATH` entries, named policy presets, and catalog-owned dependencies. It does not accept package-manager commands, shell scripts, mutable image tags, credentials, arbitrary destinations, or provider identities.

A later runtime-provider facet will consume the resolved BOM through explicit support declarations tracked in [#7744](https://github.com/NVIDIA/NemoClaw/issues/7744). Docker and Podman must install the same BOM for every supported agent and platform in that issue's qualification matrix. A socket-free MXC-style fixture must accept the same BOM shape, declare unsupported installation with an actionable reason, and require no central provider switch. The feature remains dormant until these contracts and the protected E2E matrix pass.
