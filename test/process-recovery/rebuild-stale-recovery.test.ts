// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression for issue #4497 (reopened): stale sandbox rebuild recovery.
 *
 * Reporter workflow:
 *   1. A sandbox is registered locally but its live OpenShell/Docker state has
 *      diverged (stuck/stale provision, container reaped) — it no longer shows
 *      up in `openshell sandbox list`.
 *   2. `status` prints a `rebuild --yes` recovery hint.
 *   3. `connect` runs and (after PR #4647) preserves the registry entry.
 *   4. The user runs the recommended `rebuild --yes`.
 *
 * The first fix (PR #4647) stopped `connect` from deleting the registry entry,
 * but `rebuild` still aborted at the backup step with
 * "Sandbox '<name>' is not running. Cannot back up state." whenever the live
 * sandbox was absent — which is precisely the stale-recovery state. That left
 * the recommended recovery path dead-ended.
 *
 * OpenShell is now the sole policy authority, so a missing live sandbox also
 * means there is no authoritative policy to carry into its replacement. This
 * suite asserts that `rebuild --yes` reports that condition and preserves the
 * registry state instead of reconstructing policy from NemoClaw metadata.
 */

import { describe, expect, it } from "vitest";
import { expectNoSandboxDelete } from "../helpers/rebuild-delete-assertions";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../helpers/rebuild-flow-generic-harness";

installRebuildFlowTestHooks();

describe("stale sandbox rebuild safety (#4497)", () => {
  it("still backs up normally when the live sandbox IS present (control case)", async () => {
    const harness = createRebuildFlowHarness();

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");

    // Live sandbox present → normal backup path, not stale recovery.
    expect(output).toContain("Backing up sandbox state");
    expect(output).not.toContain("absent from the live OpenShell gateway");
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
  });

  it("refuses to recreate an absent sandbox without its authoritative live policy", async () => {
    const harness = createRebuildFlowHarness({
      staleRecovery: true,
      onboard: () => undefined,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Cannot rebuild an absent sandbox without its authoritative OpenShell policy");

    const output = [...harness.logSpy.mock.calls, ...harness.errorSpy.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");

    expect(output).toContain("absent from the live OpenShell gateway");
    expect(output).toContain("Rebuild cannot recover its missing OpenShell policy");
    expect(output).toContain("nemoclaw alpha destroy --yes");
    expect(output).toContain("nemoclaw onboard");
    expect(output).not.toContain("Creating new sandbox with current image");
    expect(output).not.toContain("rebuilt successfully");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.restoreSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.prepareMcpBridgesForAbsentSandboxRebuildSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
    expect(harness.restoreSandboxEntrySpy).not.toHaveBeenCalled();
    expect(harness.restoreSandboxEntryIfMissingSpy).not.toHaveBeenCalled();
  });

  it("does NOT destroy/recreate when a foreign gateway is active (multi-gateway guard)", async () => {
    // A different OpenShell gateway is active, so the sandbox is missing from
    // the active gateway's list — but it may still be live on the named
    // nemoclaw gateway. Rebuild must reconcile against the named gateway and
    // refuse to recreate from scratch, or it would destroy live workspace
    // state in multi-gateway setups (#4497 / #4645).
    const harness = createRebuildFlowHarness({
      sandboxInventory: { sandboxes: [] },
      reconciledSandboxGatewayState: {
        state: "wrong_gateway_active",
        output: "Gateway: other-gw",
        activeGateway: "other-gw",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Could not confirm live state");

    const output = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");

    // Must NOT take the destructive stale-recovery path.
    expect(output).not.toContain("No live workspace state to back up");
    expect(output).not.toContain("Deleting old sandbox");
    expect(output).not.toContain("Creating new sandbox with current image");
    // Must surface the wrong-gateway guidance and preserve the registry entry.
    expect(output).toContain("NOT been removed");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("does NOT stale-recover a sandbox recorded on a non-default per-port gateway", async () => {
    // The sandbox was created on a non-default gateway (#4645). It is absent
    // from the active (default) gateway's list, but its live workspace may be
    // intact on its own gateway. Rebuild must not recreate-from-scratch on the
    // wrong gateway; it must point the operator at the recorded gateway and
    // preserve the registry entry.
    const harness = createRebuildFlowHarness({
      sandboxEntry: { gatewayName: "nemoclaw-9000", gatewayPort: 9000 },
      sandboxInventory: { sandboxes: [] },
      reconciledSandboxGatewayState: {
        state: "wrong_gateway_active",
        output: "Gateway: nemoclaw",
        activeGateway: "nemoclaw",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Could not confirm live state");

    const output = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");

    expect(output).not.toContain("No live workspace state to back up");
    expect(output).not.toContain("Deleting old sandbox");
    expect(output).not.toContain("Creating new sandbox with current image");
    expect(output).toContain("openshell gateway select nemoclaw-9000");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("preserves retryable metadata when stale recovery is refused (#4497)", async () => {
    const harness = createRebuildFlowHarness({
      defaultSandbox: "alpha",
      staleRecovery: true,
      onboard: () => {
        throw new Error("injected replacement create failure");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Cannot rebuild an absent sandbox without its authoritative OpenShell policy");

    const output = [...harness.logSpy.mock.calls, ...harness.errorSpy.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");

    expect(output).not.toContain("Cannot back up state");
    expect(output).toContain("absent from the live OpenShell gateway");
    expect(output).toContain("Rebuild cannot recover its missing OpenShell policy");
    expect(output).toContain("nemoclaw alpha destroy --yes");
    expect(output).not.toContain("Backing up sandbox state");
    expect(output).not.toContain("Creating new sandbox with current image");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);

    // The command stops before mutating either the sandbox or its registry row,
    // so the same recovery command remains retryable if live policy returns.
    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
    expect(harness.restoreSandboxEntrySpy).not.toHaveBeenCalled();
    expect(harness.restoreSandboxEntryIfMissingSpy).not.toHaveBeenCalled();
    expect(harness.getDefaultSelectionState()).toEqual({
      defaultSandbox: "alpha",
      defaultSelectionRevision: 10,
    });
  });
});
