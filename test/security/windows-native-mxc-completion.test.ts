// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../packaging/windows/runtime/native-command.mts", () => ({
  run: mocks.invoke,
}));

import { waitForNativeMxcCompletion } from "../../packaging/windows/runtime/native-ui-lifecycle.mts";

const gateway = { exitCode: null, signalCode: null };
const ownProcess = vi.fn();
const completed = {
  name: "owned",
  phase: "Ready",
  ready_condition: { status: "True", reason: "AgentCompleted" },
};
const reply = (status: unknown) => ({ stdout: JSON.stringify(status), stderr: "" });
beforeEach(() => {
  mocks.invoke.mockReset();
  ownProcess.mockReset();
});

describe("native MXC execution completion", () => {
  it.each([
    ["Completed", 0, "MainProcessCompleted"],
    ["Error", 7, "MainProcessFailed"],
  ])("reports %s without claiming runtime teardown", async (phase, exitCode, reason) => {
    mocks.invoke.mockResolvedValue(
      reply({
        name: "owned",
        phase,
        exit_code: exitCode,
        conditions: [{ type: "Ready", status: "False", reason }],
      }),
    );
    await expect(
      waitForNativeMxcCompletion(
        "openshell.exe",
        {},
        "owned",
        gateway,
        null,
        undefined,
        ownProcess,
      ),
    ).resolves.toBe(reason);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0][1]).toEqual(["sandbox", "get", "owned", "-o", "json"]);
  });
  it("waits past a running agent until the executor reports completion", async () => {
    mocks.invoke
      .mockResolvedValueOnce(
        reply({ ...completed, ready_condition: { status: "True", reason: "AgentRunning" } }),
      )
      .mockResolvedValue(reply(completed));
    const lease = { assertHeld: vi.fn() };
    await expect(
      waitForNativeMxcCompletion(
        "openshell.exe",
        {},
        "owned",
        gateway,
        lease,
        undefined,
        ownProcess,
      ),
    ).resolves.toBe("AgentCompleted");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(lease.assertHeld).toHaveBeenCalledTimes(4);
    expect(lease.assertHeld.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invoke.mock.invocationCallOrder[0],
    );
    expect(lease.assertHeld.mock.invocationCallOrder[1]).toBeGreaterThan(
      mocks.invoke.mock.invocationCallOrder[0],
    );
    expect(lease.assertHeld.mock.invocationCallOrder[2]).toBeLessThan(
      mocks.invoke.mock.invocationCallOrder[1],
    );
    expect(lease.assertHeld.mock.invocationCallOrder[3]).toBeGreaterThan(
      mocks.invoke.mock.invocationCallOrder[1],
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      "openshell.exe",
      ["sandbox", "get", "owned", "-o", "json"],
      {},
      "Reading native MXC completion",
      expect.any(Number),
      undefined,
      ownProcess,
      { signal: undefined, quiet: true },
    );
  });

  it("reports executor failure as a completed failure rather than successful cleanup", async () => {
    mocks.invoke.mockResolvedValue(
      reply({
        ...completed,
        phase: "Error",
        ready_condition: { status: "False", reason: "ExecFailed" },
      }),
    );
    await expect(
      waitForNativeMxcCompletion(
        "openshell.exe",
        {},
        "owned",
        gateway,
        null,
        undefined,
        ownProcess,
      ),
    ).resolves.toBe("ExecFailed");
  });

  it.each([
    { name: "another sandbox", status: { ...completed, name: "foreign" }, error: "did not match" },
    { name: "missing phase", status: { name: "owned" }, error: "did not match" },
    {
      name: "stopped phase",
      status: { ...completed, phase: "Stopped" },
      error: "without confirming",
    },
    {
      name: "unproved error",
      status: { ...completed, phase: "Error" },
      error: "without confirming",
    },
  ])("rejects $name without trusting its diagnostic text", async ({ status, error }) => {
    mocks.invoke.mockResolvedValue(
      reply({ ...status, privateDiagnostic: "UNTRUSTED_STATUS_DETAIL" }),
    );
    const failure = await waitForNativeMxcCompletion(
      "openshell.exe",
      {},
      "owned",
      gateway,
      null,
      undefined,
      ownProcess,
    ).catch((value: unknown) => value);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(error);
    expect((failure as Error).message).not.toContain("UNTRUSTED_STATUS_DETAIL");
  });

  it("does not treat a Ready phase without a completion condition as teardown", async () => {
    mocks.invoke.mockResolvedValue(reply({ name: "owned", phase: "Ready", ready_condition: null }));
    await expect(
      waitForNativeMxcCompletion("openshell.exe", {}, "owned", gateway, null, 200, ownProcess),
    ).rejects.toThrow("did not complete");
  });

  it("rejects a stopped gateway before querying it", async () => {
    await expect(
      waitForNativeMxcCompletion(
        "openshell.exe",
        {},
        "owned",
        { exitCode: 1, signalCode: null },
        null,
        undefined,
        ownProcess,
      ),
    ).rejects.toThrow("gateway stopped");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
