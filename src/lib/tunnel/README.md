<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tunnel and host services

This folder contains host-side service lifecycle helpers used by `nemoclaw start`,
`nemoclaw stop`, and tunnel/port-forward related commands. Keep oclif parser glue
in `src/lib/commands/**`; service orchestration that starts or stops host
processes belongs here or in `src/lib/actions/**` when it is command-specific.
