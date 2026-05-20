<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Adapters

Adapters isolate process, filesystem, Docker, OpenShell, and other host-boundary calls from action and domain logic.

Use adapters when code needs to cross a boundary that is hard to unit test directly. Actions can depend on adapters, but domain helpers should stay pure and receive already-collected inputs.
