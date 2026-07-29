// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

export function buildDashboardRemoteBindEnv(
  sandboxName: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
    NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
  };
}
