// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseServicePortOverride } from "./core/service-port-boundary";

export const HERMES_DASHBOARD_ENABLE_ENV = "NEMOCLAW_HERMES_DASHBOARD";
export const HERMES_DASHBOARD_PORT_ENV = "NEMOCLAW_HERMES_DASHBOARD_PORT";
export const HERMES_DASHBOARD_INTERNAL_PORT_ENV = "NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT";
export const HERMES_DASHBOARD_TUI_ENV = "NEMOCLAW_HERMES_DASHBOARD_TUI";

export const HERMES_DASHBOARD_DEFAULT_PORT = 9119;
export const HERMES_DASHBOARD_DEFAULT_INTERNAL_PORT = 19119;

export interface HermesDashboardConfig {
  enabled: boolean;
  port: number;
  internalPort: number;
  tuiEnabled: boolean;
}

export function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

export function readHermesDashboardConfig(
  env: NodeJS.ProcessEnv = process.env,
): HermesDashboardConfig {
  return {
    enabled: isTruthyEnv(env[HERMES_DASHBOARD_ENABLE_ENV]),
    port: parseServicePortOverride(
      HERMES_DASHBOARD_PORT_ENV,
      env[HERMES_DASHBOARD_PORT_ENV],
      HERMES_DASHBOARD_DEFAULT_PORT,
    ),
    internalPort: parseServicePortOverride(
      HERMES_DASHBOARD_INTERNAL_PORT_ENV,
      env[HERMES_DASHBOARD_INTERNAL_PORT_ENV],
      HERMES_DASHBOARD_DEFAULT_INTERNAL_PORT,
    ),
    tuiEnabled: isTruthyEnv(env[HERMES_DASHBOARD_TUI_ENV]),
  };
}
