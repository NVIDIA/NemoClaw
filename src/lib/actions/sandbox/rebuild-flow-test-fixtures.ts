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
    dir: "/sandbox/.openclaw",
    backupPath,
    blueprintDigest: null,
    rebuildMcpHandoff: {
      entries: [],
      runtimeSelection: {
        gatewayName: "nemoclaw",
        workspace: "default" as const,
      },
    },
  };
}

/** Model a native provider retained across backup, optionally replaced before deletion. */
export function nativeProviderRebuildScenario(replaced: boolean) {
  const providerName = "nemoclaw-nvidia-prod-v1";
  const profile = "nemoclaw-nvidia-inference-v1";
  const id = "11111111-2222-4333-8444-555555555555";
  let backedUp = false;
  const reads: string[] = [];
  const overrides = {
    sandboxEntry: {
      provider: "nvidia-prod",
      model: "test/model",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      nativeNvidiaProviderAttachment: {
        schemaVersion: 1,
        providerName,
        profileId: profile,
        providerId: id,
      },
    },
    hydrateCredentialEnv: () => null,
    beforeBackup: () => {
      backedUp = true;
    },
    runOpenshell: (args: string[]) => {
      if (args[0] !== "provider") return undefined;
      let stdout: string;
      if (args[1] === "get") {
        reads.push(args[2]!);
        stdout = [
          `Name: ${providerName}`,
          `Type: ${profile}`,
          "Credential keys: NVIDIA_INFERENCE_API_KEY",
          "Config keys: <none>",
          `Id: ${backedUp && replaced ? "22222222-2222-4333-8444-555555555555" : id}`,
          "Resource version: 1",
        ].join("\n");
      } else if (args[1] === "list") {
        stdout = JSON.stringify([
          {
            name: providerName,
            credential_keys: ["NVIDIA_INFERENCE_API_KEY"],
            credential_expires_at_ms: {},
          },
        ]);
      } else return undefined;
      return { status: 0, stdout, output: stdout, stderr: "" };
    },
  };
  return { overrides, reads, providerName };
}
