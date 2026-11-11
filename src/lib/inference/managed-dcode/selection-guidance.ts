// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";

export function dcodeSelectionChangeGuidance(): string {
  return (
    "Deep Agents preserves saved native preferences during rebuild and named recreation. " +
    `To change provider or model, record the current default and use a new sandbox name: \`${CLI_NAME} onboard --agent dcode --name <new-sandbox-name> --fresh\`. ` +
    `After any onboarding attempt, restore the previous default with \`${CLI_NAME} use <previous-default-sandbox-name>\`. ` +
    `After successful onboarding, verify the requested provider and model with \`${CLI_NAME} <new-sandbox-name> status\` and \`${CLI_NAME} <new-sandbox-name> inference get\` before selecting it with \`${CLI_NAME} use <new-sandbox-name>\`.`
  );
}
