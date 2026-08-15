// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import { candidateQualificationEnvironment } from "../../agent/candidate-test-fixture";
import { createOnboardAgentSelector } from "../../onboard/agent-selection";
import {
  MANAGED_IMAGE_REPOSITORIES,
  managedImageRuntimeIdentity,
} from "../../onboard/managed-image/contract";
import { encodeManagedStartupProfile } from "../../onboard/managed-startup/profile";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import { requireRuntimeProviderDestructiveCleanupAuthority } from "../../onboard/runtime-provider/registry";
import type { SandboxEntry } from "../../state/registry/types";
import { resolveSandboxStatusAgent } from "./status-snapshot";

const PROVIDER_ID = "portable-test";

function piSandboxEntry(): SandboxEntry {
  const image = MANAGED_IMAGE_REPOSITORIES.pi;
  const digest = `sha256:${"1b".repeat(32)}`;
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("pi"));
  return {
    name: "pi-sandbox",
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

function stubQualification(): void {
  const env = candidateQualificationEnvironment();
  vi.stubEnv("NEMOCLAW_CANDIDATE_AGENTS", String(env.NEMOCLAW_CANDIDATE_AGENTS));
  vi.stubEnv(
    "NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT",
    String(env.NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT),
  );
  vi.stubEnv(
    "NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT_SHA256",
    String(env.NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT_SHA256),
  );
}

describe("Pi candidate operational surfaces", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_CANDIDATE_AGENTS", "");
    vi.stubEnv("NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT", "");
    vi.stubEnv("NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT_SHA256", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports Pi separately from its compute runtime in status (#7927)", () => {
    stubQualification();
    const entry = piSandboxEntry();

    const info = resolveSandboxStatusAgent(String(entry.agent));

    expect(info).toMatchObject({
      agentName: "pi",
      agentDisplayName: "Pi",
      agentRuntime: "terminal",
    });
    expect(info.agentLoadError).toBeUndefined();
    // The compute runtime stays a separate recorded identity, and the agent
    // identity never implies it.
    expect(entry.openshellDriver).toBe(PROVIDER_ID);
    expect(info.agentName).not.toBe(String(entry.openshellDriver));
  });

  it("names the withheld candidate in status diagnostics without qualification (#7927)", () => {
    const info = resolveSandboxStatusAgent("pi");

    expect(info.agentRuntime).toBe("unknown");
    expect(info.agentLoadError).toContain("release candidate");
    expect(info.agentDefinition).toBeNull();
  });

  it("keeps Pi inventory and log surfaces on the terminal runtime contract (#7927)", () => {
    stubQualification();

    const info = resolveSandboxStatusAgent("pi");

    // Terminal agents have no gateway log source and no dashboard port, so the
    // shared logs and inventory surfaces must not advertise one for Pi.
    expect(info.agentRuntime).toBe("terminal");
    expect(info.agentDefinition?.forwardPort).toBe(0);
    expect(info.agentDefinition?.healthProbe).toBeNull();
    expect(managedImageRuntimeIdentity("pi").workdir).toBe("/sandbox");
  });

  it("resumes a recorded Pi session without changing the agent (#7927)", async () => {
    stubQualification();
    const note = vi.fn();
    const prompt = vi.fn(async () => "1");
    const selectAgent = createOnboardAgentSelector({
      isNonInteractive: () => true,
      note,
      prompt,
    });

    const agent = await selectAgent({ resume: true, session: { agent: "pi" } });

    expect(agent?.name).toBe("pi");
    // A resumed session pins its recorded agent, so the picker never runs.
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
    const events: string[] = [];
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
      recordEvent: (value: string) => events.push(value),
    } as never);
    const registry = createRuntimeProviderBundleRegistry([[PROVIDER_ID, bundle]]);

    const authority = requireRuntimeProviderDestructiveCleanupAuthority(
      "pi-sandbox",
      piSandboxEntry(),
      registry,
    );

    expect(authority.provider.identity.id).toBe(PROVIDER_ID);
    // A shared managed image is never deleted by destroy; cleanup stays owned
    // by the provider rather than by any Pi-specific branch.
    expect(authority.workloadAction).toBe("retain");
  });
});
