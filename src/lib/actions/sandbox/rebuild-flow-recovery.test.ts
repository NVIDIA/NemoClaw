// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  policyGet,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import { fingerprintSandboxLiveIdentity } from "../../onboard/sandbox-recreate-transaction";
import {
  makeActiveTeamsMessagingPlan,
  makePreparedRecoveryManifest,
} from "./rebuild-flow-test-fixtures";

describe("rebuildSandbox flow: recovery", () => {
  installRebuildFlowTestHooks();

  it("uses marked manifest provenance when the custom-image registry baseline is missing (#6108)", async () => {
    const customDockerfile = path.join(process.cwd(), "Dockerfile");
    const recoveryManifest = {
      ...makePreparedRecoveryManifest(),
      reconcileOpenClawImagePluginProvenance: true,
      openclawImagePluginInstalls: [],
    };
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        fromDockerfile: customDockerfile,
        nemoclawVersion: null,
        openclawImagePluginInstalls: undefined,
      },
      preDeleteLatestManifest: recoveryManifest,
      managedImageEvidence: false,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).resolves.toBeUndefined();

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
      "alpha",
      recoveryManifest.backupPath,
      { targetAgentType: "openclaw", allowCustomImageWholeStateFileRestore: true },
    );
  });

  it("keeps an explicit default choice made while the replacement was in flight (#7734)", async () => {
    let harness!: ReturnType<typeof createRebuildFlowHarness>;
    harness = createRebuildFlowHarness({
      defaultSandbox: "alpha",
      defaultSelectionRevision: 10,
      onboard: () => {
        expect(harness.setDefault("beta")).toBe(true);
        throw new Error("recreate failed after explicit default choice");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Recreate failed");

    expect(harness.restoreSandboxEntrySpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha" }),
      {},
    );
    expect(harness.getDefaultSelectionState()).toEqual({
      defaultSandbox: "beta",
      defaultSelectionRevision: 11,
    });
  });

  it("keeps the default selection untouched across a journaled replacement (#7734)", async () => {
    let harness!: ReturnType<typeof createRebuildFlowHarness>;
    harness = createRebuildFlowHarness({
      defaultSandbox: "alpha",
      defaultSelectionRevision: 10,
      onboard: () => {
        expect(harness.getDefaultSelectionState()).toEqual({
          defaultSandbox: "alpha",
          defaultSelectionRevision: 10,
        });
        harness.registerSandboxEntry("alpha");
        throw new Error("recreate failed after replacement registration");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes", "--verbose"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");

    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
    expect(harness.restoreSandboxEntryIfMissingSpy).not.toHaveBeenCalled();
    expect(harness.getDefaultSelectionState()).toEqual({
      defaultSandbox: "alpha",
      defaultSelectionRevision: 10,
    });
  });

  const REPLACEMENT_PROBE = "Name: alpha\nId: sbx-replacement\nPhase: Ready\n";
  const FOREIGN_PROBE = "Name: alpha\nId: sbx-foreign\nPhase: Ready\n";
  const REPLACEMENT_IDENTITY = fingerprintSandboxLiveIdentity(REPLACEMENT_PROBE);
  const POST_DELETE_PHASES = ["creating", "created", "registry_committing", "completed"] as const;
  const provenReplacement = {
    sandboxEntry: {
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: REPLACEMENT_IDENTITY,
    },
  };

  // Journal a replacement through the real pipeline, then die at the given
  // post-delete phase so the restart reads persisted state, not a hand-built
  // checkpoint.
  async function interruptAfterCreate(phase: string): Promise<unknown> {
    const interrupted = createRebuildFlowHarness({
      ...provenReplacement,
      onboard: (session) => {
        Object.assign(
          (session.checkpoint as { sandboxRecreate: Record<string, unknown> }).sandboxRecreate,
          {
            phase,
            targetGeneration: "generation-1",
            targetLiveIdentityFingerprint: REPLACEMENT_IDENTITY,
          },
        );
        throw new Error("interrupted after replacement creation");
      },
    });
    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");
    return interrupted.session.checkpoint;
  }

  function restartRebuild(probe: string, checkpoint: unknown) {
    const restarted = createRebuildFlowHarness({
      ...provenReplacement,
      captureOpenshell: (argv) =>
        argv[0] === "sandbox" && argv[1] === "get"
          ? { status: 0, output: probe, stdout: probe, stderr: "" }
          : { status: 1, output: "", stdout: "", stderr: "Error: sandbox alpha not found" },
    });
    restarted.session.checkpoint = checkpoint;
    // Both harnesses share one spy per mocked module function, so the
    // interrupted run's calls have to be dropped before the restart.
    restarted.runOpenshellSpy.mockClear();
    restarted.onboardSpy.mockClear();
    return restarted;
  }

  it.each(POST_DELETE_PHASES)(
    "keeps a registered replacement when a rebuild restarts from '%s' (#7734)",
    async (phase) => {
      const restarted = restartRebuild(REPLACEMENT_PROBE, await interruptAfterCreate(phase));

      await restarted.rebuildSandbox("alpha", ["--yes"]);

      expectNoSandboxDelete(restarted.runOpenshellSpy);
      expect(restarted.onboardSpy).not.toHaveBeenCalled();
      expect(
        (restarted.session.checkpoint as { sandboxRecreate: unknown }).sandboxRecreate,
      ).toBeNull();
    },
  );

  it.each(POST_DELETE_PHASES)(
    "refuses a foreign same-name sandbox when a rebuild restarts from '%s' (#7734)",
    async (phase) => {
      const restarted = restartRebuild(FOREIGN_PROBE, await interruptAfterCreate(phase));

      await expect(restarted.rebuildSandbox("alpha", ["--yes"])).rejects.toThrow(
        /not the journaled replacement/,
      );

      expectNoSandboxDelete(restarted.runOpenshellSpy);
      expect(restarted.onboardSpy).not.toHaveBeenCalled();
    },
  );

  const SOURCE_PROBE = "Name: alpha\nId: sbx-source\nPhase: Ready\n";
  const MISSING_SOURCE = {
    status: 1,
    output: "",
    stdout: "",
    stderr: "Error: sandbox alpha not found",
  };
  const PRE_CREATE_PHASES = ["planned", "deleting", "deleted"] as const;
  const LIVE_SOURCE_PHASES = ["planned", "deleting"] as const;

  function sandboxGetProbes(probes: readonly (string | null)[]) {
    let gets = 0;
    return (argv: string[]) => {
      const probe =
        argv[0] === "sandbox" && argv[1] === "get"
          ? probes[Math.min(gets++, probes.length - 1)]
          : null;
      return probe ? { status: 0, output: probe, stdout: probe, stderr: "" } : MISSING_SOURCE;
    };
  }

  async function interruptBeforeCreate(phase: string): Promise<unknown> {
    const interrupted = createRebuildFlowHarness({
      captureOpenshell: sandboxGetProbes([SOURCE_PROBE, null]),
      onboard: (session) => {
        Object.assign(
          (session.checkpoint as { sandboxRecreate: Record<string, unknown> }).sandboxRecreate,
          { phase },
        );
        throw new Error("interrupted before replacement creation");
      },
    });
    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");
    return interrupted.session.checkpoint;
  }

  it("retains the exact policy handoff across a failed recreate and consumes it on retry", async () => {
    const policyDocument = "version: 1\nnetwork_policies:\n  host_preserved: {}\n";
    const interrupted = createRebuildFlowHarness({
      captureOpenshell: sandboxGetProbes([SOURCE_PROBE, null]),
      onboard: () => {
        throw new Error("replacement create failed");
      },
    });
    policyGet.getSandboxPolicy.mockReset().mockReturnValue({ yaml: policyDocument });

    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");

    const persistedManifest = JSON.parse(
      fs.readFileSync(path.join(interrupted.backupPath, "rebuild-manifest.json"), "utf8"),
    ) as { rebuildPolicyHandoff: { file: string } } & Record<string, unknown>;
    const handoffPath = path.join(
      interrupted.backupPath,
      persistedManifest.rebuildPolicyHandoff.file,
    );
    expect(fs.readFileSync(handoffPath, "utf8")).toBe(policyDocument);
    expect(fs.existsSync(path.join(interrupted.backupPath, ".nemoclaw-rebuild-recovery.json"))).toBe(
      true,
    );
    let recreatedPolicy = "";
    const restarted = createRebuildFlowHarness({
      staleRecovery: true,
      captureOpenshell: sandboxGetProbes([null]),
      onboard: (_session, options) => {
        recreatedPolicy = fs.readFileSync(String(options.rebuildPolicySourcePath), "utf8");
      },
    });
    restarted.session.checkpoint = interrupted.session.checkpoint;
    policyGet.getSandboxPolicy.mockReset().mockReturnValue({ yaml: "" });

    await expect(
      restarted.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: persistedManifest as never,
      }),
    ).resolves.toBeUndefined();

    expect(recreatedPolicy).toBe(policyDocument);
    expect(fs.existsSync(handoffPath)).toBe(false);
    expect(fs.existsSync(path.join(interrupted.backupPath, ".nemoclaw-rebuild-recovery.json"))).toBe(
      false,
    );
  });

  function restartFromJournaledSource(probes: readonly (string | null)[], checkpoint: unknown) {
    const restarted = createRebuildFlowHarness({
      captureOpenshell: sandboxGetProbes(probes),
    });
    restarted.session.checkpoint = checkpoint;
    restarted.runOpenshellSpy.mockClear();
    restarted.onboardSpy.mockClear();
    return restarted;
  }

  it.each(LIVE_SOURCE_PHASES)(
    "deletes the journaled source when a rebuild restarts from '%s' (#7734)",
    async (phase) => {
      const restarted = restartFromJournaledSource(
        [SOURCE_PROBE, SOURCE_PROBE, null],
        await interruptBeforeCreate(phase),
      );

      await restarted.rebuildSandbox("alpha", ["--yes"]);

      expect(restarted.runOpenshellSpy).toHaveBeenCalledWith(
        ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(restarted.onboardSpy).toHaveBeenCalled();
    },
  );

  it.each(PRE_CREATE_PHASES)(
    "creates the replacement without a second delete when a rebuild restarts from '%s' with the source already absent (#7734)",
    async (phase) => {
      const restarted = restartFromJournaledSource([null], await interruptBeforeCreate(phase));

      await restarted.rebuildSandbox("alpha", ["--yes"]);

      expectNoSandboxDelete(restarted.runOpenshellSpy);
      expect(restarted.onboardSpy).toHaveBeenCalled();
    },
  );

  it.each(LIVE_SOURCE_PHASES)(
    "stops before deletion when a same-name sandbox appears after a '%s' restart probe (#7734)",
    async (phase) => {
      const restarted = restartFromJournaledSource(
        [null, FOREIGN_PROBE],
        await interruptBeforeCreate(phase),
      );

      await expect(
        restarted.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow(/the live same-name sandbox is not the journaled source/);

      expectNoSandboxDelete(restarted.runOpenshellSpy);
      expect(restarted.onboardSpy).not.toHaveBeenCalled();
    },
  );

  it.each(LIVE_SOURCE_PHASES)(
    "refuses a changed same-name sandbox when a rebuild restarts from '%s' (#7734)",
    async (phase) => {
      const restarted = restartFromJournaledSource(
        [FOREIGN_PROBE, null],
        await interruptBeforeCreate(phase),
      );

      await expect(restarted.rebuildSandbox("alpha", ["--yes"])).rejects.toThrow(
        /no longer has the journaled source identity/,
      );

      expectNoSandboxDelete(restarted.runOpenshellSpy);
      expect(restarted.onboardSpy).not.toHaveBeenCalled();
    },
  );

  it("refuses a live same-name sandbox when a rebuild restarts from 'deleted' (#7734)", async () => {
    const restarted = restartFromJournaledSource(
      [SOURCE_PROBE, null],
      await interruptBeforeCreate("deleted"),
    );

    await expect(restarted.rebuildSandbox("alpha", ["--yes"])).rejects.toThrow(
      /appeared before replacement registration committed/,
    );

    expectNoSandboxDelete(restarted.runOpenshellSpy);
    expect(restarted.onboardSpy).not.toHaveBeenCalled();
  });

  it("performs exactly one prepared-recovery rollback when MCP state is present", async () => {
    const mcpEntry = { server: "github", providerName: "nemoclaw-mcp-alpha-github" };
    const harness = createRebuildFlowHarness({
      defaultSandbox: "alpha",
      sandboxEntry: { toolDisclosure: "progressive" },
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [mcpEntry],
      },
      onboard: () => {
        throw new Error("recreate failed");
      },
    });

    await expect(
      harness.rebuildSandbox(
        "alpha",
        { yes: true, toolDisclosure: "direct" },
        {
          throwOnError: true,
          recoveryManifest: makePreparedRecoveryManifest(),
        },
      ),
    ).rejects.toThrow("Recreate failed");

    expect(harness.restoreSandboxEntrySpy.mock.calls).toEqual([
      [expect.objectContaining({ name: "alpha", toolDisclosure: "progressive" }), {}],
    ]);
    expect(harness.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("rebuild --yes --tool-disclosure direct"),
    );
  });

  it("keeps the requested disclosure mode in a zero-MCP prepared-recovery retry", async () => {
    const harness = createRebuildFlowHarness({
      defaultSandbox: "alpha",
      sandboxEntry: { toolDisclosure: "progressive" },
      onboard: () => {
        throw new Error("recreate failed");
      },
    });

    await expect(
      harness.rebuildSandbox(
        "alpha",
        { yes: true, toolDisclosure: "direct" },
        {
          throwOnError: true,
          recoveryManifest: makePreparedRecoveryManifest(),
        },
      ),
    ).rejects.toThrow("Recreate failed");

    expect(harness.restoreSandboxEntrySpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha", toolDisclosure: "progressive" }),
      {},
    );
    expect(harness.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("onboard --resume --name alpha --tool-disclosure direct"),
    );
  });

  it("blocks installer recovery when MCP post-restore verification is incomplete", async () => {
    const mcpEntry = { server: "github", providerName: "nemoclaw-mcp-alpha-github" };
    const harness = createRebuildFlowHarness({
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [mcpEntry],
      },
      restoreMcpBridgesAfterRebuild: () => Promise.reject(new Error("MCP restore boom")),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Prepared backup recovery");

    expect(harness.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("MCP bridge restore incomplete: MCP restore boom"),
    );
    expect(harness.relockSpy).toHaveBeenCalled();
  });

  it("aborts before backup/delete when messaging manifest staging fails", async () => {
    const harness = createRebuildFlowHarness({
      buildMessagingRebuildPlan: () => {
        throw new Error("manifest boom");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("manifest boom");

    const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errors).toContain("messaging manifest plan could not be staged");
    expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("reattaches exactly the MCP providers detached when sandbox deletion fails", async () => {
    const attached = {
      server: "attached",
      providerName: "nemoclaw-mcp-alpha-attached",
    };
    const alreadyDetached = {
      server: "already-detached",
      providerName: "nemoclaw-mcp-alpha-already-detached",
    };
    const harness = createRebuildFlowHarness({
      mcpPreparation: {
        entries: [attached, alreadyDetached],
        detachedProviderEntries: [attached],
      },
      runOpenshell: (args) => {
        const deleteFailure = { status: 7, output: "delete failed", stderr: "delete failed" };
        const readySource = {
          status: 0,
          output: "Phase: Ready",
          stdout: "Phase: Ready",
          stderr: "",
        };
        const responses: Record<string, typeof deleteFailure | typeof readySource> = {
          "sandbox delete -g nemoclaw alpha": deleteFailure,
          "sandbox get -g nemoclaw alpha": readySource,
        };
        return responses[args.join(" ")];
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Failed to delete sandbox");

    expect(harness.reattachMcpProvidersAfterRebuildAbortSpy).toHaveBeenCalledWith(
      "alpha",
      [attached],
      undefined,
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("does not reclaim the default sandbox when an MCP rebuild recreate fails", async () => {
    const mcpEntry = {
      server: "github",
      providerName: "nemoclaw-mcp-alpha-github",
      policyName: "mcp-bridge-github",
    };
    const harness = createRebuildFlowHarness({
      defaultSandbox: "alpha",
      sandboxEntry: {},
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
      },
      onboard: () => {
        throw new Error("inner recreate boom");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");

    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
    expect(harness.restoreSandboxEntrySpy.mock.calls).toEqual([
      [expect.objectContaining({ name: "alpha" })],
    ]);
  });

  it("starts the active Teams host forward after a successful rebuild", async () => {
    const plan = makeActiveTeamsMessagingPlan();
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      buildMessagingRebuildPlan: () => plan,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.ensureMessagingHostForwardAfterRebuildSpy).toHaveBeenCalledWith("alpha", plan);
    expect(
      harness.ensureMessagingHostForwardAfterRebuildSpy.mock.invocationCallOrder[0],
    ).toBeGreaterThan(harness.onboardSpy.mock.invocationCallOrder[0]);
  });

  it("fails the rebuild while surfacing incomplete OpenClaw post-restore work", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {},
      executeSandboxCommand: () => ({ status: 1, stdout: "", stderr: "hash refresh failed" }),
      repairMutableConfigPerms: () => ({
        applied: false,
        skipReason: "unreadable",
        reason: "cannot stat mutable config",
      }),
      restoreSandboxState: () => ({
        success: false,
        restoredDirs: ["workspace"],
        restoredFiles: [],
        failedDirs: ["config"],
        failedFiles: ["user.md"],
      }),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("State restore remained incomplete after rebuilding 'alpha'");

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("rebuilt but some post-restore steps were incomplete");
    expect(output).toContain("State restore was incomplete");
    expect(output).toContain("Mutable config permissions were not verified");
    expect(output).toContain("Mutable OpenClaw config hash was not refreshed");
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
      agentVersion: "0.2.0",
    });
  });

  it("reports MCP recovery when bridge restoration is incomplete", async () => {
    const mcpEntry = {
      server: "github",
      providerName: "nemoclaw-mcp-alpha-github",
    };
    const harness = createRebuildFlowHarness({
      applyPreset: () => false,
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
      },
      restoreMcpBridgesAfterRebuild: () => Promise.reject(new Error("MCP restore boom")),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("rebuilt but some post-restore steps were incomplete");
    expect(output).toContain("MCP bridge definitions were preserved but not fully refreshed");
    expect(output).not.toContain("rebuilt successfully");
    expect(harness.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("MCP bridge restore incomplete: MCP restore boom"),
    );
  });
});
