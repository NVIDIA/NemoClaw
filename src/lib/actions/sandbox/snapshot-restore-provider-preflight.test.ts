// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../../messaging/manifest";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import * as s from "./snapshot/lifecycle-test-support";
import * as f from "./snapshot-restore-test-fixture";

function managedMessagingPlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "openclaw",
    workflow: "onboard",
    channels: [
      {
        channelId: "telegram",
        configured: true,
        active: true,
        disabled: false,
        inputs: [
          { inputId: "botToken", credentialAvailable: true },
          { inputId: "allowedIds", value: ["222222"] },
        ],
      },
    ],
    disabledChannels: [],
    credentialBindings: [
      {
        channelId: "telegram",
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        credentialAvailable: true,
        credentialHash: "test-only-hash",
      },
    ],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
    stateUpdates: [],
    healthChecks: [],
  } as unknown as SandboxMessagingPlan;
}

function managedOpenClawProfile() {
  return buildManagedStartupProfile({
    agent: "openclaw",
    inference: {
      routeProvider: "inference",
      upstreamProvider: "openai-api",
      model: "gpt-5.4",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-responses",
      primaryModelRef: "inference/gpt-5.4",
      compatibility: {},
    },
    dashboard: {
      agent: "openclaw",
      mode: "loopback",
      url: "http://127.0.0.1:18789",
      port: 18_789,
      bindAddress: "127.0.0.1",
      wslExposure: false,
    },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: null,
    observabilityEnabled: null,
    environment: {},
    corporateCa: null,
  });
}

beforeEach(f.resetSnapshotRestoreMocks);
afterEach(f.cleanupSnapshotRestoreMocks);

describe("managed snapshot provider preflight", () => {
  it("fails an ambiguous provider probe before deleting a forced destination", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const built = managedOpenClawProfile();
    const reference = `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`;
    f.getSandboxMock.mockImplementation(
      s.valueByName({
        alpha: {
          name: "alpha",
          agent: "openclaw",
          dashboardPort: 18_789,
          dashboardRemoteBindPrepared: false,
          imageTag: reference,
          openshellDriver: "docker",
          provider: "openai-api",
          model: "gpt-5.4",
          endpointUrl: null,
          preferredInferenceApi: "openai-responses",
          compatibleEndpointReasoning: null,
          toolDisclosure: "progressive",
          webSearchEnabled: false,
          webSearchProvider: null,
          messaging: { schemaVersion: 1, plan: managedMessagingPlan() },
          workload: {
            schemaVersion: 1,
            kind: "managed-image",
            reference,
            release: "v0.0.99",
            sourceRevision: "b".repeat(40),
            sourceCohort: "ghrun-123456-1",
            capabilityContractVersion: 1,
            startupProfileContractVersion: 1,
            encodedProfile: built.encodedProfile,
            startupProfileSha256: built.startupProfileSha256,
            credentialProxyReplayRequired: false,
            shared: true,
          },
        } as never,
        beta: {
          name: "beta",
          agent: "openclaw",
          dashboardPort: 19_789,
          imageTag: "nemoclaw-beta:test",
          openshellDriver: "docker",
          provider: "openai-api",
          model: "gpt-5.4",
        },
      }),
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "forward list": {
          status: 0,
          output: "alpha 127.0.0.1 18789 23189 running\nbeta 127.0.0.1 19789 24189 running\n",
        },
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.runOpenshellMock.mockImplementation(
      s.commandRouter({
        "provider get beta-telegram-bridge": () => ({
          status: 1,
          stdout: "",
          stderr: "gateway transport unavailable",
          output: "",
        }),
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "could not prove whether managed clone provider 'beta-telegram-bridge' exists",
    );
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });
});
