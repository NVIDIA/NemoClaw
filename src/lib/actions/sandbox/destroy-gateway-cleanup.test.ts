// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { classifyLiveSandboxes } from "../../domain/sandbox/destroy";
import {
  collectLiveSandboxProbeSnapshot,
  resolveFinalDestroyGatewayCleanup,
} from "./destroy-gateway-cleanup";

const confirmedFinalDestroy = {
  deleteSucceededOrAlreadyGone: true,
  removedRegistryEntry: true,
  sandboxName: "alpha",
};

const TERMINATING_ALPHA_ROW = "alpha             now                  Terminating\n";

function liveList(rows: string): { status: number; output: string } {
  return { status: 0, output: `NAME              CREATED              PHASE\n${rows}` };
}

// A list probe that needs `durationMs`, honours the timeout it receives, and
// reports the killed-process shape when the timeout cuts it short.
function slowListProbe(clock: { now: number }, durationMs: number) {
  return vi.fn((_args: string[], opts?: { timeout?: number }) => {
    const elapsedMs = Math.min(durationMs, opts?.timeout ?? durationMs);
    clock.now += elapsedMs;
    return elapsedMs < durationMs ? { status: null, output: "" } : liveList(TERMINATING_ALPHA_ROW);
  });
}

function probeTimeouts(probe: ReturnType<typeof slowListProbe>): Array<number | undefined> {
  return probe.mock.calls.map(([, opts]) => opts?.timeout);
}

