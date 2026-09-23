// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as importedPortBoundary from "../shared/port-boundary.cjs";

const portBoundary = importedPortBoundary as typeof importedPortBoundary & {
  default?: typeof importedPortBoundary;
};
const { parseServicePortOverride } = portBoundary.default ?? portBoundary;

/** Dashboard port parsing for the NemoClaw plugin. */

export function parsePort(envVar: string, fallback: number): number {
  return parseServicePortOverride(envVar, process.env[envVar], fallback);
}

export const DASHBOARD_PORT = parsePort("NEMOCLAW_DASHBOARD_PORT", 18789);
