<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Capability provisioning contract

This internal, dormant contract replaces Dockerfile-shaped customization intent with a portable capability manifest. A trusted catalog resolves requested tools, runtimes, and skills into an exact, secret-free bill of materials (BOM) for one agent and platform.

The first slice intentionally has no onboarding caller and no runtime-provider implementation. It accepts only digest-pinned OCI artifacts, fixed managed install prefixes, relative `PATH` entries, named policy presets, and catalog-owned dependencies. It does not accept package-manager commands, shell scripts, mutable image tags, credentials, arbitrary destinations, or provider identities.

A later runtime-provider facet will consume the resolved BOM through explicit supported or unsupported declarations. Docker and candidate Podman must implement and qualify the same facet before the feature becomes user-visible. An MXC-style provider must remain representable without adding a central runtime switch.
