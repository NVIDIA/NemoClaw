// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type ConnectHarness,
  type ConnectHarnessOptions,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

const EXIT_ONE = 'process.exit unexpectedly called with "1"';

// The #10869 reproduction: a managed container whose name no longer matches the
// sandbox, plus a busybox that borrows the sandbox-name label with another
// workspace and no managed marker.
const PARKED_MANAGED = {
  id: "aaaa000000000000",
  managedBy: "openshell",
  workspace: "default",
  sandboxId: "sb-real",
};
const FOREIGN_WORKSPACE = {
  id: "ffff000000000000",
  managedBy: "",
  workspace: "other-workspace",
  sandboxId: "",
};

function observed(rows: (typeof PARKED_MANAGED)[], malformedRows = 0) {
  return { status: "observed" as const, rows, malformedRows };
}

/** A docker-driver sandbox whose container NemoClaw could not match. */
function unmatchedIdentityHarness(options: ConnectHarnessOptions): ConnectHarness {
  return createConnectHarness({
    registryEntry: { openshellDriver: "docker" },
    dockerRuntime: { containerName: null, running: false },
    ...options,
  });
}

describe("sandbox start readiness", () => {
  it("prints typed unhealthy-gateway guidance during connect readiness", async () => {
    const harness = createConnectHarness({ listOutputs: ["alpha Unknown"] });
    vi.spyOn(
      requireDist("../../src/lib/gateway-runtime-action.js"),
      "getNamedGatewayLifecycleState",
    ).mockResolvedValue({
      state: "named_unhealthy",
      activeGateway: "nemoclaw",
      recoveryBlocked: false,
      unavailable: true,
      diagnostic: "Gateway is not connected.",
    });
    await expect(harness.waitForSandboxReadyOrExit("alpha")).rejects.toThrow(
      'process.exit unexpectedly called with "1"',
    );
    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Gateway is not connected.");
    expect(output).toContain("API is refusing connections after restart");
  });

  it("waits through the stopped sandbox Error phase after start (#9753)", async () => {
    const harness = createConnectHarness({
      listOutputs: ["alpha Error", "alpha Provisioning", "alpha Ready"],
    });

    await expect(
      harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
    ).resolves.toBeUndefined();

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps Error terminal outside the post-start grace period (#9753)", async () => {
    const harness = createConnectHarness({ listOutputs: ["alpha Error"] });

    await expect(harness.waitForSandboxReadyOrExit("alpha")).rejects.toThrow(
      'process.exit unexpectedly called with "1"',
    );

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(1);
  });

  it("ends the post-start Error grace after the phase advances (#9753)", async () => {
    const harness = createConnectHarness({
      listOutputs: ["alpha Error", "alpha Provisioning", "alpha Error"],
    });

    await expect(
      harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
    ).rejects.toThrow('process.exit unexpectedly called with "1"');

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(3);
  });

  it.each([11, 20])(
    "waits through %s initial Error observations after a slow restart (#9485)",
    async (errorObservations) => {
      const harness = createConnectHarness({
        listOutputs: [
          ...Array.from({ length: errorObservations }, () => "alpha Error"),
          "alpha Ready",
        ],
      });

      await expect(
        harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
      ).resolves.toBeUndefined();

      expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(errorObservations + 1);
    },
  );

  it("fails after the stopped sandbox Error phase remains terminal (#9753)", async () => {
    const harness = createConnectHarness({
      listOutputs: Array.from({ length: 21 }, () => "alpha Error"),
    });

    await expect(
      harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
    ).rejects.toThrow('process.exit unexpectedly called with "1"');

    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(21);
  });

  it.each(["Failed", "CrashLoopBackOff"])(
    "fails immediately when start reports the terminal %s phase (#9753)",
    async (phase) => {
      const harness = createConnectHarness({ listOutputs: [`alpha ${phase}`] });

      await expect(
        harness.waitForSandboxReadyOrExit("alpha", { allowInitialErrorAfterStart: true }),
      ).rejects.toThrow('process.exit unexpectedly called with "1"');

      expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the sandbox observation.",
      },
      guidance: "could not authenticate",
    },
    {
      error: {
        kind: "schema",
        message: "The OpenShell CLI and gateway sandbox schemas do not match.",
      },
      guidance: "schemas do not match",
    },
    {
      error: { kind: "timeout", message: "OpenShell sandbox observation timed out." },
      guidance: "readiness request for sandbox 'alpha' timed out",
    },
    {
      error: {
        kind: "command",
        reason: "failed",
        message: "The OpenShell sandbox observation failed.",
      },
      guidance: "readiness request for sandbox 'alpha' failed",
    },
    {
      error: {
        kind: "transport",
        reason: "unreachable",
        message: "OpenShell could not reach the selected gateway.",
      },
      guidance: "gateway is not running or unreachable",
    },
  ] as const)(
    "prints accurate $error.kind readiness failure guidance (#9803)",
    async (testCase) => {
      const harness = createConnectHarness();
      const observer = {
        listSandboxes: vi.fn().mockResolvedValue({ ok: false, error: testCase.error }),
      } as never;

      await expect(harness.waitForSandboxReadyOrExit("alpha", { observer })).rejects.toThrow(
        'process.exit unexpectedly called with "1"',
      );

      const output = harness.errorSpy.mock.calls.flat().join("\n");
      expect(output).toContain(testCase.guidance);
      expect(output.includes("gateway is not running or unreachable")).toBe(
        testCase.error.kind === "transport",
      );
    },
  );
});

