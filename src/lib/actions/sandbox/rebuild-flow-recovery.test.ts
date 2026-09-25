// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  policies,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import {
  mcpBridgeSource,
  openClawLifecycle,
  snapshotBackup,
} from "../../../../test/helpers/rebuild-flow-harness";
import os from "node:os";
import * as sandboxState from "../../state/sandbox";
import { fingerprintSandboxLiveIdentity } from "../../onboard/sandbox-recreate-transaction";
import {
  makeActiveTeamsMessagingPlan,
  makePreparedRecoveryManifest,
} from "./rebuild-flow-test-fixtures";

describe("rebuildSandbox flow: recovery", () => {
  installRebuildFlowTestHooks();

  function stoppedRecoveryHarness() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-stopped-source-"));
    fs.writeFileSync(path.join(directory, "openclaw.json"), "{}");
    const captured = {
      sandboxName: "alpha",
      directory,
      cleanupDirectory: directory,
      assertCurrent: vi.fn(),
      dispose: vi.fn(() => fs.rmSync(directory, { recursive: true, force: true })),
    };
    const harness = createRebuildFlowHarness({
      sandboxInventory: { sandboxes: [{ name: "alpha", phase: "Error", readiness: "terminal" }] },
    });
    vi.spyOn(snapshotBackup, "prepareStoppedOpenClawState").mockResolvedValue(captured);
    return { captured, harness };
  }

  it("rebuilds a terminal sandbox from captured state without executing in the source", async () => {
    const { captured, harness } = stoppedRecoveryHarness();
    try {
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();
      expect(harness.backupSandboxStateSpy).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({ capturedOpenClawState: captured }),
      );
      expect(harness.onboardSpy).toHaveBeenCalled();
      expect(openClawLifecycle.beginOpenClawBackupQuiesce).not.toHaveBeenCalled();
      expect(mcpBridgeSource.inspectAgentMcpSources).not.toHaveBeenCalled();
      expect(captured.dispose).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(captured.directory, { recursive: true, force: true });
    }
  });

  it("preserves a changed stopped source instead of deleting it", async () => {
    const { captured, harness } = stoppedRecoveryHarness();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    captured.dispose.mockImplementation(() => {
      throw new Error("cleanup refused");
    });
    captured.assertCurrent.mockImplementation(() => {
      throw new Error("stopped source changed");
    });
    try {
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("stopped source changed");
      expectNoSandboxDelete(harness.runOpenshellSpy);
      expect(captured.dispose).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(JSON.stringify(captured.cleanupDirectory)),
      );
    } finally {
      fs.rmSync(captured.directory, { recursive: true, force: true });
    }
  });

  function makePreparedRecoveryPolicy(policy: string) {
    const manifest = makePreparedRecoveryManifest();
    sandboxState.__test.writeManifest(manifest.backupPath, manifest);
    return { ...sandboxState.writeRebuildPolicyHandoff(manifest, policy) };
  }

  it("uses the retained pre-upgrade policy at the delete edge for a non-ready recovery", async () => {
    const policy = "version: 1\nnetwork_policies:\n  host_preserved: {}\n";
    const recoveryManifest = makePreparedRecoveryPolicy(policy);
    let recreatedPolicy = "";
    const harness = createRebuildFlowHarness({
      sandboxInventory: {
        sandboxes: [{ name: "alpha", phase: "Provisioning", readiness: "not_ready" }],
      },
      preDeleteLatestManifest: recoveryManifest,
      onboard: (_session, options) => {
        recreatedPolicy = fs.readFileSync(String(options.rebuildPolicySourcePath), "utf8");
      },
    });
    vi.mocked(policies.captureRecordedSandboxBasePolicy).mockRejectedValue(
      new Error("legacy provider is unavailable"),
    );

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).resolves.toBeUndefined();

    expect(policies.captureRecordedSandboxBasePolicy).not.toHaveBeenCalled();
    expect(recreatedPolicy).toBe(policy);
  });

  it("stops before deletion when the retained pre-upgrade policy changes at the delete edge", async () => {
    const recoveryManifest = makePreparedRecoveryPolicy(
      "version: 1\nnetwork_policies:\n  host_preserved: {}\n",
    );
    const handoffPath = path.join(
      recoveryManifest.backupPath,
      recoveryManifest.rebuildPolicyHandoff!.file,
    );
    const harness = createRebuildFlowHarness({
      preDeleteLatestManifest: recoveryManifest,
      mcpPreparation: {
        entries: [],
        detachedProviderEntries: [],
        scrubbedAdapterEntries: [],
        revalidateBeforeDelete: async () => {
          fs.rmSync(handoffPath);
        },
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).rejects.toThrow("The prepared recovery policy handoff changed before sandbox deletion");

    expectNoSandboxDelete(harness.runOpenshellSpy);
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
    const policyDocument = "version: 1\nnetwork_policies:\n  host_preserved: {}";
    const mcpEntry = {
      server: "github",
      agent: "openclaw",
      adapter: "openclaw-config" as const,
      url: "https://api.githubcopilot.com/mcp/",
      env: ["GITHUB_TOKEN"],
      denyTools: ["delete_*", "repo.destroy"],
      providerName: "alpha-mcp-github",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
      source: "native" as const,
    };
    const interrupted = createRebuildFlowHarness({
      captureOpenshell: sandboxGetProbes([SOURCE_PROBE, null]),
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [],
      },
      onboard: () => {
        throw new Error("replacement create failed");
      },
    });
    await expect(
      interrupted.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");

    const persistedManifest = JSON.parse(
      fs.readFileSync(path.join(interrupted.backupPath, "rebuild-manifest.json"), "utf8"),
    ) as {
      rebuildPolicyHandoff: { file: string };
      rebuildMcpHandoff: { entries: unknown[] };
    } & Record<string, unknown>;
    const handoffPath = path.join(
      interrupted.backupPath,
      persistedManifest.rebuildPolicyHandoff.file,
    );
    expect(fs.readFileSync(handoffPath, "utf8")).toBe(policyDocument);
    expect(persistedManifest.rebuildMcpHandoff.entries).toEqual([mcpEntry]);
    expect(
      fs.existsSync(path.join(interrupted.backupPath, ".nemoclaw-rebuild-recovery.json")),
    ).toBe(true);
    let recreatedPolicy = "";
    const restarted = createRebuildFlowHarness({
      staleRecovery: true,
      captureOpenshell: sandboxGetProbes([null]),
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [],
        runtimeSelection: { gatewayName: "nemoclaw", workspace: "default" },
      },
      onboard: (_session, options) => {
        recreatedPolicy = fs.readFileSync(String(options.rebuildPolicySourcePath), "utf8");
      },
    });
    restarted.session.checkpoint = interrupted.session.checkpoint;
    await expect(
      restarted.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: persistedManifest as never,
      }),
    ).resolves.toBeUndefined();

    expect(recreatedPolicy).toBe(policyDocument);
    expect(restarted.prepareMcpBridgesForAbsentSandboxRebuildSpy).toHaveBeenCalledWith(
      "alpha",
      { gatewayName: "nemoclaw", workspace: "default" },
      [mcpEntry],
    );
    expect(restarted.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry], {
      gatewayName: "nemoclaw",
      workspace: "default",
    });
    expect(fs.existsSync(handoffPath)).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(interrupted.backupPath, "rebuild-manifest.json"), "utf8"),
      ),
    ).not.toHaveProperty("rebuildMcpHandoff");
    expect(
      fs.existsSync(path.join(interrupted.backupPath, ".nemoclaw-rebuild-recovery.json")),
    ).toBe(false);
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

  it("records an empty observation for a live prepared recovery before deletion", async () => {
    const recoveryManifest = makePreparedRecoveryManifest();
    delete (recoveryManifest as Partial<typeof recoveryManifest>).rebuildMcpHandoff;
    const harness = createRebuildFlowHarness({
      preDeleteLatestManifest: recoveryManifest,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).resolves.toBeUndefined();

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.prepareMcpBridgesForRebuildSpy).toHaveBeenCalledWith("alpha", undefined, []);
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.onboardSpy).toHaveBeenCalledOnce();
  });

  it("keeps live prepared recovery fail-closed when source observation is unavailable", async () => {
    const recoveryManifest = makePreparedRecoveryManifest();
    delete (recoveryManifest as Partial<typeof recoveryManifest>).rebuildMcpHandoff;
    const harness = createRebuildFlowHarness({
      preDeleteLatestManifest: recoveryManifest,
    });
    vi.mocked(mcpBridgeSource.inspectAgentMcpSources).mockRejectedValueOnce(
      new Error("source observation unavailable"),
    );

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).rejects.toThrow("source observation unavailable");

    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it.each(LIVE_SOURCE_PHASES)(
    "recaptures MCP state before deleting from a '%s' recovery journal without its handoff (#10394)",
    async (phase) => {
      const mcpEntry = { server: "github", providerName: "nemoclaw-mcp-alpha-github" };
      const interrupted = createRebuildFlowHarness({
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [mcpEntry],
          scrubbedAdapterEntries: [],
        },
      });
      interrupted.prepareMcpBridgesForRebuildSpy.mockRejectedValueOnce(
        new Error("interrupted before MCP preparation"),
      );

      await expect(
        interrupted.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Failed to preserve MCP bridges before rebuild");

      const recoveryManifest = JSON.parse(
        fs.readFileSync(path.join(interrupted.backupPath, "rebuild-manifest.json"), "utf8"),
      ) as ReturnType<typeof makePreparedRecoveryManifest>;
      expect(recoveryManifest).not.toHaveProperty("rebuildMcpHandoff");
      const checkpoint = interrupted.session.checkpoint as {
        sandboxRecreate?: { phase?: string };
      };
      const recreateCheckpoint = checkpoint.sandboxRecreate as { phase?: string };
      expect(recreateCheckpoint).toBeDefined();
      expect(recreateCheckpoint.phase).toBe("planned");
      recreateCheckpoint.phase = phase;
      expect(recreateCheckpoint.phase).toBe(phase);

      const restarted = createRebuildFlowHarness({
        preDeleteLatestManifest: recoveryManifest,
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [mcpEntry],
          scrubbedAdapterEntries: [],
        },
      });
      restarted.session.checkpoint = checkpoint;

      await expect(
        restarted.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest,
        }),
      ).resolves.toBeUndefined();

      expect(restarted.prepareMcpBridgesForRebuildSpy).toHaveBeenCalledWith(
        "alpha",
        { gatewayName: "nemoclaw", workspace: "default" },
        [expect.objectContaining(mcpEntry)],
      );
      expect(restarted.runOpenshellSpy).toHaveBeenCalledWith(
        ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
        expect.objectContaining({ ignoreError: true }),
      );
      const deleteCall = restarted.runOpenshellSpy.mock.calls.findIndex(
        ([argv]) => argv[0] === "sandbox" && argv[1] === "delete",
      );
      expect(deleteCall).toBeGreaterThanOrEqual(0);
      expect(restarted.prepareMcpBridgesForRebuildSpy.mock.invocationCallOrder.at(-1)).toBeLessThan(
        restarted.runOpenshellSpy.mock.invocationCallOrder[deleteCall]!,
      );
      expect(restarted.onboardSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
        restarted.runOpenshellSpy.mock.invocationCallOrder[deleteCall]!,
      );
    },
  );

  it.each(LIVE_SOURCE_PHASES)(
    "refuses foreign MCP state after preflight from a '%s' recovery journal without its handoff (#10394)",
    async (phase) => {
      const mcpEntry = { server: "github", providerName: "nemoclaw-mcp-alpha-github" };
      const interrupted = createRebuildFlowHarness({
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [mcpEntry],
          scrubbedAdapterEntries: [],
        },
      });
      interrupted.prepareMcpBridgesForRebuildSpy.mockRejectedValueOnce(
        new Error("interrupted before MCP preparation"),
      );

      await expect(
        interrupted.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Failed to preserve MCP bridges before rebuild");

      const recoveryManifest = JSON.parse(
        fs.readFileSync(path.join(interrupted.backupPath, "rebuild-manifest.json"), "utf8"),
      ) as ReturnType<typeof makePreparedRecoveryManifest>;
      expect(recoveryManifest).not.toHaveProperty("rebuildMcpHandoff");
      const checkpoint = interrupted.session.checkpoint as {
        sandboxRecreate?: { phase?: string };
      };
      const recreateCheckpoint = checkpoint.sandboxRecreate as { phase?: string };
      expect(recreateCheckpoint).toBeDefined();
      expect(recreateCheckpoint.phase).toBe("planned");
      recreateCheckpoint.phase = phase;
      expect(recreateCheckpoint.phase).toBe(phase);

      const restarted = createRebuildFlowHarness({
        preDeleteLatestManifest: recoveryManifest,
        captureOpenshell: sandboxGetProbes([FOREIGN_PROBE]),
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [mcpEntry],
          scrubbedAdapterEntries: [],
        },
      });
      restarted.session.checkpoint = checkpoint;
      const inspectMcp = vi.mocked(mcpBridgeSource.inspectAgentMcpSources);
      inspectMcp.mockClear();

      await expect(
        restarted.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest,
        }),
      ).rejects.toThrow(/not the (recorded|journaled) source/);

      expect(inspectMcp).not.toHaveBeenCalled();
      expectNoSandboxDelete(restarted.runOpenshellSpy);
      expect(restarted.onboardSpy).not.toHaveBeenCalled();
    },
  );

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
      expect.stringContaining("MCP bridge restore incomplete; inspect redacted diagnostics"),
    );
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
    vi.useFakeTimers();
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
        return args.join(" ") === "sandbox delete -g nemoclaw alpha" ? deleteFailure : undefined;
      },
      captureOpenshell: (args) => {
        vi.setSystemTime(Date.now() + 20_000);
        return args[0] === "sandbox" && args[1] === "get"
          ? { status: 0, output: SOURCE_PROBE, stdout: SOURCE_PROBE, stderr: "" }
          : MISSING_SOURCE;
      },
    });

    try {
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Failed to delete sandbox");
    } finally {
      vi.useRealTimers();
    }

    expect(harness.reattachMcpProvidersAfterRebuildAbortSpy).toHaveBeenCalledWith(
      "alpha",
      [attached],
      undefined,
      { gatewayName: "nemoclaw", workspace: "default" },
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("does not reconstruct MCP registry state when source-backed recreate fails", async () => {
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
    expect(harness.restoreSandboxEntrySpy).not.toHaveBeenCalled();
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

    expect(harness.ensureMessagingHostForwardAfterRebuildSpy).toHaveBeenCalledWith(
      "alpha",
      plan,
      undefined,
    );
    expect(
      harness.ensureMessagingHostForwardAfterRebuildSpy.mock.invocationCallOrder[0],
    ).toBeGreaterThan(harness.onboardSpy.mock.invocationCallOrder[0]);
  });

  it("fails the rebuild while surfacing incomplete OpenClaw post-restore work", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {},
      executeSandboxExecCommand: () => ({ status: 1, stdout: "", stderr: "hash refresh failed" }),
      repairMutableConfigPerms: () => ({
        applied: true,
        verified: false,
        errors: ["cannot stat mutable config"],
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
      expect.stringContaining("MCP bridge restore incomplete; inspect redacted diagnostics"),
    );
  });
});
