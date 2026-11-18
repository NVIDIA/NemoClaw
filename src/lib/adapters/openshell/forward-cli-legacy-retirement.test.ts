// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ captureOpenshellCommandAsyncResult: vi.fn() }));

import {
  captured,
  capturedForwardList,
  createHarness,
  errors,
  executable,
  forward,
  invokeWhen,
  legacyForwardList,
  listHeader,
  noActiveForwards,
  runtimeSelection,
  throwSupersededWhen,
  type InspectLegacyListener,
  type ProbePort,
  type RunCommand,
} from "./forward-cli-test-fixture";
import { buildCliOpenShellLegacyForwardStopArgs } from "./forward-cli";

describe("CLI OpenShell legacy forward retirement", () => {
  it.each([
    ["workspace table", "WORKSPACE " + legacyForwardList.replaceAll("\n", "\nother "), forward],
    ["legacy table outside default", legacyForwardList, { ...forward, workspace: "other" }],
  ])(
    "refuses another workspace in %s without requesting authority or stopping",
    async (_case, output, requested) => {
      const authorize = vi.fn(async () => {});
      const { adapter, run } = createHarness({
        runtimeSelection: { ...runtimeSelection, workspace: requested.workspace },
        run: async () => captured(0, output),
      });

      await expect(adapter.retireLegacyForward({ forward: requested, authorize })).resolves.toEqual(
        {
          state: "refused",
          observation: { state: "foreign", forward: requested },
        },
      );
      expect(authorize).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("omits the workspace flag for legacy CLIs that predate workspace selection", async () => {
    const run = vi.fn<RunCommand>(async (_executable, args) =>
      args.includes("list") ? captured(0, legacyForwardList) : captured(0),
    );
    const { adapter } = createHarness({
      legacyForwardWorkspaceSelection: "implicit-default",
      run,
    });

    await expect(
      adapter.retireLegacyForward({ forward, authorize: async () => {} }),
    ).resolves.toEqual({ state: "retired", forward });
    expect(run.mock.calls.filter(([, args]) => args.includes("list"))).not.toEqual([]);
    expect(run.mock.calls.every(([, args]) => !args.includes("--workspace"))).toBe(true);
    expect(run.mock.calls.filter(([, args]) => args.includes("stop"))).toHaveLength(1);
  });

  it.each([
    ["legacy", legacyForwardList],
    ["workspace", "WORKSPACE " + legacyForwardList.replaceAll("\n", "\ndefault ")],
  ])(
    "checks authority, stops once, and verifies release for the %s table",
    async (_case, output) => {
      const operations: string[] = [];
      const run: RunCommand = async (_executable, args) => {
        const operation = args.includes("list") ? "list" : "stop";
        operations.push(operation);
        return operation === "list" ? captured(0, output) : captured(0);
      };
      const inspectLegacy: InspectLegacyListener = async (_identity, expectedPid) => {
        operations.push(`legacy:${String(expectedPid)}`);
        return { state: "owned", pid: expectedPid };
      };
      const probePort: ProbePort = async () => {
        operations.push("probe");
        return { state: "unbound" };
      };
      const authorize = vi.fn(async () => {
        operations.push("authorize");
      });
      const { adapter, run: runMock } = createHarness({ inspectLegacy, probePort, run });

      await expect(adapter.retireLegacyForward({ forward, authorize })).resolves.toEqual({
        state: "retired",
        forward,
      });
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(authorize).toHaveBeenNthCalledWith(1, forward);
      expect(authorize).toHaveBeenNthCalledWith(2, forward);
      expect(operations).toEqual([
        "list",
        "legacy:4312",
        "authorize",
        "list",
        "legacy:4312",
        "authorize",
        "stop",
        "probe",
      ]);
      expect(runMock.mock.calls.filter(([, args]) => args.includes("stop"))).toEqual([
        [
          executable,
          buildCliOpenShellLegacyForwardStopArgs(forward),
          expect.objectContaining({
            environment: {
              OPENSHELL_GATEWAY: "nemoclaw",
              OPENSHELL_WORKSPACE: "default",
            },
            outputLimitBytes: 64 * 1_024,
          }),
        ],
      ]);
    },
  );

  it.each([
    ["owned", "not_needed", noActiveForwards, { state: "owned", pid: 4_321 } as const],
    ["absent", "not_needed", noActiveForwards, { state: "unbound" } as const],
    ["foreign", "refused", noActiveForwards, { state: "foreign", pids: [9_876] } as const],
    ["indeterminate", "refused", noActiveForwards, { state: "indeterminate" } as const],
  ])(
    "returns %s as %s without requesting authority or stopping",
    async (_state, expectedState, output, inspection) => {
      const authorize = vi.fn(async () => {});
      const { adapter, run } = createHarness({
        inspect: async () => inspection,
        run: async () => capturedForwardList(output),
      });

      const result = await adapter.retireLegacyForward({ forward, authorize });

      expect(result.state).toBe(expectedState);
      expect(authorize).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("refuses retirement when its initial currentness fence is stale", async () => {
    const assertCurrent = vi.fn(async () => {
      throw new Error("superseded generation");
    });
    const authorize = vi.fn(async () => {});
    const { adapter, inspectLegacy, run } = createHarness({
      run: async () => captured(0, legacyForwardList),
    });

    await expect(
      adapter.retireLegacyForward({ forward, assertCurrent, authorize }),
    ).resolves.toEqual({
      state: "refused",
      observation: { state: "indeterminate", forward, error: errors.authority },
    });
    expect(run).not.toHaveBeenCalled();
    expect(inspectLegacy).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("does not stop when the second destructive authorization revokes currentness", async () => {
    let current = true;
    let authorizations = 0;
    const assertCurrent = vi.fn(async () => {
      throwSupersededWhen(!current);
    });
    const authorize = vi.fn(async () => {
      authorizations += 1;
      invokeWhen(authorizations === 2, () => {
        current = false;
      });
    });
    const { adapter, run } = createHarness({
      run: async () => captured(0, legacyForwardList),
    });

    await expect(
      adapter.retireLegacyForward({ forward, assertCurrent, authorize }),
    ).resolves.toEqual({ state: "failed", forward, effect: "none", error: errors.authority });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.some(([, args]) => args.includes("stop"))).toBe(false);
  });

  it("does not stop when authority fails", async () => {
    const { adapter, run } = createHarness({
      run: async () => captured(0, legacyForwardList),
    });

    await expect(
      adapter.retireLegacyForward({
        forward,
        authorize: async () => {
          throw new Error("private authority diagnostic");
        },
      }),
    ).resolves.toEqual({
      state: "failed",
      forward,
      effect: "none",
      error: errors.authority,
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("reconciles release when currentness changes after a successful stop", async () => {
    let current = true;
    const assertCurrent = vi.fn(async () => {
      throwSupersededWhen(!current);
    });
    const run = vi.fn<RunCommand>(async (_executable, args) => {
      const isList = args.includes("list");
      current = isList ? current : false;
      return isList ? captured(0, legacyForwardList) : captured(0);
    });
    const { adapter, probePort } = createHarness({ run });

    await expect(
      adapter.retireLegacyForward({ forward, assertCurrent, authorize: async () => {} }),
    ).resolves.toEqual({
      state: "mutation_uncertain",
      forward,
      effect: "possible",
      error: errors.authority,
    });
    expect(run.mock.calls.filter(([, args]) => args.includes("stop"))).toHaveLength(1);
    expect(probePort).toHaveBeenCalledExactlyOnceWith(forward, 5_000);
  });

  it("does not stop when the post-authority observation changes", async () => {
    const run = vi
      .fn<RunCommand>()
      .mockResolvedValueOnce(captured(0, legacyForwardList))
      .mockResolvedValueOnce(capturedForwardList(noActiveForwards));
    const { adapter } = createHarness({ run });

    await expect(
      adapter.retireLegacyForward({ forward, authorize: async () => {} }),
    ).resolves.toEqual({
      state: "not_needed",
      observation: { state: "absent", forward },
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.some(([, args]) => args.includes("stop"))).toBe(false);
  });

  it("does not stop when the legacy PID changes after authority", async () => {
    const changedLegacyForwardList = [listHeader, "demo 127.0.0.1 18789 9876 running"].join("\n");
    const run = vi
      .fn<RunCommand>()
      .mockResolvedValueOnce(captured(0, legacyForwardList))
      .mockResolvedValueOnce(captured(0, changedLegacyForwardList))
      .mockResolvedValueOnce(captured(0));
    const { adapter, inspectLegacy } = createHarness({ run });

    await expect(
      adapter.retireLegacyForward({ forward, authorize: async () => {} }),
    ).resolves.toEqual({
      state: "failed",
      forward,
      effect: "none",
      error: errors.ownership,
    });
    expect(run.mock.calls.some(([, args]) => args.includes("stop"))).toBe(false);
    expect(inspectLegacy).toHaveBeenNthCalledWith(1, forward, 4_312, 15_000);
    expect(inspectLegacy).toHaveBeenNthCalledWith(2, forward, 9_876, 15_000);
  });

  it("returns mutation uncertainty after one timed-out stop", async () => {
    let current = true;
    const assertCurrent = vi.fn(async () => {
      throwSupersededWhen(!current);
    });
    const run = vi.fn<RunCommand>(async (_executable, args) => {
      const isList = args.includes("list");
      current = isList ? current : false;
      return isList
        ? captured(0, legacyForwardList)
        : captured(null, "", "private stop diagnostic", { timedOut: true });
    });
    const { adapter, inspectLegacy } = createHarness({ run });

    await expect(
      adapter.retireLegacyForward({
        forward,
        assertCurrent,
        authorize: async () => {},
      }),
    ).resolves.toEqual({
      state: "mutation_uncertain",
      forward,
      effect: "possible",
      error: errors.timeout,
    });
    expect(run.mock.calls.filter(([, args]) => args.includes("stop"))).toHaveLength(1);
    expect(run.mock.calls.filter(([, args]) => args.includes("list"))).toHaveLength(3);
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls.at(-1)?.[2].timeoutMs).toBeGreaterThan(0);
    expect(run.mock.calls.at(-1)?.[2].timeoutMs).toBeLessThanOrEqual(5_000);
    expect(inspectLegacy).toHaveBeenCalledTimes(3);
  });

  it("returns cleanup uncertainty when a stopped forward remains bound", async () => {
    const run: RunCommand = async (_executable, args) =>
      args.includes("list") ? captured(0, legacyForwardList) : captured(0);
    const { adapter } = createHarness({
      probePort: async () => ({ state: "bound" }),
      run,
    });

    await expect(
      adapter.retireLegacyForward({ forward, authorize: async () => {} }),
    ).resolves.toEqual({
      state: "release_unproved",
      forward,
      effect: "possible",
      error: errors.cleanup,
    });
  });
});
