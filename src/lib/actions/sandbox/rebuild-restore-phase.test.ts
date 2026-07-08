// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as policies from "../../policy";
import * as sandboxState from "../../state/sandbox";
import { MCP_BRIDGE_POLICY_SOURCE } from "./mcp-bridge-contracts";
import {
  printSuccessfulRebuildSummary,
  resolveRestoredPolicyRegistryState,
} from "./rebuild-post-restore-phase";
import { runRebuildRestorePhase } from "./rebuild-restore-phase";

const BUILTIN_OBSERVABILITY_CONTENT =
  "network_policies:\n  observability-otlp-local:\n    name: observability-otlp-local\n";

describe("rebuild policy restore fidelity", () => {
  beforeEach(() => {
    vi.spyOn(policies, "loadPresetForSandbox").mockImplementation((_sandboxName, presetName) =>
      presetName === "observability-otlp-local" ? BUILTIN_OBSERVABILITY_CONTENT : null,
    );
    vi.spyOn(policies, "getPresetContentGatewayState").mockReturnValue("absent");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces a fresh OpenClaw plugin registry precondition failure", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.fn();
    vi.spyOn(sandboxState, "restoreRecreatedSandboxState").mockReturnValue({
      success: false,
      restoredDirs: [],
      restoredFiles: [],
      failedDirs: ["extensions"],
      failedFiles: [],
      error: "could not read fresh OpenClaw plugin install registry",
    });

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: { agentType: "openclaw", backupPath: "/tmp/rebuild-backup" } as never,
      policyPresets: [],
      customPolicies: [],
      reconcileManagedDcodeObservability: false,
      log,
    });

    expect(result.restoreSucceeded).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      "  Restore blocked: could not read fresh OpenClaw plugin install registry",
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("error=could not read fresh OpenClaw plugin install registry"),
    );
  });

  it("replays custom web-policy names from exact content instead of same-name built-ins", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const parsePresetPolicyKeys = vi.spyOn(policies, "parsePresetPolicyKeys");
    const restoreRecreatedSandboxState = vi
      .spyOn(sandboxState, "restoreRecreatedSandboxState")
      .mockReturnValue({
        success: true,
        restoredDirs: [],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });
    const applyPreset = vi.spyOn(policies, "applyPreset").mockReturnValue(true);
    const applyPresetContent = vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
    const customPolicies = ["brave", "tavily", "nous-web"].map((name) => ({
      name,
      content: `network_policies:\n  ${name}-custom:\n    name: ${name}-custom\n`,
      sourcePath: `/tmp/${name}.yaml`,
    }));
    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: {
        agentType: "openclaw",
        backupPath: "/tmp/rebuild-backup",
        customPolicies,
      } as never,
      policyPresets: ["npm", "brave", "tavily", "nous-web"],
      customPolicies,
      reconcileManagedDcodeObservability: false,
      log: vi.fn(),
    });

    expect(restoreRecreatedSandboxState).toHaveBeenCalledWith("alpha", "/tmp/rebuild-backup", {
      targetAgentType: "openclaw",
    });
    expect(applyPreset).toHaveBeenCalledOnce();
    expect(applyPreset).toHaveBeenCalledWith("alpha", "npm");
    for (const entry of customPolicies) {
      expect(applyPresetContent).toHaveBeenCalledWith("alpha", entry.name, entry.content, {
        custom: { sourcePath: entry.sourcePath },
      });
    }
    expect(result.restoredPresets).toEqual(["npm", "brave", "tavily", "nous-web"]);
    expect(result.failedPresets).toEqual([]);
    expect(result.finalPresets).toEqual(["npm", "brave", "tavily", "nous-web"]);
    expect(result.policyPresetReconciliationVerified).toBe(true);
    expect(policies.loadPresetForSandbox).not.toHaveBeenCalled();
    expect(parsePresetPolicyKeys).not.toHaveBeenCalled();
  });

  it("replays captured registry custom policies during stale recovery without a backup", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(sandboxState, "restoreSandboxState").mockReturnValue({
      success: true,
      restoredDirs: [],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    const applyPresetContent = vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
    const customPolicies = [
      {
        name: "custom-egress",
        content: "network_policies:\n  custom-egress: {}\n",
        sourcePath: "/tmp/custom-egress.yaml",
      },
    ];
    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: [],
      customPolicies,
      reconcileManagedDcodeObservability: false,
      log: vi.fn(),
    });

    expect(applyPresetContent).toHaveBeenCalledWith(
      "alpha",
      "custom-egress",
      customPolicies[0]!.content,
      { custom: { sourcePath: "/tmp/custom-egress.yaml" } },
    );
    expect(result.restoredPresets).toEqual(["custom-egress"]);
    expect(result.finalPresets).toEqual(["custom-egress"]);
  });

  it("leaves generated MCP policy replay exclusively to MCP restoration", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const applyPresetContent = vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
    const genuineCustomPolicy = {
      name: "custom-egress",
      content: "network_policies:\n  custom-egress: {}\n",
      sourcePath: "/tmp/custom-egress.yaml",
    };
    const generatedMcpPolicy = {
      name: "mcp-bridge-search",
      content:
        "network_policies:\n  mcp-bridge-search:\n    endpoints:\n      - host: mcp.example.com\n        allowed_ips: [203.0.113.10]\n",
      sourcePath: MCP_BRIDGE_POLICY_SOURCE,
    };
    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: [],
      customPolicies: [genuineCustomPolicy, generatedMcpPolicy],
      reconcileManagedDcodeObservability: false,
      log: vi.fn(),
    });

    expect(applyPresetContent).toHaveBeenCalledOnce();
    expect(applyPresetContent).toHaveBeenCalledWith(
      "alpha",
      genuineCustomPolicy.name,
      genuineCustomPolicy.content,
      { custom: { sourcePath: genuineCustomPolicy.sourcePath } },
    );
    expect(result.restoredPresets).toEqual([genuineCustomPolicy.name]);
    expect(result.failedPresets).toEqual([]);
  });

  it("removes an observability preset introduced while rebuilding a restricted sandbox", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(policies, "applyPreset").mockReturnValue(true);
    vi.spyOn(policies, "getPresetContentGatewayState")
      .mockReturnValueOnce("match")
      .mockReturnValueOnce("absent");
    const removePreset = vi.spyOn(policies, "removePreset").mockReturnValue(true);

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: ["npm"],
      customPolicies: [],
      reconcileManagedDcodeObservability: true,
      log: vi.fn(),
    });

    expect(removePreset).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
    });
    expect(result.finalPresets).toEqual(["npm"]);
    expect(result.failedPresetRemovals).toEqual([]);
    expect(result.policyPresetReconciliationVerified).toBe(true);
  });

  it("retains an observed exact built-in when post-removal verification is unavailable", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(policies, "applyPreset").mockReturnValue(true);
    vi.spyOn(policies, "getPresetContentGatewayState")
      .mockReturnValueOnce("match")
      .mockReturnValueOnce(null);
    vi.spyOn(policies, "removePreset").mockReturnValue(true);

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: ["npm"],
      customPolicies: [],
      reconcileManagedDcodeObservability: true,
      log: vi.fn(),
    });

    expect(result.finalPresets).toEqual(["npm", "observability-otlp-local"]);
    expect(result.policyPresetReconciliationVerified).toBe(false);
  });

  it("accounts for known failed additions without treating a narrower live set as unverified", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(policies, "applyPreset")
      .mockImplementationOnce((_name, presetName) => {
        expect(presetName).toBe("npm");
        return true;
      })
      .mockImplementationOnce((_name, presetName) => {
        expect(presetName).toBe("bad");
        return false;
      })
      .mockImplementationOnce((_name, presetName) => {
        expect(presetName).toBe("throw");
        throw new Error("apply failed");
      });

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: ["npm", "bad", "throw"],
      customPolicies: [],
      reconcileManagedDcodeObservability: false,
      log: vi.fn(),
    });

    expect(result.restoredPresets).toEqual(["npm"]);
    expect(result.failedPresets).toEqual(["bad", "throw"]);
    expect(result.finalPresets).toEqual(["npm"]);
    expect(result.failedPresetRemovals).toEqual([]);
    expect(result.policyPresetReconciliationVerified).toBe(true);
  });

  it("keeps reconciliation unverified when a reported successful addition is missing live", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(policies, "applyPreset").mockReturnValue(true);

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: ["observability-otlp-local"],
      customPolicies: [],
      reconcileManagedDcodeObservability: true,
      log: vi.fn(),
    });

    expect(result.restoredPresets).toEqual(["observability-otlp-local"]);
    expect(result.failedPresets).toEqual([]);
    expect(result.finalPresets).toEqual([]);
    expect(result.policyPresetReconciliationVerified).toBe(false);
  });

  it("retains target built-in attribution when exact post-apply verification is unavailable", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(policies, "applyPreset").mockReturnValue(true);
    vi.spyOn(policies, "getPresetContentGatewayState").mockReturnValue(null);

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: ["observability-otlp-local"],
      customPolicies: [],
      reconcileManagedDcodeObservability: true,
      log: vi.fn(),
    });

    expect(result.finalBuiltinPresets).toEqual(["observability-otlp-local"]);
    expect(result.policyPresetReconciliationVerified).toBe(false);
  });

  it("does not remove or persist DCode base-policy keys detected as broad presets", () => {
    const removePreset = vi.spyOn(policies, "removePreset");

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: [],
      customPolicies: [],
      reconcileManagedDcodeObservability: true,
      log: vi.fn(),
    });

    expect(removePreset).not.toHaveBeenCalled();
    expect(result.finalPresets).toEqual([]);
    expect(result.failedPresetRemovals).toEqual([]);
    expect(result.policyPresetReconciliationVerified).toBe(true);
  });

  it("leaves a same-name custom observability policy outside built-in narrowing", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const applyPresetContent = vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
    const removePreset = vi.spyOn(policies, "removePreset");
    const customPolicy = {
      name: "observability-otlp-local",
      content: "network_policies:\n  operator-collector: {}\n",
      sourcePath: "/tmp/operator-collector.yaml",
    };

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: [],
      customPolicies: [customPolicy],
      reconcileManagedDcodeObservability: true,
      log: vi.fn(),
    });

    expect(applyPresetContent).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      { custom: { sourcePath: customPolicy.sourcePath } },
    );
    expect(removePreset).not.toHaveBeenCalled();
    expect(result.finalPresets).toEqual([customPolicy.name]);
    expect(result.policyPresetReconciliationVerified).toBe(true);
  });

  it("leaves a differently named custom policy owning observability egress outside built-in narrowing", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const applyPresetContent = vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
    const exactState = vi.spyOn(policies, "getPresetContentGatewayState").mockReturnValue("match");
    const removePreset = vi.spyOn(policies, "removePreset");
    const customPolicy = {
      name: "corp-otel",
      content:
        "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: collector.corp.example\n",
      sourcePath: "/tmp/corp-otel.yaml",
    };

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: [],
      customPolicies: [customPolicy],
      reconcileManagedDcodeObservability: true,
      log: vi.fn(),
    });

    expect(applyPresetContent).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      { custom: { sourcePath: customPolicy.sourcePath } },
    );
    expect(exactState).toHaveBeenCalledWith("alpha", customPolicy.content);
    expect(removePreset).not.toHaveBeenCalled();
    expect(result.finalPresets).toEqual([customPolicy.name]);
    expect(result.policyPresetReconciliationVerified).toBe(true);
  });

  it("removes an exact inner built-in behind a same-name custom with a different key", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const customPolicy = {
      name: "observability-otlp-local",
      content: "network_policies:\n  operator-collector: {}\n",
      sourcePath: "/tmp/operator-collector.yaml",
    };
    vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
    vi.spyOn(policies, "getPresetContentGatewayState")
      .mockReturnValueOnce("match")
      .mockReturnValueOnce("absent");
    const removePreset = vi.spyOn(policies, "removePreset").mockReturnValue(true);

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: ["observability-otlp-local"],
      customPolicies: [customPolicy],
      reconcileManagedDcodeObservability: true,
      log: vi.fn(),
    });

    expect(removePreset).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
    });
    expect(result.finalPresets).toEqual([customPolicy.name]);
    expect(result.policyPresetReconciliationVerified).toBe(true);
  });

  it("removes an exact inner built-in when overlapping custom replay fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const customPolicy = {
      name: "corp-otel",
      content: "network_policies:\n  observability-otlp-local: {}\n",
      sourcePath: "/tmp/corp-otel.yaml",
    };
    vi.spyOn(policies, "applyPresetContent").mockReturnValue(false);
    vi.spyOn(policies, "getPresetContentGatewayState")
      .mockReturnValueOnce("match")
      .mockReturnValueOnce("absent");
    const removePreset = vi.spyOn(policies, "removePreset").mockReturnValue(true);

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: [],
      customPolicies: [customPolicy],
      reconcileManagedDcodeObservability: true,
      log: vi.fn(),
    });

    expect(result.failedPresets).toEqual([customPolicy.name]);
    expect(removePreset).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
    });
    expect(result.finalPresets).toEqual([]);
    expect(result.policyPresetReconciliationVerified).toBe(true);
  });

  it("leaves drift untouched and unverified when successful custom ownership is not exact", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const customPolicy = {
      name: "corp-otel",
      content: "network_policies:\n  observability-otlp-local: {}\n",
      sourcePath: "/tmp/corp-otel.yaml",
    };
    vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
    vi.spyOn(policies, "getPresetContentGatewayState").mockReturnValue("drift");
    const removePreset = vi.spyOn(policies, "removePreset");

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: [],
      customPolicies: [customPolicy],
      reconcileManagedDcodeObservability: true,
      log: vi.fn(),
    });

    expect(removePreset).not.toHaveBeenCalled();
    expect(result.finalPresets).toEqual([customPolicy.name]);
    expect(result.policyPresetReconciliationVerified).toBe(false);
  });

  it("retains separate built-in attribution when same-name custom removal is unverified", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const customPolicy = {
      name: "observability-otlp-local",
      content: "network_policies:\n  operator-collector: {}\n",
      sourcePath: "/tmp/operator-collector.yaml",
    };
    vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
    vi.spyOn(policies, "getPresetContentGatewayState")
      .mockReturnValueOnce("match")
      .mockReturnValueOnce(null);
    vi.spyOn(policies, "removePreset").mockReturnValue(true);

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: ["observability-otlp-local"],
      customPolicies: [customPolicy],
      reconcileManagedDcodeObservability: true,
      log: vi.fn(),
    });

    expect(result.finalPresets).toEqual(["observability-otlp-local"]);
    expect(result.finalBuiltinPresets).toEqual(["observability-otlp-local"]);
    expect(result.policyPresetReconciliationVerified).toBe(false);
    expect(
      resolveRestoredPolicyRegistryState(
        { policyPresetsFinalized: true },
        result.finalBuiltinPresets,
        result.failedPresets,
        result.policyPresetReconciliationVerified,
      ),
    ).toEqual({
      policies: ["observability-otlp-local"],
      policyPresetsFinalized: undefined,
    });
  });

  it("keeps finalized custom-only policy state empty after exact replay", () => {
    expect(resolveRestoredPolicyRegistryState({ policyPresetsFinalized: true }, [], [])).toEqual({
      policies: [],
      policyPresetsFinalized: true,
    });
    expect(
      resolveRestoredPolicyRegistryState({ policyPresetsFinalized: true }, [], ["tavily"])
        .policyPresetsFinalized,
    ).toBeUndefined();
  });

  it("retains the force-skipped backup warning in the successful final summary", () => {
    const writeLine = vi.fn();

    printSuccessfulRebuildSummary(
      {
        sandboxName: "alpha",
        backupManifest: null,
        backupWasForceSkipped: true,
        staleRecovery: false,
        rebuiltAgentName: "OpenClaw",
        expectedVersion: "2026.6.10",
      },
      writeLine,
    );

    const output = writeLine.mock.calls.flat().join("\n");
    expect(output).toContain("Sandbox 'alpha' rebuilt successfully");
    expect(output).toContain("Backup was skipped via --force after a total backup failure");
    expect(output).toContain("prior workspace state was not preserved");
  });
});
