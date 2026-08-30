// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeActiveTeamsMessagingPlan() {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "openclaw",
    workflow: "rebuild",
    channels: [
      {
        channelId: "teams",
        displayName: "Microsoft Teams",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [
          {
            channelId: "teams",
            inputId: "appId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_APP_ID",
            statePath: "teamsConfig.appId",
            value: "teams-app-id",
          },
          {
            channelId: "teams",
            inputId: "clientSecret",
            kind: "secret",
            required: true,
            sourceEnv: "MSTEAMS_APP_PASSWORD",
            credentialAvailable: true,
          },
          {
            channelId: "teams",
            inputId: "tenantId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_TENANT_ID",
            statePath: "teamsConfig.tenantId",
            value: "teams-tenant-id",
          },
          {
            channelId: "teams",
            inputId: "webhookPort",
            kind: "config",
            required: false,
            sourceEnv: "MSTEAMS_PORT",
            statePath: "teamsConfig.webhookPort",
            value: "3978",
          },
        ],
        hostForward: {
          channelId: "teams",
          port: 3978,
          label: "Microsoft Teams webhook",
        },
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [
      {
        channelId: "teams",
        credentialId: "teamsClientSecret",
        sourceInput: "clientSecret",
        providerName: "alpha-teams-bridge",
        providerEnvKey: "MSTEAMS_APP_PASSWORD",
        placeholder: "openshell:resolve:env:MSTEAMS_APP_PASSWORD",
        credentialAvailable: true,
        credentialHash: "teams-client-secret-hash",
      },
    ],
    networkPolicy: { presets: ["teams"], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

const preparedRecoveryTempDirs: string[] = [];

export function cleanupPreparedRecoveryManifests(): void {
  for (const directory of preparedRecoveryTempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function makePreparedRecoveryManifest() {
  const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-recovery-"));
  preparedRecoveryTempDirs.push(backupPath);
  return {
    version: 1,
    sandboxName: "alpha",
    timestamp: "2026-07-01T06-50-42-044Z",
    agentType: "openclaw",
    agentVersion: "0.1.0",
    expectedVersion: "0.2.0",
    stateDirs: ["workspace"],
    backedUpDirs: ["workspace"],
    stateFiles: [],
    dir: "/sandbox/.openclaw",
    backupPath,
    blueprintDigest: null,
  };
}
