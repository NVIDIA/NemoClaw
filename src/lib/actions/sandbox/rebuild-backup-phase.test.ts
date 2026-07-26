// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as sandboxState from "../../state/sandbox";
import {
  normalizeRebuildObservabilityPolicyPresets,
  normalizeRebuildTargetPolicyPresets,
  normalizeRebuildWebSearchPolicyPresets,
  type RebuildBackupPhaseInput,
  runRebuildBackupPhase,
} from "./rebuild-backup-phase";

describe("rebuild web-search policy normalization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps only the durable Tavily provider and removes stale nous-web", () => {
    expect(
      normalizeRebuildWebSearchPolicyPresets(
        ["npm", "brave", "nous-web", "tavily"],
        { name: "alpha", agent: "hermes" },
        { fetchEnabled: true, provider: "tavily" },
      ),
    ).toEqual(["npm", "tavily"]);
    expect(
      normalizeRebuildWebSearchPolicyPresets(
        ["npm", "brave"],
        { name: "alpha", agent: "hermes" },
        { fetchEnabled: true, provider: "tavily" },
      ),
    ).toEqual(["npm", "tavily"]);
  });

  it("removes both built-in providers for an authoritative disable", () => {
    expect(
      normalizeRebuildWebSearchPolicyPresets(
        ["npm", "brave", "tavily"],
        { name: "alpha", agent: "openclaw" },
        null,
      ),
    ).toEqual(["npm"]);
  });

  it("preserves DCode's standalone Tavily and excludes custom names from built-in replay", () => {
    expect(
      normalizeRebuildWebSearchPolicyPresets(
        ["npm", "tavily"],
        { name: "alpha", agent: "langchain-deepagents-code" },
        null,
      ),
    ).toEqual(["npm", "tavily"]);
    expect(
      normalizeRebuildWebSearchPolicyPresets(
        ["npm", "tavily"],
        {
          name: "alpha",
          agent: "openclaw",
          customPolicies: [{ name: "tavily", content: "allow: []" }],
        },
        null,
      ),
    ).toEqual(["npm"]);
  });

  it("keeps a finalized custom-only built-in selection empty instead of resetting it", () => {
    const result = runRebuildBackupPhase({
      sandboxName: "alpha",
      sandboxEntry: {
        name: "alpha",
        agent: "openclaw",
        policies: ["tavily"],
        customPolicies: [{ name: "tavily", content: "allow: []" }],
        policyPresetsFinalized: true,
      },
      staleRecovery: false,
      preparedRecoveryManifest: {
        policyPresets: ["tavily"],
        customPolicies: [{ name: "tavily", content: "allow: []" }],
      } as never,
      messagingPlan: null,
      webSearchConfig: null,
      log: vi.fn(),
      bail: (message): never => {
        throw new Error(message);
      },
      relockShieldsIfNeeded: () => true,
    });

    expect(result?.policyPresets).toEqual([]);
    expect(result?.sessionPolicyPresets).toEqual([]);
    expect(result?.backupWasForceSkipped).toBe(false);
  });

  it("records when --force skips a total backup failure", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(sandboxState, "backupSandboxState").mockReturnValue({
      success: false,
      backedUpDirs: [],
      backedUpFiles: [],
      failedDirs: [".openclaw"],
      failedFiles: ["openclaw.json"],
    });

    const result = runRebuildBackupPhase({
      sandboxName: "alpha",
      sandboxEntry: { name: "alpha", agent: "openclaw", policies: [] },
      staleRecovery: false,
      preparedRecoveryManifest: null,
      messagingPlan: null,
      webSearchConfig: null,
      force: true,
      log: vi.fn(),
      bail: (message): never => {
        throw new Error(message);
      },
      relockShieldsIfNeeded: () => true,
    });

    expect(result?.backupManifest).toBeNull();
    expect(result?.backupWasForceSkipped).toBe(true);
  });

  it("removes stale built-in observability egress from disabled and restricted rebuild targets", () => {
    expect(
      normalizeRebuildObservabilityPolicyPresets(["npm", "observability-otlp-local"], {
        name: "alpha",
        agent: "langchain-deepagents-code",
        observabilityEnabled: false,
        policyTier: "balanced",
      }),
    ).toEqual(["npm"]);
    expect(
      normalizeRebuildObservabilityPolicyPresets(["npm", "observability-otlp-local"], {
        name: "alpha",
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        policyTier: "restricted",
      }),
    ).toEqual(["npm"]);
    expect(
      normalizeRebuildObservabilityPolicyPresets(["npm"], {
        name: "alpha",
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        policyTier: "balanced",
      }),
    ).toEqual(["npm", "observability-otlp-local"]);
  });

  it("leaves a same-name custom observability policy for exact custom replay", () => {
    expect(
      normalizeRebuildObservabilityPolicyPresets(["npm", "observability-otlp-local"], {
        name: "alpha",
        agent: "langchain-deepagents-code",
        observabilityEnabled: false,
        policyTier: "restricted",
        customPolicies: [{ name: "observability-otlp-local", content: "network_policies: {}" }],
      }),
    ).toEqual(["npm"]);
  });

  it("does not add built-in observability when a differently named custom policy owns its key", () => {
    expect(
      normalizeRebuildObservabilityPolicyPresets(["npm", "observability-otlp-local"], {
        name: "alpha",
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        policyTier: "balanced",
        customPolicies: [
          {
            name: "corp-otel",
            content:
              "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: collector.corp.example\n",
          },
        ],
      }),
    ).toEqual(["npm"]);
  });

  it("keeps fresh agent-required additions while suppressing stale restricted observability", () => {
    expect(
      normalizeRebuildTargetPolicyPresets(
        ["npm", "future-agent-required", "observability-otlp-local"],
        {
          name: "alpha",
          agent: "langchain-deepagents-code",
          observabilityEnabled: true,
          policyTier: " Restricted ",
        },
        null,
      ),
    ).toEqual(["npm", "future-agent-required"]);
  });
});

