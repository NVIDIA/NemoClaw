// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { agentProductName } from "./branding";
import { getOnboardProgressStep } from "./machine/progress";
import { step } from "./prompt-helpers";

export function skippedStepMessage(
  stepName: string,
  detail?: string | null,
  reason: "resume" | "reuse" = "resume",
): void {
  const progressStep = getOnboardProgressStep(stepName);
  const stepInfo =
    progressStep && stepName === "openclaw"
      ? { ...progressStep, title: `Setting up ${agentProductName()} inside sandbox` }
      : progressStep;
  if (stepInfo) step(stepInfo.number, stepInfo.total, stepInfo.title);
  const prefix = reason === "reuse" ? "[reuse]" : "[resume]";
  console.log(`  ${prefix} Skipping ${stepName}${detail ? ` (${detail})` : ""}`);
}
