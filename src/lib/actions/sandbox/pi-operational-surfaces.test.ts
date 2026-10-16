// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/wsl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/wsl")>()),
  isWsl: () => false,
}));

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import { loadAgent } from "../../agent/defs";
import { createOnboardAgentSelector } from "../../onboard/agent-selection";
import {
  MANAGED_IMAGE_REPOSITORIES,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../../onboard/managed-image/contract";
import { encodeManagedStartupProfile } from "../../onboard/managed-startup/profile";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import type { SandboxEntry } from "../../state/registry/types";
import { requireSandboxDestructiveCleanupAuthority } from "./destroy";
import { showSandboxLogsWithDeps } from "./logs";
import { getSandboxStatusReport } from "./status";

const PROVIDER_ID = "portable-test";
const SANDBOX = "pi-sandbox";

function piSandboxEntry(): SandboxEntry {
  const image = MANAGED_IMAGE_REPOSITORIES.pi;
  const digest = `sha256:${"1b".repeat(32)}`;
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("pi"));
  return {
    name: SANDBOX,
    agent: "pi",
    openshellDriver: PROVIDER_ID,
    fromDockerfile: null,
    imageTag: `${image}@${digest}`,
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference: `${image}@${digest}`,
      platform: "linux/amd64",
      release: "v0.0.99",
      sourceRevision: "c".repeat(40),
      sourceCohort: "ghrun-7927-2",
      capabilityContractVersion: 1,
      startupProfileContractVersion: 1,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
      credentialProxyReplayRequired: false,
      shared: true,
    },
  } as unknown as SandboxEntry;
}

function statusDeps(entry: SandboxEntry) {
  return {
    getSandbox: () => entry,
    listSandboxes: () => ({ sandboxes: [entry], defaultSandbox: SANDBOX }),
    reconcile: async () => ({
      state: "present" as const,
      output: `Name: ${SANDBOX}\nPhase: Ready\n`,
    }),
    inferenceRouteObserver: {
      observeInferenceRoute: async () => ({ ok: true, value: { state: "unconfigured" } }) as const,
    },
    probeProviderHealthImpl: vi.fn(() => null),
    probeSandboxInferenceGatewayHealthImpl: vi.fn(async () => null),
    probeTerminalRuntimeHealth: vi.fn(() => ({ kind: "ok" as const, oomKillCount: 0 as const })),
  };
}

function onHost(platform: NodeJS.Platform): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

function nonInteractiveSelector(note = vi.fn(), prompt = vi.fn(async () => "1")) {
  return createOnboardAgentSelector({ isNonInteractive: () => true, note, prompt });
}

describe("Pi operational surfaces", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports Pi separately from its compute runtime in the status report (#7927)", async () => {
    const entry = piSandboxEntry();

    const report = await getSandboxStatusReport(SANDBOX, statusDeps(entry));

    expect(report).toMatchObject({
      name: SANDBOX,
      found: true,
      agent: "pi",
      agentDisplayName: "Pi",
      agentRuntime: "terminal",
    });
    expect(report).not.toHaveProperty("agentLoadError");
    expect(entry.openshellDriver).toBe(PROVIDER_ID);
    expect(report.agent).not.toBe(String(entry.openshellDriver));
  });

  it("keeps a recorded Pi sandbox off the gateway log source (#7927)", async () => {
    const agent = loadAgent("pi");
    const readLogs = vi.fn(async (request: { source: "gateway" | "openshell" }) => ({
      content: request.source,
      diagnostic: "",
      outcome: { kind: "completed" as const, exitCode: 0 },
    }));
    const exitCodes: number[] = [];

    await showSandboxLogsWithDeps(
      SANDBOX,
      { follow: false, lines: "50", since: null },
      {
        exit: ((code: number) => {
          exitCodes.push(code);
        }) as never,
        isDockerRuntimeDown: () => false,
        getSessionAgent: () => agent,
        enableAuditLogs: async () => ({ ok: true, value: undefined }),
        logs: { checkAvailability: () => null, read: readLogs, follow: vi.fn() as never },
        writeStdout: () => {},
      },
    );

    // A terminal agent advertises no gateway, so logs must read the sandbox
    // source alone and never probe the OpenClaw gateway.
    expect(readLogs).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ source: "openshell", sandboxName: SANDBOX }),
    );
    expect(exitCodes).toEqual([0]);
    expect(agent.forwardPort).toBe(0);
    expect(agent.healthProbe).toBeNull();
  });

  it("resumes a recorded Pi session without changing the agent (#7927)", async () => {
    onHost("linux");
    const note = vi.fn();
    const prompt = vi.fn(async () => "1");

    const agent = await nonInteractiveSelector(
      note,
      prompt,
    )({
      resume: true,
      session: { agent: "pi" },
    });

    expect(agent?.name).toBe("pi");
    expect(prompt).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(expect.stringContaining("Pi"));
  });

  it("refuses to resume a recorded Pi session on a macOS host", async () => {
    onHost("darwin");

    await expect(
      nonInteractiveSelector()({ resume: true, session: { agent: "pi" } }),
    ).rejects.toThrow("Agent 'pi' is supported only on native Linux hosts; this host is macOS.");
  });

  it("delegates Pi destroy cleanup to the selected compute-runtime provider (#7927)", () => {
    const bundle = createInMemoryRuntimeProviderBundle({
      providerId: PROVIDER_ID,
      workloadProfile: {
        support: {
          exactDigestReferences: true,
          platforms: ["linux/amd64", "linux/arm64"],
          agents: SHIPPED_MANAGED_IMAGE_AGENTS,
          startupProfileContractVersions: [1],
          capabilityContractVersions: [1],
        },
        hostArchitectures: ["amd64", "arm64"],
        managedImageSelectionPolicy: "require-managed",
        legacyDockerfileBuilds: false,
      },
      recordEvent: () => {},
    } as never);
    const registry = createRuntimeProviderBundleRegistry([[PROVIDER_ID, bundle]]);

    const authorityResult = requireSandboxDestructiveCleanupAuthority(
      SANDBOX,
      piSandboxEntry(),
      registry,
    );

    expect(authorityResult.provider.identity.id).toBe(PROVIDER_ID);
    // A shared managed image is never deleted by destroy; cleanup stays owned
    // by the provider rather than by any Pi-specific branch.
    expect(authorityResult.workloadAction).toBe("retain");
  });
});