describe("custom OpenClaw plugin provenance rebuild guard (#6108)", () => {
  const completeMarkedManifest = {
    agentType: "openclaw",
    dir: "/sandbox/.openclaw",
    backupPath: "/tmp/custom-openclaw-backup",
    reconcileOpenClawImagePluginProvenance: true,
    openclawImagePluginInstalls: [],
  } as never;

  function customOpenClawInput(overrides: Record<string, unknown> = {}): RebuildBackupPhaseInput {
    return {
      sandboxName: "custom-openclaw",
      sandboxEntry: {
        name: "custom-openclaw",
        agent: "openclaw",
        fromDockerfile: "/tmp/Dockerfile.custom",
      },
      staleRecovery: false,
      preparedRecoveryManifest: null,
      messagingPlan: null,
      webSearchConfig: null,
      log: vi.fn(),
      bail: (message: string): never => {
        throw new Error(message);
      },
      relockShieldsIfNeeded: vi.fn(() => true),
      ...overrides,
    } as RebuildBackupPhaseInput;
  }

  it("blocks a live custom image with missing registry provenance before backup", () => {
    const backupStateForRebuild = vi.fn();
    const input = customOpenClawInput();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => runRebuildBackupPhase(input, backupStateForRebuild)).toThrow(
      "Custom-image OpenClaw plugin provenance is unavailable.",
    );

    expect(backupStateForRebuild).not.toHaveBeenCalled();
    expect(input.relockShieldsIfNeeded).toHaveBeenCalledWith(true);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("new sandbox name"));
    expect(errorLog).not.toHaveBeenCalledWith(
      expect.stringContaining("NEMOCLAW_RECREATE_WITHOUT_BACKUP"),
    );
    errorLog.mockRestore();
  });

  it("uses a marked prepared manifest when registry provenance is missing", () => {
    const backupStateForRebuild = vi.fn();
    const input = customOpenClawInput({ preparedRecoveryManifest: completeMarkedManifest });

    const result = runRebuildBackupPhase(input, backupStateForRebuild);

    expect(result?.backupManifest).toBe(completeMarkedManifest);
    expect(backupStateForRebuild).not.toHaveBeenCalled();
  });

  it("blocks an unmarked legacy prepared manifest before deletion", () => {
    const backupStateForRebuild = vi.fn();
    const input = customOpenClawInput({
      preparedRecoveryManifest: {
        agentType: "openclaw",
        dir: "/sandbox/.openclaw",
        backupPath: "/tmp/legacy-custom-openclaw-backup",
        openclawImagePluginInstalls: [],
      },
    });

    expect(() => runRebuildBackupPhase(input, backupStateForRebuild)).toThrow(
      "Custom-image OpenClaw plugin provenance is unavailable.",
    );

    expect(backupStateForRebuild).not.toHaveBeenCalled();
  });

  it("revalidates a newly generated backup manifest before deletion", () => {
    const backupStateForRebuild = vi.fn(() => ({
      agentType: "openclaw",
      dir: "/sandbox/.openclaw",
      backupPath: "/tmp/incomplete-custom-openclaw-backup",
      reconcileOpenClawImagePluginProvenance: true,
    }));
    const input = customOpenClawInput({
      sandboxEntry: {
        name: "custom-openclaw",
        agent: "openclaw",
        fromDockerfile: "/tmp/Dockerfile.custom",
        openclawImagePluginInstalls: [],
      },
    });

    expect(() => runRebuildBackupPhase(input, backupStateForRebuild as never)).toThrow(
      "Custom-image OpenClaw plugin provenance is unavailable.",
    );

    expect(backupStateForRebuild).toHaveBeenCalledOnce();
  });
});
