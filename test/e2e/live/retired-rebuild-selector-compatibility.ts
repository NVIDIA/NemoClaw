// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const RETIRED_REBUILD_SELECTOR_IDS = ["sandbox-rebuild", "upgrade-stale-sandbox"] as const;

export type RetiredRebuildSelectorId = (typeof RETIRED_REBUILD_SELECTOR_IDS)[number];

function numericIdentity(value: string | undefined, fallback: string, label: string): string {
  const resolved = value?.trim() || fallback;
  if (!/^[0-9]+$/u.test(resolved)) {
    throw new Error(`${label} must contain only decimal digits`);
  }
  return resolved;
}

export function retiredRebuildCompatibilitySandboxName(
  selector: RetiredRebuildSelectorId,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const runId = numericIdentity(environment.GITHUB_RUN_ID, String(process.pid), "GITHUB_RUN_ID");
  const runAttempt = numericIdentity(environment.GITHUB_RUN_ATTEMPT, "1", "GITHUB_RUN_ATTEMPT");
  const name = `e2e-rebuild-openclaw-${selector}-${runId}-${runAttempt}`;
  if (name.length > 63) {
    throw new Error(`retired rebuild compatibility sandbox name exceeds 63 characters: ${name}`);
  }
  return name;
}

export function prepareRetiredRebuildSelectorCompatibility(
  selector: RetiredRebuildSelectorId,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const targetId = environment.E2E_TARGET_ID ?? environment.GITHUB_JOB;
  if (targetId !== selector) {
    throw new Error(
      `retired rebuild compatibility entrypoint ${selector} requires matching E2E_TARGET_ID or GITHUB_JOB; got ${JSON.stringify(targetId ?? "")}`,
    );
  }
  environment.NEMOCLAW_SANDBOX_NAME = retiredRebuildCompatibilitySandboxName(selector, environment);
}
