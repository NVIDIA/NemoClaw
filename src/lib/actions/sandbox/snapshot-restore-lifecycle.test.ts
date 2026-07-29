// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../../messaging/manifest";
import { decodeManagedStartupProfile } from "../../onboard/managed-startup/profile";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import { SANDBOX_CREATE_MAX_ARGUMENT_BYTES } from "../../onboard/sandbox-create/transport";
import { withSandboxMutationLock } from "../../state/mcp-lifecycle-lock";
import * as f from "./snapshot-restore-test-fixture";

const tempHomes: string[] = [];
const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

function managedMessagingPlan(
  agent: "openclaw" | "hermes",
  sandboxName: string,
  allowedId: string,
  credentialHash?: string,
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent,
    workflow: "onboard",
    channels: [
      {
        channelId: "telegram",
        configured: true,
        active: true,
        disabled: false,
        inputs: [
          { inputId: "botToken", credentialAvailable: true },
          { inputId: "allowedIds", value: [allowedId] },
        ],
      },
    ],
    disabledChannels: [],
    credentialBindings: credentialHash
      ? [
          {
            channelId: "telegram",
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
            credentialAvailable: true,
            credentialHash,
          },
        ]
      : [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
    stateUpdates: [],
    healthChecks: [],
  } as unknown as SandboxMessagingPlan;
}