describe("resolveFinalDestroyGatewayCleanup", () => {
  it("defers live probes until the local registry is empty", async () => {
    const liveSandboxProbe = vi.fn(() => ({ status: "none" as const }));

    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        listSandboxes: () => ({ sandboxes: [{}] }),
        liveSandboxProbe,
      }),
    ).resolves.toEqual({ status: "not-final" });
    expect(liveSandboxProbe).not.toHaveBeenCalled();
  });

  it("requires confirmed delete, registry removal, and no live sandboxes", async () => {
    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        listSandboxes: () => ({ sandboxes: [] }),
        liveSandboxProbe: () => ({ status: "none" }),
      }),
    ).resolves.toEqual({ status: "cleanup" });

    await expect(
      resolveFinalDestroyGatewayCleanup(
        { ...confirmedFinalDestroy, deleteSucceededOrAlreadyGone: false },
        {
          listSandboxes: () => ({ sandboxes: [] }),
          liveSandboxProbe: () => ({ status: "none" }),
        },
      ),
    ).resolves.toEqual({ status: "not-final" });

    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        listSandboxes: () => ({ sandboxes: [] }),
        liveSandboxProbe: () => ({ status: "present", sandboxNames: ["beta"] }),
      }),
    ).resolves.toEqual({ status: "live-sandboxes", sandboxNames: ["beta"] });
  });

  it("passes the selected OpenShell capture boundary to the final live-sandbox probe (#10514)", async () => {
    const captureOpenshell = vi.fn(() => ({ status: 0, output: "" }));
    const liveSandboxProbe = vi.fn(() => ({ status: "none" as const }));

    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        captureOpenshell,
        listSandboxes: () => ({ sandboxes: [] }),
        liveSandboxProbe,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ status: "cleanup" });
    expect(liveSandboxProbe).toHaveBeenCalledWith({
      captureOpenshell,
      remainingWaitMs: expect.any(Function),
      timeoutMs: 1_000,
    });
  });

  it("does not enter the Docker container probe for native Podman cleanup", async () => {
    const captureOpenshell = vi.fn(() => ({ status: 0, output: "" }));
    const dockerCapture = vi.fn(() => {
      throw new Error("native Podman cleanup reached Docker");
    });

    await expect(
      resolveFinalDestroyGatewayCleanup(
        { ...confirmedFinalDestroy, runtimeProviderId: "podman" },
        {
          captureOpenshell,
          dockerCapture,
          listSandboxes: () => ({ sandboxes: [] }),
          resolveRuntimeProvider: () => ({ gateway: { ownsHostReadiness: true } }) as never,
        },
      ),
    ).resolves.toEqual({ status: "cleanup" });
    expect(captureOpenshell).toHaveBeenCalledOnce();
    expect(dockerCapture).not.toHaveBeenCalled();
  });

  it.each(["Error", "Failed"])(
    "preserves the gateway for an unclassified terminal %s row after a Podman destroy",
    async (phase) => {
      const captureDestroyIdentityByName = vi.fn(() => {
        throw new Error("provider-specific attribution must not run");
      });
      const dockerCapture = vi.fn(() => {
        throw new Error("native Podman cleanup reached Docker");
      });

      await expect(
        resolveFinalDestroyGatewayCleanup(
          { ...confirmedFinalDestroy, runtimeProviderId: "podman", sandboxName: "gamma" },
          {
            captureOpenshell: () => liveList(`alpha             now                  ${phase}\n`),
            dockerCapture,
            listSandboxes: () => ({ sandboxes: [] }),
            resolveRuntimeProvider: () =>
              ({
                identity: { id: "podman" },
                gateway: { ownsHostReadiness: true },
                cleanup: { supported: true, captureDestroyIdentityByName },
              }) as never,
          },
        ),
      ).resolves.toEqual({ status: "live-sandboxes", sandboxNames: ["alpha"] });
      expect(captureDestroyIdentityByName).not.toHaveBeenCalled();
      expect(dockerCapture).not.toHaveBeenCalled();
    },
  );

  it("preserves the gateway when a live sandbox appears after the empty-registry check", async () => {
    const events: string[] = [];
    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        listSandboxes: () => {
          events.push("registry-empty");
          return { sandboxes: [] };
        },
        liveSandboxProbe: () => {
          events.push("live-sandbox-observed");
          // A different live sandbox during the TOCTOU window blocks cleanup at once.
          return { status: "present", sandboxNames: ["beta"] };
        },
      }),
    ).resolves.toEqual({ status: "live-sandboxes", sandboxNames: ["beta"] });
    expect(events).toEqual(["registry-empty", "live-sandbox-observed"]);
  });

  it("waits for the deleted sandbox row to leave the live list before cleaning up", async () => {
    const captureOpenshell = vi
      .fn()
      .mockReturnValueOnce(liveList("alpha             now                  Terminating\n"))
      .mockReturnValueOnce(liveList("alpha             now                  Terminating\n"))
      .mockReturnValue({ status: 0, output: "" });
    const sleep = vi.fn(async (_ms: number) => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        captureOpenshell,
        dockerCapture: () => "",
        listSandboxes: () => ({ sandboxes: [] }),
        retryDelaysMs: [5, 5, 5],
        sleep,
      }),
    ).resolves.toEqual({ status: "cleanup" });
    expect(captureOpenshell).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[5], [5]]);
    expect(log).toHaveBeenCalledOnce();
  });

  it("reports the deleted sandbox when it stays in the live list past the wait", async () => {
    const captureOpenshell = vi.fn(() =>
      liveList("alpha             now                  Terminating\n"),
    );
    const sleep = vi.fn(async (_ms: number) => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        captureOpenshell,
        dockerCapture: () => "",
        listSandboxes: () => ({ sandboxes: [] }),
        retryDelaysMs: [5, 5],
        sleep,
      }),
    ).resolves.toEqual({ status: "live-sandboxes", sandboxNames: ["alpha"] });
    expect(captureOpenshell).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("shrinks each list probe timeout to the remaining budget and ends at the deadline", async () => {
    const clock = { now: 0 };
    const captureOpenshell = slowListProbe(clock, 12_000);
    const sleep = vi.fn(async (ms: number) => {
      clock.now += ms;
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        captureOpenshell,
        dockerCapture: () => "",
        listSandboxes: () => ({ sandboxes: [] }),
        now: () => clock.now,
        retryDelaysMs: [2_000, 2_000, 2_000, 2_000, 2_000],
        sleep,
      }),
    ).resolves.toEqual({ status: "live-list-unavailable" });
    expect(probeTimeouts(captureOpenshell)).toEqual([15_000, 15_000, 2_000]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(clock.now).toBe(30_000);
  });

  it("does not sleep when the next retry delay would reach the deadline", async () => {
    const clock = { now: 0 };
    const captureOpenshell = slowListProbe(clock, 13_000);
    const sleep = vi.fn(async (ms: number) => {
      clock.now += ms;
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        captureOpenshell,
        dockerCapture: () => "",
        listSandboxes: () => ({ sandboxes: [] }),
        now: () => clock.now,
        retryDelaysMs: [2_000, 2_000, 2_000, 2_000, 2_000],
        sleep,
      }),
    ).resolves.toEqual({ status: "live-sandboxes", sandboxNames: ["alpha"] });
    expect(captureOpenshell).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[2_000]]);
    expect(clock.now).toBe(28_000);
  });

  it("keeps the last verdict instead of probing when a sleep overruns the deadline", async () => {
    const clock = { now: 0 };
    const captureOpenshell = slowListProbe(clock, 1_000);
    const sleep = vi.fn(async (_ms: number) => {
      clock.now = 30_000;
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        captureOpenshell,
        dockerCapture: () => "",
        listSandboxes: () => ({ sandboxes: [] }),
        now: () => clock.now,
        retryDelaysMs: [2_000, 2_000],
        sleep,
      }),
    ).resolves.toEqual({ status: "live-sandboxes", sandboxNames: ["alpha"] });
    expect(captureOpenshell).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("bounds the Docker container probe to the budget left after a slow list probe", async () => {
    const clock = { now: 0 };
    const captureOpenshell = vi.fn(() => {
      clock.now += 25_000;
      return liveList("alpha             now                  Error\n");
    });
    const dockerCapture = vi.fn(() => "");

    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        captureOpenshell,
        dockerCapture,
        listSandboxes: () => ({ sandboxes: [] }),
        now: () => clock.now,
      }),
    ).resolves.toEqual({ status: "cleanup" });
    expect(captureOpenshell).toHaveBeenCalledWith(["sandbox", "list"], {
      ignoreError: true,
      timeout: 15_000,
    });
    expect(dockerCapture).toHaveBeenCalledExactlyOnceWith(
      ["ps", "--filter", "name=openshell-", "--format", "{{.Names}}"],
      { timeout: 5_000 },
    );
  });

  it("does not wait when another live sandbox blocks cleanup alongside the deleted one", async () => {
    const captureOpenshell = vi.fn(() =>
      liveList(
        "alpha             now                  Terminating\nbeta              now                  Ready\n",
      ),
    );
    const sleep = vi.fn(async (_ms: number) => undefined);

    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        captureOpenshell,
        dockerCapture: () => "",
        listSandboxes: () => ({ sandboxes: [] }),
        retryDelaysMs: [5],
        sleep,
      }),
    ).resolves.toEqual({ status: "live-sandboxes", sandboxNames: ["alpha", "beta"] });
    expect(captureOpenshell).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reports an unavailable live list without retrying", async () => {
    const captureOpenshell = vi.fn(() => ({ status: 1, output: "transport error" }));
    const sleep = vi.fn(async (_ms: number) => undefined);

    await expect(
      resolveFinalDestroyGatewayCleanup(confirmedFinalDestroy, {
        captureOpenshell,
        dockerCapture: () => "",
        listSandboxes: () => ({ sandboxes: [] }),
        retryDelaysMs: [5],
        sleep,
      }),
    ).resolves.toEqual({ status: "live-list-unavailable" });
    expect(captureOpenshell).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("collects OpenShell and Docker live-sandbox snapshots in the action layer", () => {
    const captureOpenshell = vi.fn(() =>
      liveList("npmtest           now                  Error\n"),
    );
    const dockerCapture = vi.fn(() => "openshell-default--npmtest-e487d1bd\n");

    const snapshot = collectLiveSandboxProbeSnapshot({
      captureOpenshell,
      dockerCapture,
      timeoutMs: 1_000,
    });

    expect(captureOpenshell).toHaveBeenCalledWith(["sandbox", "list"], {
      ignoreError: true,
      timeout: 1_000,
    });
    expect(dockerCapture).toHaveBeenCalledWith(
      ["ps", "--filter", "name=openshell-", "--format", "{{.Names}}"],
      {
        timeout: 1_000,
      },
    );
    expect(classifyLiveSandboxes(snapshot)).toEqual({
      status: "present",
      sandboxNames: ["npmtest"],
    });
  });

  it("runs one Docker container probe for every listed sandbox", () => {
    const dockerCapture = vi.fn(() => "openshell-default--beta-e487d1bd\n");

    const snapshot = collectLiveSandboxProbeSnapshot({
      captureOpenshell: () =>
        liveList(
          "alpha             now                  Error\nbeta              now                  Failed\n",
        ),
      dockerCapture,
      timeoutMs: 1_000,
    });

    expect(dockerCapture).toHaveBeenCalledOnce();
    expect([...snapshot.dockerContainersBySandboxName.keys()]).toEqual(["alpha", "beta"]);
    expect(classifyLiveSandboxes(snapshot)).toEqual({
      status: "present",
      sandboxNames: ["beta"],
    });
  });

  it("records failed Docker probes as fail-closed snapshots", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const snapshot = collectLiveSandboxProbeSnapshot({
      captureOpenshell: () => liveList("npmtest           now                  Failed\n"),
      dockerCapture: () => {
        throw new Error("docker unavailable");
      },
      timeoutMs: 1_000,
    });

    expect(classifyLiveSandboxes(snapshot)).toEqual({
      status: "present",
      sandboxNames: ["npmtest"],
    });
    expect(snapshot.dockerContainersBySandboxName.get("npmtest")).toEqual({
      output: "",
      probeFailed: true,
    });
    expect(warn).toHaveBeenCalledWith(
      "Docker container probe failed for sandbox 'npmtest'; preserving shared gateway: Error: docker unavailable",
    );
  });
});
