// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { hydrateMessagingChannelConfig } from "../../messaging-channel-config";
import { getStoredMessagingChannelConfig } from "../../onboard/messaging-config";
import * as onboardSession from "../../state/onboard-session";
import type { RebuildBail } from "./rebuild-credential-preflight";
import {
  REBUILD_HERMES_DASHBOARD_ENV_KEYS,
  resolveRebuildHermesDashboardEnv,
} from "./rebuild-durable-config";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import {
  buildRebuildRecreateOnboardOpts,
  type RebuildRecreateOnboardOpts,
} from "./rebuild-gpu-opt-out";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";

export function prepareRebuildRecreateOptions(
  sb: RebuildSandboxEntry,
  rebuildAgent: string | null,
  storedFromDockerfile: string | null,
  autoYes: boolean,
  bail: RebuildBail,
): RebuildRecreateOnboardOpts | null {
  try {
    return buildRebuildRecreateOnboardOpts({
      sb,
      rebuildAgent,
      storedFromDockerfile,
      autoYes,
      usageNoticeAccepted: true,
    });
  } catch (err) {
    printRebuildPreflightFailure(
      "the recorded recreate target is invalid.",
      err instanceof Error ? err.message : String(err),
      "Recorded recreate target is invalid",
      bail,
    );
    return null;
  }
}

export function stageRebuildHermesDashboardConfig(
  rebuildAgent: string | null,
  sb: RebuildSandboxEntry,
  controlUiPort: number | null,
  bail: RebuildBail,
): boolean {
  const resolved = resolveRebuildHermesDashboardEnv(rebuildAgent, sb, controlUiPort);
  if (!resolved.ok) {
    printRebuildPreflightFailure(
      "the recorded Hermes dashboard state is invalid.",
      resolved.reason,
      "Recorded Hermes dashboard state is invalid",
      bail,
    );
    return false;
  }
  for (const key of REBUILD_HERMES_DASHBOARD_ENV_KEYS) {
    const value = resolved.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return true;
}

export function hydrateMessagingConfigForRebuild(
  sandboxName: string,
  log: (msg: string) => void,
): void {
  const rebuildSession = onboardSession.loadSession();
  const hydratedMessagingConfig = hydrateMessagingChannelConfig(
    getStoredMessagingChannelConfig(sandboxName, rebuildSession),
  );
  if (hydratedMessagingConfig) {
    log(`Stashed messaging config for rebuild: ${Object.keys(hydratedMessagingConfig).join(",")}`);
  }
}
