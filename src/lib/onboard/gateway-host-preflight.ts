// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostAssessment, RemediationAction } from "./preflight";
import { planHostRemediation } from "./preflight";

const GATEWAY_HOST_ACTION_IDS = new Set(["stale_docker_cgroupns_host"]);

export function getGatewayHostPreflightActions(
  assessment: HostAssessment,
): RemediationAction[] {
  return planHostRemediation(assessment).filter((action) =>
    GATEWAY_HOST_ACTION_IDS.has(action.id),
  );
}

export async function warnOrRejectGatewayHostConflicts(
  assessment: HostAssessment,
  deps: {
    printRemediationActions(actions: RemediationAction[]): void;
    promptYesNoOrDefault(
      question: string,
      envVar: string | null,
      defaultIsYes: boolean,
    ): Promise<boolean>;
    error(message: string): void;
    exitProcess(code: number): never;
  },
): Promise<void> {
  const actions = getGatewayHostPreflightActions(assessment);
  if (actions.length === 0) return;

  deps.printRemediationActions(actions);

  if (!actions.some((action) => action.blocking)) return;

  const proceed = await deps.promptYesNoOrDefault("  Continue anyway?", null, false);
  if (!proceed) {
    deps.error("  Aborted. Apply the suggested fix and rerun onboarding.");
    deps.exitProcess(1);
  }
}
