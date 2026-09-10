// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createDockerManagedBootstrapAdapter } from "./docker";
import { authority, durablePreparation, fixture, NEW_ID, OLD_ID } from "./docker-test-fixture";

async function readyTransaction() {
  const fake = fixture({ agent: "openclaw", sharedState: "pending" });
  fake.deps.commandExecutor = {
    runBuffered: vi.fn(async () => ({
      outcome: { kind: "completed" as const, exitCode: 0 },
      stdout: "",
      stderr: "",
    })),
  };
  const adapter = createDockerManagedBootstrapAdapter(fake.deps);
  const { handle, snapshot, request } = authority("openclaw");
  const prepared = await adapter.prepareBootstrapReplacement({
    handle,
    snapshot,
    request,
    replacementOptions: { values: {} },
  });
  const durable = durablePreparation(handle, snapshot, prepared);
  const replacement = await adapter.activateBootstrapReplacement({
    handle,
    snapshot,
    prepared,
    durablePreparation: durable,
  });
  const completion = await adapter.awaitBootstrap({
    handle,
    snapshot,
    replacement,
    timeoutSecs: 1,
  });
  return {
    fake,
    commit: () =>
      adapter.finalizeBootstrap({
        outcome: "commit",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement,
        completion,
      }),
  };
}

describe("Docker managed bootstrap final handoff", () => {
  it("keeps OpenShell stopped during backup removal and waits for replacement execution", async () => {
    const { fake, commit } = await readyTransaction();
    const remove = vi.mocked(fake.deps.dockerRm!).getMockImplementation()!;
    vi.mocked(fake.deps.dockerRm!).mockImplementation((id, options) => {
      expect(id).toBe(OLD_ID);
      expect(fake.events).toContain("openshell:stop");
      expect(fake.replacement?.State?.Running).toBe(false);
      expect(fake.journal?.phase).toBe("shared-state-committed");
      return remove(id, options);
    });
    const phases = ["Error", "Ready"];
    vi.mocked(fake.deps.runCaptureOpenshell!).mockImplementation(() => {
      const phase = phases.shift() ?? "Ready";
      expect(fake.finalization).toBeNull();
      expect(fake.sharedState).toBe("committed");
      return `NAME  CREATED  PHASE\nalpha  2026-07-31 12:30:00  ${phase}\n`;
    });
    await expect(commit()).resolves.toMatchObject({ outcome: "committed" });
    expect(phases).toEqual([]);
    expect(fake.original).toBeNull();
    expect(fake.replacement).toMatchObject({ Id: NEW_ID, State: { Running: true } });
    expect(fake.deps.commandExecutor?.runBuffered).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxName: "alpha", command: ["true"] }),
    );
    expect(fake.journal).toBeNull();
    expect(fake.sharedState).toBe("none");
  });

  it("retains committed state when OpenShell cannot restart the replacement", async () => {
    const { fake, commit } = await readyTransaction();
    const lifecycle = vi.mocked(fake.deps.runOpenshell!);
    lifecycle
      .mockImplementationOnce(() => ({ status: 0 }))
      .mockImplementationOnce(() => ({ status: 1, stderr: "start rejected" }));
    await expect(commit()).rejects.toThrow("start");
    expect(fake.original).toBeNull();
    expect(fake.replacement?.State?.Running).toBe(false);
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.finalization).toBeNull();
    expect(fake.sharedState).toBe("committed");
    await expect(
      createDockerManagedBootstrapAdapter(fake.deps).recoverUnfinishedTransactions(),
    ).resolves.toMatchObject({ receipts: [{ outcome: "committed" }], failures: [] });
    expect(fake.replacement?.State?.Running).toBe(true);
  });

  it("retains the backup when OpenShell does not acknowledge stop", async () => {
    const { fake, commit } = await readyTransaction();
    vi.mocked(fake.deps.runOpenshell!).mockReturnValueOnce({ status: 1, stderr: "stop rejected" });
    await expect(commit()).rejects.toThrow("stop");
    expect(fake.original?.Id).toBe(OLD_ID);
    expect(fake.replacement?.State?.Running).toBe(true);
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.finalization).toBeNull();
    expect(fake.sharedState).toBe("committed");
  });

  it("withholds completion until sandbox execution succeeds after Ready", async () => {
    const { fake, commit } = await readyTransaction();
    const execution = vi.mocked(fake.deps.commandExecutor!.runBuffered);
    execution.mockClear();
    execution.mockImplementationOnce(async () => {
      expect(fake.finalization).toBeNull();
      expect(fake.journal?.phase).toBe("shared-state-committed");
      return {
        outcome: { kind: "completed", exitCode: 1 },
        stdout: "",
        stderr: "relay unavailable",
      };
    });
    await expect(commit()).resolves.toMatchObject({ outcome: "committed" });
    expect(execution).toHaveBeenCalledTimes(2);
    expect(fake.finalization?.phase).toBe("committed");
  });

  it("does not acknowledge Ready when the replacement has actually exited", async () => {
    const { fake, commit } = await readyTransaction();
    vi.mocked(fake.deps.runCaptureOpenshell!).mockImplementation(() => {
      fake.replacement!.State!.Running = false;
      return "NAME  CREATED  PHASE\nalpha  2026-07-31 12:30:00  Ready\n";
    });
    await expect(commit()).rejects.toThrow("handoff");
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.finalization).toBeNull();
    expect(fake.sharedState).toBe("committed");
  });
});