describe("sandbox readiness container identity boundary", () => {
  it("names the foreign workspace when the terminal Error phase follows an unmatched container (#10869)", async () => {
    const harness = unmatchedIdentityHarness({
      listOutputs: ["alpha Provisioning", "alpha Error"],
      sandboxNameLabeledContainers: observed([PARKED_MANAGED, FOREIGN_WORKSPACE]),
    });

    await expect(harness.waitForSandboxReadyOrExit("alpha")).rejects.toThrow(EXIT_ONE);

    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Sandbox 'alpha' entered 'Error' state.");
    expect(output).toContain(
      "No Docker container matches sandbox 'alpha' in the default OpenShell workspace.",
    );
    expect(output).toContain("2 container(s) carry the 'openshell.ai/sandbox-name=alpha' label:");
    expect(output).toContain(
      'aaaa00000000 (openshell.ai/managed-by="openshell", openshell.ai/sandbox-workspace="default", openshell.ai/sandbox-id="sb-real")',
    );
    expect(output).toContain(
      'ffff00000000 (openshell.ai/managed-by="<none>", openshell.ai/sandbox-workspace="other-workspace", openshell.ai/sandbox-id="<none>")',
    );
    expect(output).toContain("Then rerun 'nemoclaw alpha connect'.");
    expect(output).not.toContain("logs --follow");
    expect(output).not.toContain("nemoclaw alpha status");
  });

  it("names the boundary for an initial terminal phase with the caller's retry command (#10869)", async () => {
    const harness = unmatchedIdentityHarness({
      listOutputs: ["alpha Failed"],
      sandboxNameLabeledContainers: observed([FOREIGN_WORKSPACE]),
    });

    await expect(
      harness.waitForSandboxReadyOrExit("alpha", { retryCommand: "start" }),
    ).rejects.toThrow(EXIT_ONE);

    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Sandbox 'alpha' is in 'Failed' state.");
    expect(output).toContain("1 container(s) carry the 'openshell.ai/sandbox-name=alpha' label:");
    expect(output).toContain("Then rerun 'nemoclaw alpha start'.");
    expect(harness.captureOpenshellSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the runtime-fault guidance when the terminal phase belongs to a matched container (#10869)", async () => {
    const harness = unmatchedIdentityHarness({
      listOutputs: ["alpha Error"],
      dockerRuntime: { containerName: "openshell-alpha", running: true },
      sandboxNameLabeledContainers: observed([PARKED_MANAGED, FOREIGN_WORKSPACE]),
    });

    await expect(harness.waitForSandboxReadyOrExit("alpha")).rejects.toThrow(EXIT_ONE);

    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Run:  nemoclaw alpha logs --follow");
    expect(output).toContain("Run:  nemoclaw alpha status");
    expect(output).not.toContain("sandbox-workspace");
    expect(harness.inspectSandboxNameLabeledContainersSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["no container carries the sandbox-name label", observed([])],
    [
      "the Docker identity probe fails",
      { status: "probe-failed" as const, detail: "Cannot connect to the Docker daemon" },
    ],
  ])("keeps the runtime-fault guidance when %s (#10869)", async (_condition, observation) => {
    const harness = unmatchedIdentityHarness({
      listOutputs: ["alpha Error"],
      sandboxNameLabeledContainers: observation,
    });

    await expect(harness.waitForSandboxReadyOrExit("alpha")).rejects.toThrow(EXIT_ONE);

    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Run:  nemoclaw alpha logs --follow");
    expect(output).not.toContain("No Docker container matches");
  });

  it("does not inspect Docker identity for a sandbox that is not on the docker driver (#10869)", async () => {
    const harness = unmatchedIdentityHarness({
      listOutputs: ["alpha Error"],
      registryEntry: { openshellDriver: "vm" },
      sandboxNameLabeledContainers: observed([FOREIGN_WORKSPACE]),
    });

    await expect(harness.waitForSandboxReadyOrExit("alpha")).rejects.toThrow(EXIT_ONE);

    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Run:  nemoclaw alpha logs --follow");
    expect(harness.inspectSandboxNameLabeledContainersSpy).not.toHaveBeenCalled();
  });

  it("does not inspect Docker identity when the caller disables Docker runtime inspection (#10869)", async () => {
    const harness = unmatchedIdentityHarness({
      listOutputs: ["alpha Error"],
      sandboxNameLabeledContainers: observed([FOREIGN_WORKSPACE]),
    });

    await expect(
      harness.waitForSandboxReadyOrExit("alpha", { allowDockerRuntimeInspection: false }),
    ).rejects.toThrow(EXIT_ONE);

    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Run:  nemoclaw alpha logs --follow");
    expect(harness.inspectSandboxNameLabeledContainersSpy).not.toHaveBeenCalled();
  });

  it("reports malformed identity rows without rendering their content (#10869)", async () => {
    const harness = unmatchedIdentityHarness({
      listOutputs: ["alpha Error"],
      sandboxNameLabeledContainers: observed([FOREIGN_WORKSPACE], 1),
    });

    await expect(harness.waitForSandboxReadyOrExit("alpha")).rejects.toThrow(EXIT_ONE);

    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("2 container(s) carry the 'openshell.ai/sandbox-name=alpha' label:");
    expect(output).toContain("Docker returned 1 malformed container identity row(s).");
  });

  it("counts containers when every identity row is malformed (#10869)", async () => {
    const harness = unmatchedIdentityHarness({
      listOutputs: ["alpha Error"],
      sandboxNameLabeledContainers: observed([], 1),
    });
    await expect(harness.waitForSandboxReadyOrExit("alpha")).rejects.toThrow(EXIT_ONE);
    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("1 container(s) carry the 'openshell.ai/sandbox-name=alpha' label:");
    expect(output).toContain("Docker returned 1 malformed container identity row(s).");
    expect(output).not.toContain("openshell.ai/managed-by=");
  });

  it("keeps runtime guidance when the owned-container lookup fails (#10869)", async () => {
    const harness = unmatchedIdentityHarness({
      listOutputs: ["alpha Error"],
      dockerRuntime: { containerName: null, containerObservationFailed: true },
      sandboxNameLabeledContainers: observed([FOREIGN_WORKSPACE]),
    });
    await expect(harness.waitForSandboxReadyOrExit("alpha")).rejects.toThrow(EXIT_ONE);
    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Run:  nemoclaw alpha logs --follow");
    expect(output).not.toContain("No Docker container matches");
    expect(harness.inspectSandboxNameLabeledContainersSpy).not.toHaveBeenCalled();
  });

  it("quotes and escapes label values so a container cannot forge adjacent fields (#10869)", async () => {
    const forged = {
      ...FOREIGN_WORKSPACE,
      managedBy: 'openshell", openshell.ai/sandbox-workspace="default',
      workspace: "other\u001b[31mworkspace",
    };
    const harness = unmatchedIdentityHarness({
      listOutputs: ["alpha Error"],
      sandboxNameLabeledContainers: observed([forged]),
    });

    await expect(harness.waitForSandboxReadyOrExit("alpha")).rejects.toThrow(EXIT_ONE);

    const output = harness.errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain(`openshell.ai/managed-by=${JSON.stringify(forged.managedBy)}`);
    expect(output).not.toContain(
      'openshell.ai/managed-by="openshell", openshell.ai/sandbox-workspace="default"',
    );
    expect(output).not.toContain("\u001b");
    expect(output).toContain('openshell.ai/sandbox-workspace="other\\\\u001b[31mworkspace"');
  });
});
