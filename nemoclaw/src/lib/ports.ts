// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseServicePortOverride } from "../shared/port-boundary.cjs";

/** Dashboard port parsing for the NemoClaw plugin. */

export function parsePort(envVar: string, fallback: number): number {
  return parseServicePortOverride(envVar, process.env[envVar], fallback);
}

export const DASHBOARD_PORT = parsePort("NEMOCLAW_DASHBOARD_PORT", 18789);
