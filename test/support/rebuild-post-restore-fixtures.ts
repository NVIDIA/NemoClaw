// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../../src/lib/messaging/channels";
import { MessagingWorkflowPlanner } from "../../src/lib/messaging/compiler";

export function rebuildPostRestoreInput(agentName: string) {
  return {
    sandboxName: "alpha",
    targetAgentName: agentName,
    messagingPlan: null,
    backupManifest: null,
    mcpEntries: [],
    restoreSucceeded: true,
    failedPresets: [],
    finalBuiltinPresets: [],
    failedPresetRemovals: [],
    policyPresetReconciliationVerified: true,
    preparedBackupRecovery: false,
    versionCheck: { expectedVersion: null } as never,
    log: vi.fn(),
    bail: vi.fn() as never,
  };
}

export async function hermesTeamsPlan(disabled = false) {
  vi.stubEnv("MSTEAMS_APP_ID", "test-teams-app");
  vi.stubEnv("MSTEAMS_TENANT_ID", "test-teams-tenant");
  vi.stubEnv("TEAMS_ALLOWED_USERS", "00000000-0000-0000-0000-000000000001");
  vi.stubEnv("MSTEAMS_PORT", "3979");
  return new MessagingWorkflowPlanner(
    createBuiltInChannelManifestRegistry(),
    undefined,
    createBuiltInRenderTemplateResolver(),
  ).buildPlan({
    sandboxName: "alpha",
    agent: "hermes",
    workflow: "rebuild",
    isInteractive: false,
    configuredChannels: ["teams"],
    disabledChannels: disabled ? ["teams"] : [],
    credentialAvailability: { MSTEAMS_APP_PASSWORD: true },
  });
}

export const runtimeKindByAgent = {
  openclaw: "gateway",
  hermes: "gateway",
  "langchain-deepagents-code": "terminal",
  pi: "terminal",
} as const;
