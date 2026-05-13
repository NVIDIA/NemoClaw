<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Inventory

Inventory modules shape sandbox registry, live inference, service, and messaging
health data into the rows printed by `nemoclaw list` and `nemoclaw status`.
Command parser glue should stay in `src/lib/commands/**`; registry I/O should stay
in `src/lib/state/**`.
