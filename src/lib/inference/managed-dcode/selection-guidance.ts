// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";

export function dcodeSelectionChangeGuidance(): string {
  return (
    "Deep Agents has no runtime provider or model update. " +
    `To change a managed sandbox's selection, record the current default and recreate the named sandbox: \`${CLI_NAME} onboard --agent dcode --name <sandbox-name> --fresh --recreate-sandbox\`. ` +
    "For a verified provider or model change, recreation restores saved state while keeping the generated config; the backup retains the previous config for manual recovery. " +
    `After any onboarding attempt, restore the previous default if it changed with \`${CLI_NAME} use <previous-default-sandbox-name>\`. ` +
    `After successful onboarding, verify the requested provider and model with \`${CLI_NAME} <sandbox-name> status\` and \`${CLI_NAME} <sandbox-name> inference get\` before selecting it with \`${CLI_NAME} use <sandbox-name>\`.`
  );
}