function providerMetadata(name: string, type: string, credentialEnv: string): string {
  return [
    `Name: ${name}`,
    `Type: ${type}`,
    `Credential keys: ${credentialEnv}`,
    "Config keys: <none>",
    "",
  ].join("\n");
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

beforeEach(() => {
  f.resetSnapshotRestoreMocks();
});
afterEach(() => {
  f.cleanupSnapshotRestoreMocks();
  for (const tempHome of tempHomes.splice(0)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
describe("runSandboxSnapshot restore: lifecycle and destination safety", () => {
  it("requires proxy re-onboarding before mutating a forced managed-clone destination", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const built = managedOpenClawProfile();
    const reference = `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`;
    f.getSandboxMock.mockImplementation((name) => {
      if (name === "alpha") {
        return {
          name: "alpha",
          agent: "openclaw",
          dashboardPort: 18_789,
          imageTag: reference,
          openshellDriver: "docker",
          provider: "openai-api",
          model: "gpt-5.4",
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
            credentialProxyReplayRequired: true,
            shared: true,
          },
        } as never;
      }
      if (name === "beta") {
        return {
          name: "beta",
          agent: "openclaw",
          dashboardPort: 19_789,
          imageTag: "nemoclaw-beta:test",
          openshellDriver: "docker",
          provider: "openai-api",
          model: "gpt-5.4",
        };
      }
      return null;
    });
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
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    for (const name of PROXY_ENV_NAMES) vi.stubEnv(name, "");
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    const output = consoleError.mock.calls.flat().join("\n");
    expect(output).toContain("requires a credential-bearing proxy");
    expect(output).toContain("Re-onboard the source before retrying this restore");
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("bounds a managed clone launch before deleting a forced destination", async () => {
    const built = buildManagedStartupProfile({
      agent: "langchain-deepagents-code",
      inference: {
        routeProvider: "inference",
        upstreamProvider: "openrouter",
        model: "openai/gpt-5.4",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        primaryModelRef: null,
        compatibility: null,
      },
      dashboard: { agent: "langchain-deepagents-code", mode: "disabled" },
      webSearch: null,
      toolDisclosure: "progressive",
      hermesToolGateways: [],
      messagingPlan: null,
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
      environment: {},
      corporateCa: null,
    });
    const reference = `registry.example.test/${"a".repeat(SANDBOX_CREATE_MAX_ARGUMENT_BYTES)}`;
    f.getSandboxMock.mockImplementation((name) => {
      if (name === "alpha") {
        return {
          name: "alpha",
          agent: "langchain-deepagents-code",
          imageTag: reference,
          openshellDriver: "docker",
          provider: "nvidia-nim",
          model: "nvidia/model-a",
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
        } as never;
      }
      if (name === "beta") {
        return {
          name: "beta",
          agent: "langchain-deepagents-code",
          imageTag: "nemoclaw-beta:test",
          openshellDriver: "docker",
          provider: "nvidia-nim",
          model: "nvidia/model-a",
        };
      }
      return null;
    });
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("idle") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
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
    ).rejects.toThrow(/safe per-argument transport limit/u);

    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid managed profile before deleting a forced destination", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const reference = `ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox@sha256:${"a".repeat(
      64,
    )}`;
    f.getSandboxMock.mockImplementation((name) => {
      if (name === "alpha") {
        return {
          name: "alpha",
          agent: "langchain-deepagents-code",
          imageTag: reference,
          openshellDriver: "docker",
          provider: "nvidia-nim",
          model: "nvidia/model-a",
          workload: {
            schemaVersion: 1,
            kind: "managed-image",
            reference,
            release: "v0.0.99",
            sourceRevision: "b".repeat(40),
            sourceCohort: "ghrun-123456-1",
            capabilityContractVersion: 1,
            startupProfileContractVersion: 1,
            encodedProfile: "e30",
            startupProfileSha256:
              "beab987bef9c00dfc301b490ddb45321517e7d6a6bb3d31d259898b7d46393d8",
            credentialProxyReplayRequired: false,
            shared: true,
          },
        } as never;
      }
      if (name === "beta") {
        return {
          name: "beta",
          agent: "langchain-deepagents-code",
          imageTag: "nemoclaw-beta:test",
          openshellDriver: "docker",
          provider: "nvidia-nim",
          model: "nvidia/model-a",
        };
      }
      return null;
    });
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("idle") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
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
      "source profile transport is not canonical and valid",
    );
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "malformed messaging state",
      { messaging: { schemaVersion: 2, plan: {} } },
      "current source messaging state is invalid",
    ],
    [
      "unknown tool disclosure",
      { toolDisclosure: "automatic" },
      "current source tool disclosure is invalid",
    ],
  ])("rejects %s before deleting a forced managed-clone destination", async (_label, currentOverride, expectedError) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const built = managedOpenClawProfile();
    const reference = `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`;
    f.getSandboxMock.mockImplementation((name) => {
      if (name === "alpha") {
        return {
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
          ...currentOverride,
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
        } as never;
      }
      if (name === "beta") {
        return {
          name: "beta",
          agent: "openclaw",
          dashboardPort: 19_789,
          imageTag: "nemoclaw-beta:test",
          openshellDriver: "docker",
          provider: "openai-api",
          model: "gpt-5.4",
        };
      }
      return null;
    });
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

    expect(consoleError.mock.calls.flat().join("\n")).toContain(expectedError);
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("rejects an incompatible destination provider binding before force-delete", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const built = managedOpenClawProfile();
    const currentMessaging = managedMessagingPlan("openclaw", "alpha", "222222");
    const reference = `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`;
    f.getSandboxMock.mockImplementation((name) => {
      if (name === "alpha") {
        return {
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
          messaging: { schemaVersion: 1, plan: currentMessaging },
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
        } as never;
      }
      if (name === "beta") {
        return {
          name: "beta",
          agent: "openclaw",
          dashboardPort: 19_789,
          imageTag: "nemoclaw-beta:test",
          openshellDriver: "docker",
          provider: "openai-api",
          model: "gpt-5.4",
        };
      }
      return null;
    });
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
    f.runOpenshellMock.mockImplementation((args) => {
      if (args.join(" ") === "provider get beta-telegram-bridge") {
        return {
          status: 0,
          stdout: providerMetadata("beta-telegram-bridge", "brave", "TELEGRAM_BOT_TOKEN"),
          stderr: "",
          output: "",
        };
      }
      return { status: 0, output: "" };
    });
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
      "exists with an incompatible type or credential binding",
    );
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("detaches and replaces an exact forced-destination provider with the explicit clone credential", async () => {
    const built = managedOpenClawProfile();
    const currentMessaging = managedMessagingPlan("openclaw", "alpha", "222222");
    const reference = `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`;
    const events: string[] = [];
    let destinationProviderExists = true;
    let registeredClone: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation((entry) => {
      registeredClone = entry as f.SandboxRecord;
    });
    f.getSandboxMock.mockImplementation((name) => {
      if (name === "alpha") {
        return {
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
          messaging: { schemaVersion: 1, plan: currentMessaging },
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
        } as never;
      }
      if (name === "beta") {
        return (
          registeredClone ?? {
            name: "beta",
            agent: "openclaw",
            dashboardPort: 19_789,
            imageTag: "nemoclaw-beta:test",
            openshellDriver: "docker",
            provider: "openai-api",
            model: "gpt-5.4",
          }
        );
      }
      return null;
    });
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
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "new-clone-token");
    f.runOpenshellMock.mockImplementation((args, options) => {
      const command = args.join(" ");
      if (command === "provider get beta-telegram-bridge") {
        return destinationProviderExists
          ? {
              status: 0,
              stdout: providerMetadata("beta-telegram-bridge", "generic", "TELEGRAM_BOT_TOKEN"),
              stderr: "",
              output: "",
            }
          : { status: 1, stdout: "", stderr: "", output: "" };
      }
      if (command === "sandbox provider detach beta beta-telegram-bridge") {
        events.push("detach");
        return { status: 0, output: "" };
      }
      if (command === "sandbox delete beta") {
        events.push("sandbox-delete");
        return { status: 0, output: "" };
      }
      if (command === "provider delete beta-telegram-bridge") {
        destinationProviderExists = false;
        events.push("provider-delete");
        return { status: 0, output: "" };
      }
      if (
        command ===
        "provider create --name beta-telegram-bridge --type generic --credential TELEGRAM_BOT_TOKEN"
      ) {
        expect(options?.env).toEqual({ TELEGRAM_BOT_TOKEN: "new-clone-token" });
        destinationProviderExists = true;
        events.push("provider-create:new-clone-token");
        return { status: 0, output: "" };
      }
      return { status: 0, output: "" };
    });
    f.streamSandboxCreateMock.mockImplementation(async () => {
      events.push("sandbox-create");
      return {
        status: 0,
        output: "",
        sawProgress: false,
        forcedReady: false,
      };
    });
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", {
      kind: "restore",
      to: "beta",
      force: true,
      yes: true,
    });

    expect(events.indexOf("detach")).toBeLessThan(events.indexOf("sandbox-delete"));
    expect(events.indexOf("sandbox-delete")).toBeLessThan(events.indexOf("provider-delete"));
    expect(events.indexOf("provider-delete")).toBeLessThan(
      events.indexOf("provider-create:new-clone-token"),
    );
    expect(events.indexOf("provider-create:new-clone-token")).toBeLessThan(
      events.indexOf("sandbox-create"),
    );
  });

  it("removes a rotated forced-target provider when downstream sandbox create fails", async () => {
    const built = managedOpenClawProfile();
    const currentMessaging = managedMessagingPlan("openclaw", "alpha", "222222");
    const reference = `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`;
    const events: string[] = [];
    let destinationProviderExists = true;
    let providerWasUpdated = false;
    let partialSandboxExists = false;
    let providerAttached = true;
    let sandboxDeleteCount = 0;
    let telegramDetachCount = 0;
    f.getSandboxMock.mockImplementation((name) => {
      if (name === "alpha") {
        return {
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
          messaging: { schemaVersion: 1, plan: currentMessaging },
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
        } as never;
      }
      if (name === "beta") {
        return {
          name: "beta",
          agent: "openclaw",
          dashboardPort: 19_789,
          imageTag: "nemoclaw-beta:test",
          openshellDriver: "docker",
          provider: "openai-api",
          model: "gpt-5.4",
        };
      }
      return null;
    });
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "forward list": {
          status: 0,
          output: "alpha 127.0.0.1 18789 23189 running\nbeta 127.0.0.1 19789 24189 running\n",
        },
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\n" },
      }),
    );
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "rotated-clone-token");
    f.runOpenshellMock.mockImplementation((args, options) => {
      const command = args.join(" ");
      if (command === "provider get beta-telegram-bridge") {
        return destinationProviderExists
          ? {
              status: 0,
              stdout: providerMetadata("beta-telegram-bridge", "generic", "TELEGRAM_BOT_TOKEN"),
              stderr: "",
              output: "",
            }
          : { status: 1, stdout: "", stderr: "", output: "" };
      }
      if (command === "sandbox provider detach beta beta-telegram-bridge") {
        telegramDetachCount += 1;
        if (telegramDetachCount === 2) {
          events.push("partial-provider-detach:failed");
          return {
            status: 1,
            stderr: "synthetic transient detach failure",
            stdout: "",
            output: "",
          };
        }
        events.push(
          telegramDetachCount === 1
            ? "initial-provider-detach"
            : "rollback-provider-detach:recovered",
        );
        providerAttached = false;
        return { status: 0, output: "" };
      }
      if (command === "sandbox delete beta") {
        sandboxDeleteCount += 1;
        if (sandboxDeleteCount === 1) {
          events.push("initial-sandbox-delete");
        } else {
          events.push("partial-sandbox-delete:failed");
          return { status: 1, stderr: "synthetic partial delete failure", output: "" };
        }
        return { status: 0, output: "" };
      }
      if (command === "provider delete beta-telegram-bridge") {
        if (!providerWasUpdated) {
          events.push("provider-delete:survived");
          return { status: 1, output: "" };
        }
        if (providerAttached) {
          events.push("provider-delete:blocked-attached");
          return {
            status: 1,
            stderr: "provider 'beta-telegram-bridge' is attached to sandbox(es): beta",
            stdout: "",
            output: "",
          };
        }
        destinationProviderExists = false;
        events.push("provider-delete:rollback");
        return { status: 0, output: "" };
      }
      if (command === "provider update beta-telegram-bridge --credential TELEGRAM_BOT_TOKEN") {
        expect(options?.env).toEqual({ TELEGRAM_BOT_TOKEN: "rotated-clone-token" });
        providerWasUpdated = true;
        events.push("provider-update:rotated-clone-token");
        return { status: 0, output: "" };
      }
      return { status: 0, output: "" };
    });
    f.streamSandboxCreateMock.mockImplementation(async () => {
      partialSandboxExists = true;
      providerAttached = true;
      events.push("sandbox-create:failed");
      return {
        status: 1,
        output: "synthetic create failure",
        sawProgress: false,
        forcedReady: false,
      };
    });
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

    expect(events.indexOf("provider-delete:survived")).toBeLessThan(
      events.indexOf("provider-update:rotated-clone-token"),
    );
    expect(events.indexOf("provider-update:rotated-clone-token")).toBeLessThan(
      events.indexOf("sandbox-create:failed"),
    );
    expect(events.indexOf("sandbox-create:failed")).toBeLessThan(
      events.indexOf("partial-provider-detach:failed"),
    );
    expect(events.indexOf("partial-provider-detach:failed")).toBeLessThan(
      events.indexOf("partial-sandbox-delete:failed"),
    );
    expect(events.indexOf("partial-sandbox-delete:failed")).toBeLessThan(
      events.indexOf("provider-delete:blocked-attached"),
    );
    expect(events.indexOf("provider-delete:blocked-attached")).toBeLessThan(
      events.indexOf("rollback-provider-detach:recovered"),
    );
    expect(events.indexOf("rollback-provider-detach:recovered")).toBeLessThan(
      events.indexOf("provider-delete:rollback"),
    );
    expect(partialSandboxExists).toBe(true);
    expect(destinationProviderExists).toBe(false);
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("refuses rollback recovery when provider attachment names an unrelated sandbox", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rollbackRunner = vi.fn((args: string[]) => {
      if (args.join(" ") === "provider delete beta-telegram-bridge") {
        return {
          status: 1,
          stdout: "",
          stderr: "provider 'beta-telegram-bridge' is attached to sandbox(es): beta, gamma",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const { cleanupManagedCloneProviders } = await import("./snapshot/managed-clone-providers");

    cleanupManagedCloneProviders(["beta-telegram-bridge"], rollbackRunner, "beta");

    expect(
      rollbackRunner.mock.calls.some(
        ([args]) => args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach",
      ),
    ).toBe(false);
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain(
      "could not clean up managed clone provider 'beta-telegram-bridge'",
    );
  });

  it("fails before force-delete when Hermes tool gateways need a fresh broker binding", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const built = buildManagedStartupProfile({
      agent: "hermes",
      inference: {
        routeProvider: "inference",
        upstreamProvider: "hermes-provider",
        model: "new-model",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: null,
        api: "openai-completions",
        primaryModelRef: null,
        compatibility: null,
      },
      dashboard: {
        agent: "hermes",
        mode: "disabled",
        url: "http://127.0.0.1:19189",
        publicPort: null,
        internalPort: null,
        tuiEnabled: false,
      },
      webSearch: { fetchEnabled: false, provider: "tavily" },
      toolDisclosure: "direct",
      hermesToolGateways: [],
      messagingPlan: null,
      dcodeAutoApprovalMode: null,
      observabilityEnabled: null,
      environment: {},
      corporateCa: null,
    });
    const reference = `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:${"a".repeat(64)}`;
    f.getSandboxMock.mockImplementation((name) => {
      if (name === "alpha") {
        return {
          name: "alpha",
          agent: "hermes",
          imageTag: reference,
          openshellDriver: "docker",
          provider: "hermes-provider",
          model: "new-model",
          endpointUrl: null,
          preferredInferenceApi: "openai-completions",
          toolDisclosure: "direct",
          webSearchEnabled: false,
          webSearchProvider: null,
          hermesToolGateways: ["nous-web"],
          hermesDashboardEnabled: false,
          messaging: undefined,
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
        } as never;
      }
      if (name === "beta") {
        return {
          name: "beta",
          agent: "hermes",
          imageTag: "nemoclaw-beta:test",
          openshellDriver: "docker",
          provider: "hermes-provider",
          model: "new-model",
        };
      }
      return null;
    });
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
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
      "fresh Nous OAuth refresh credential and destination broker binding",
    );
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("restores the latest snapshot into the source sandbox", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    f.getLatestBackupMock.mockReturnValue({
      snapshotVersion: 4,
      name: "stable",
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Using latest snapshot v4 name=stable");
    expect(output).toContain("Restoring snapshot into 'alpha'");
    expect(output).toContain("Restored 1 directories, 1 files");
  });

  it("delegates managed and custom-image snapshot restores to the state layer", async () => {
    f.getLatestBackupMock.mockReturnValue({
      snapshotVersion: 4,
      name: "stable",
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    f.getSandboxMock.mockReturnValue({ name: "alpha", agent: "langchain-deepagents-code" });
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");

    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      fromDockerfile: "/tmp/Dockerfile",
    });
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    expect(f.restoreSandboxStateMock).toHaveBeenCalledTimes(2);
  });

  it("keeps active-timer restore, permission repair, and policy reconciliation serialized", async () => {
    f.lifecycleMock.readTimerMarkerMock.mockReturnValue({
      pid: 4242,
      sandboxName: "alpha",
      snapshotPath: "/tmp/policy.yaml",
      restoreAt: "2026-06-27T06:00:00.000Z",
      processToken: "a".repeat(32),
    });
    f.getLatestBackupMock.mockReturnValue({
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      policyPresets: ["github"],
    });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.lifecycleMock.events).toContain("lock:restore sandbox snapshot");
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    expect(f.shieldsMock.repairMutableConfigPermsMock).toHaveBeenCalledWith("alpha");
    expect(f.applyPresetMock).toHaveBeenCalledWith("alpha", "github");
  });

  it("hardens an active timer window before force-deleting a restore destination", async () => {
    f.lifecycleMock.readTimerMarkerMock.mockReturnValue({
      pid: 4242,
      sandboxName: "beta",
      snapshotPath: "/tmp/policy.yaml",
      restoreAt: "2026-06-27T06:00:00.000Z",
      processToken: "b".repeat(32),
    });
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "openclaw",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          }
        : {
            name: "beta",
            agent: "openclaw",
            imageTag: "nemoclaw-beta:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          },
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", {
      kind: "restore",
      to: "beta",
      force: true,
      yes: true,
    });

    expect(f.shieldsMock.shieldsUpMock).toHaveBeenCalledWith("beta", {
      throwOnError: true,
      allowLegacyHermesProtocol: true,
    });
    expect(f.lifecycleMock.events.indexOf("harden")).toBeLessThan(
      f.lifecycleMock.events.indexOf("delete"),
    );
    expect(f.lifecycleMock.events.indexOf("delete")).toBeLessThan(
      f.lifecycleMock.events.indexOf("cleanup-shields"),
    );
    expect(f.streamSandboxCreateMock).toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
  });

  it("blocks auto-create before deleting a destination when a gateway peer conflicts", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    f.getSandboxMock.mockImplementation((name) => ({
      name: name ?? "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      imageTag: `nemoclaw-${name}:test`,
      openshellDriver: "docker",
      provider: name === "gamma" ? "anthropic-prod" : "nvidia-nim",
      model: name === "gamma" ? "claude-new" : "nvidia/model-a",
    }));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
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

    expect(consoleError.mock.calls.flat().join("\n")).toContain("gamma");
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("holds the source and destination mutation locks until a cross-sandbox restore finishes (#7178)", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-locks-"));
    tempHomes.push(tempHome);
    vi.stubEnv("HOME", tempHome);
    const events: string[] = [];
    let cloneCreated = false;
    let releaseCreate: (() => void) | undefined;
    let signalCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const createRelease = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "openclaw",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          }
        : null,
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": {
          status: 0,
          output: cloneCreated ? "alpha Ready\nbeta Ready\n" : "alpha Ready\n",
        },
      }),
    );
    f.streamSandboxCreateMock.mockImplementation(async () => {
      events.push("create-started");
      signalCreateStarted?.();
      await createRelease;
      cloneCreated = true;
      events.push("create-released");
      return { status: 0, output: "", sawProgress: false, forcedReady: false };
    });
    f.restoreSandboxStateMock.mockImplementation(() => {
      events.push("snapshot-restored");
      return {
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    const restore = runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });
    await createStarted;
    const sourceMutation = withSandboxMutationLock("alpha", () => {
      events.push("source-mutation");
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(events).toEqual(["create-started"]);

    releaseCreate?.();
    await restore;
    await sourceMutation;

    expect(events).toEqual([
      "create-started",
      "create-released",
      "snapshot-restored",
      "source-mutation",
    ]);
  });

  it("blocks a cross-sandbox clone before deleting the target when source policy repair is pending (#7178)", async () => {
    const common = {
      agent: "openclaw",
      openshellDriver: "docker",
      provider: "nvidia-nim",
      model: "nvidia/model-a",
    };
    f.getSandboxMock.mockImplementation((name) => {
      return name === "alpha"
        ? {
            ...common,
            name: "alpha",
            imageTag: "nemoclaw-alpha:test",
            baselineExclusionTransition: {
              id: "0b2f3297-a9ab-4c2f-80da-bf1760a1afbf",
              operation: "restore",
              exclusion: {
                version: 1 as const,
                agent: "openclaw",
                key: "agents.openclaw.default",
                digest: "a".repeat(64),
              },
              startedAt: "2026-07-19T00:00:00.000Z",
              targetLiveDigest: "b".repeat(64),
            },
          }
        : name === "beta"
          ? { ...common, name: "beta", imageTag: "nemoclaw-beta:test" }
          : null;
    });
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
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
    ).rejects.toThrow(
      "Cannot clone baseline policy while 'restore agents.openclaw.default' needs repair",
    );

    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("blocks a forced clone before deleting a destination whose policy repair is pending (#7178)", async () => {
    const pendingTransition = {
      id: "0b2f3297-a9ab-4c2f-80da-bf1760a1afbf",
      operation: "restore" as const,
      exclusion: {
        version: 1 as const,
        agent: "openclaw",
        key: "agents.openclaw.default",
        digest: "a".repeat(64),
      },
      startedAt: "2026-07-19T00:00:00.000Z",
      targetLiveDigest: "b".repeat(64),
    };
    f.getSandboxMock.mockImplementation((name) =>
      name
        ? {
            name,
            agent: "openclaw",
            imageTag: `nemoclaw-${name}:test`,
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
            ...(name === "beta" ? { baselineExclusionTransition: pendingTransition } : {}),
          }
        : null,
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });
});

describe("runSandboxSnapshot restore: gateway pairing on a freshly created destination", () => {
  it("provokes and approves device pairing after a cross-sandbox restore", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "openclaw",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          }
        : null,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta", yes: true });

    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
    expect(f.establishRestoredSandboxGatewayPairingMock).toHaveBeenCalledWith("beta");
  });

  it("fails with repair guidance when restored gateway pairing cannot be verified (#7431)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "openclaw",
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          }
        : null,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    f.establishRestoredSandboxGatewayPairingMock.mockImplementationOnce(() => {
      throw new Error("authenticated gateway verification failed");
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta", yes: true }),
    ).rejects.toMatchObject({
      exitCode: 1,
      lines: [
        "State restored into 'beta', but gateway pairing could not be verified.",
        "Run `nemoclaw beta connect` to retry pairing before running an agent.",
        expect.stringContaining("authenticated gateway verification failed"),
      ],
    });
  });

  it.each([
    "hermes",
    "langchain-deepagents-code",
  ])("does not run OpenClaw pairing for a cross-sandbox %s restore (#7431)", async (agent) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent,
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
          }
        : null,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta", yes: true });

    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("beta", "/tmp/backup-alpha");
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });

  it("leaves the working gateway credentials untouched on a self-restore", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith("alpha", "/tmp/backup-alpha");
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });
});
