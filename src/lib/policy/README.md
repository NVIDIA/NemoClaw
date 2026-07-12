<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Policy

Policy modules own sandbox network-policy preset loading, tier resolution, and
policy application helpers. They may orchestrate OpenShell policy commands while
legacy flows are being migrated, but pure selection/planning helpers should move
under `src/lib/domain/**` when they can be isolated.
