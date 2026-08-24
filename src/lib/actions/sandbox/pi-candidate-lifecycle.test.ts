// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(() => ({ digests: [] as string[] }));

vi.mock("../../agent/candidate-authority", () => ({
  CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS: { pi: authority.digests },
  acceptedCandidateReceiptDigests: () => authority.digests,
}));

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import {
  type CandidateQualificationFixture,
  candidateQualificationEnvironment,
} from "../../agent/candidate-test-fixture";
import { loadAgent } from "../../agent/defs";
import { createOnboardAgentSelector } from "../../onboard/agent-selection";
import { MANAGED_IMAGE_REPOSITORIES } from "../../onboard/managed-image/contract";
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
    captureOpenshellForStatusImpl: async () => ({ status: 0, output: "" }),
    probeProviderHealthImpl: vi.fn(() => null),
    probeSandboxInferenceGatewayHealthImpl: vi.fn(async () => null),
    probeTerminalRuntimeHealth: vi.fn(() => ({ kind: "ok" as const, oomKillCount: 0 as const })),
  };
}

let fixture: CandidateQualificationFixture | null = null;

function qualify(): NodeJS.ProcessEnv {
  fixture = candidateQualificationEnvironment();
  authority.digests.push(fixture.receiptDigest);
  for (const [key, value] of Object.entries(fixture.env)) vi.stubEnv(key, String(value));
  return fixture.env;
}

describe("Pi candidate operational surfaces", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_CANDIDATE_AGENTS", "");
    vi.stubEnv("NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    authority.digests.splice(0, authority.digests.length);
    fixture?.cleanup();
    fixture = null;
  });

  it("reports Pi separately from its compute runtime in the status report (#7927)", async () => {
    qualify();
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

  it("names the withheld candidate in the status report without qualification (#7927)", async () => {
    const report = await getSandboxStatusReport(SANDBOX, statusDeps(piSandboxEntry()));

    expect(report.agent).toBe("pi");
    expect(report.agentRuntime).toBe("unknown");
    expect(report.agentLoadError).toContain("release candidate");
  });

  it("keeps a recorded Pi sandbox off the gateway log source (#7927)", () => {
    const env = qualify();
    const agent = loadAgent("pi", env);
    const runOpenshell = vi.fn((args: string[]) => ({ status: 0, stdout: args.join(" ") }));
    const exitCodes: number[] = [];

    showSandboxLogsWithDeps(
      SANDBOX,
      { follow: false, lines: "50", since: null },
      {
        exit: ((code: number) => {
          exitCodes.push(code);
        }) as never,
        isDockerRuntimeDown: () => false,
        getOpenshellBinary: () => "openshell",
        getSessionAgent: () => agent,
        runOpenshell: runOpenshell as never,
        writeStdout: () => {},
      },
    );

    // A terminal agent advertises no gateway, so logs must read the sandbox
    // source alone and never probe the OpenClaw gateway.
    expect(runOpenshell).toHaveBeenCalled();
    expect(exitCodes).toEqual([0]);
    expect(runOpenshell.mock.calls.every(([args]) => !args.join(" ").includes("openclaw"))).toBe(true);
    expect(agent.forwardPort).toBe(0);
    expect(agent.healthProbe).toBeNull();
  });

  it("resumes a recorded Pi session without changing the agent (#7927)", async () => {
    qualify();
    const note = vi.fn();
    const prompt = vi.fn(async () => "1");
    const selectAgent = createOnboardAgentSelector({
      isNonInteractive: () => true,
      note,
      prompt,
    });

    const agent = await selectAgent({ resume: true, session: { agent: "pi" } });

    expect(agent?.name).toBe("pi");
    expect(prompt).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(expect.stringContaining("Pi"));
  });

  it("refuses to resume a Pi session without qualification authority (#7927)", async () => {
    const selectAgent = createOnboardAgentSelector({
      isNonInteractive: () => true,
      note: vi.fn(),
      prompt: vi.fn(async () => "1"),
    });

    // Falling back to OpenClaw would silently change the agent the session was
    // created with, so the withheld candidate must fail closed instead.
    await expect(selectAgent({ resume: true, session: { agent: "pi" } })).rejects.toThrow(
      "Agent 'pi' is a release candidate and is not selectable in this release",
    );
  });

  it("delegates Pi destroy cleanup to the selected compute-runtime provider (#7927)", () => {
    const bundle = createInMemoryRuntimeProviderBundle({
      providerId: PROVIDER_ID,
      workloadProfile: {
        support: {
          exactDigestReferences: true,
          platforms: ["linux/amd64", "linux/arm64"],
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
