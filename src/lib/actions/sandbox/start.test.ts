// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createDockerRuntimeProviderBundle,
  createKubernetesRuntimeProviderBundle,
  type DockerRuntimeProviderDependencies,
} from "../../onboard/runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import type { SandboxEntry } from "../../state/registry";
import { type SandboxStartDeps, startSandbox } from "./start";

function sandbox(values: Partial<SandboxEntry> = {}): SandboxEntry {
  return { name: "my-sandbox", ...values };
}

function harness(overrides: Partial<SandboxStartDeps> = {}) {
  const getSandbox = vi.fn<NonNullable<SandboxStartDeps["getSandbox"]>>(() => sandbox());
  const isDockerRuntimeDown = vi.fn<DockerRuntimeProviderDependencies["isRuntimeDown"]>(
    () => false,
  );
  const printDockerRuntimeDownGuidance =
    vi.fn<DockerRuntimeProviderDependencies["printRuntimeDownGuidance"]>();
  const findLabeledSandboxContainers = vi.fn<
    DockerRuntimeProviderDependencies["findLabeledSandboxContainers"]
  >(() => [
    {
      name: "openshell-my-sandbox",
      status: "Exited (0) 2 hours ago",
      running: false,
    },
  ]);
  const recoverDockerDriverSandbox = vi.fn<DockerRuntimeProviderDependencies["recoverSandbox"]>(
    () => ({
      recovered: true,
      via: "started-stopped-original",
      containerName: "openshell-my-sandbox",
    }),
  );
  const dockerUnpause = vi.fn<DockerRuntimeProviderDependencies["unpauseContainer"]>(() => ({
    status: 0,
  }));
  const verifyGateway = vi.fn<NonNullable<SandboxStartDeps["verifyGateway"]>>(() =>
    Promise.resolve(),
  );
  const log = vi.fn<(message: string) => void>();
  const runtimeProviders = createRuntimeProviderBundleRegistry([
    [
      "docker",
      createDockerRuntimeProviderBundle({
        findLabeledSandboxContainers,
        isRuntimeDown: isDockerRuntimeDown,
        printRuntimeDownGuidance: printDockerRuntimeDownGuidance,
        recoverSandbox: recoverDockerDriverSandbox,
        unpauseContainer: dockerUnpause,
      }),
    ],
    ["kubernetes", createKubernetesRuntimeProviderBundle()],
  ]);
  const deps: SandboxStartDeps = {
    getSandbox,
    runtimeProviders,
    verifyGateway,
    log,
    ...overrides,
  };
  return {
    deps,
    dockerUnpause,
    findLabeledSandboxContainers,
    getSandbox,
    isDockerRuntimeDown,
    log,
    printDockerRuntimeDownGuidance,
    verifyGateway,
    recoverDockerDriverSandbox,
  };
}

describe("startSandbox", () => {
  it("starts the stopped container and then probes gateway health (#6026)", async () => {
    const h = harness();

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.recoverDockerDriverSandbox).toHaveBeenCalledWith("my-sandbox");
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox");
    expect(h.recoverDockerDriverSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      h.verifyGateway.mock.invocationCallOrder[0],
    );
  });

  it("reports the started container by name (#6026)", async () => {
    const h = harness();

    await startSandbox("my-sandbox", h.deps);

    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("openshell-my-sandbox");
  });

  it("still probes when the container was already running (#6026)", async () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      { name: "openshell-my-sandbox", status: "Up 5 minutes", running: true },
    ]);
    h.recoverDockerDriverSandbox.mockReturnValue({
      recovered: true,
      via: "started-running-original",
      containerName: "openshell-my-sandbox",
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox");
    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("already running");
  });

  it("unpauses a paused container instead of calling it already running (#6026)", async () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      {
        name: "openshell-my-sandbox",
        status: "Up 3 minutes (Paused)",
        running: true,
      },
    ]);

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerUnpause).toHaveBeenCalledWith("openshell-my-sandbox", {
      ignoreError: true,
      timeout: 30_000,
    });
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox");
    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("unpaused");
  });

  it("surfaces a docker unpause failure with the container name (#6026)", async () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      {
        name: "openshell-my-sandbox",
        status: "Up 3 minutes (Paused)",
        running: true,
      },
    ]);
    h.dockerUnpause.mockReturnValue({ status: 125 });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("openshell-my-sandbox");
    expect(result.message).toContain("125");
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("restores a gpu-backup sibling through the recovery rename path (#6026)", async () => {
    const h = harness();
    h.recoverDockerDriverSandbox.mockReturnValue({
      recovered: true,
      via: "renamed-and-started-backup",
      containerName: "openshell-my-sandbox",
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox");
  });

  it("names the Docker daemon outage instead of claiming the container was removed (#6026)", async () => {
    const h = harness();
    h.isDockerRuntimeDown.mockReturnValue(true);

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toBeUndefined();
    expect(h.printDockerRuntimeDownGuidance).toHaveBeenCalledWith("my-sandbox", {
      retryCommand: "start",
    });
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("fails with the recovery detail and a rebuild hint when no container exists (#6026)", async () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([]);
    h.recoverDockerDriverSandbox.mockReturnValue({
      recovered: false,
      via: null,
      detail: "no Docker container labeled 'openshell.ai/sandbox-name=my-sandbox'",
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("no Docker container labeled");
    expect(result.message).toContain("rebuild");
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("refuses an unregistered sandbox (#6026)", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(null);

    const result = await startSandbox("ghost", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("not registered");
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
  });

  it("refuses non-direct drivers instead of guessing at container control (#6026)", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ openshellDriver: "kubernetes" }));

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("kubernetes");
    expect(result.message).toContain("does not authorize 'start' mutation");
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it.each([
    "unknown-runtime",
    "mxc-not-installed",
  ])("fails closed for unregistered provider %s without lifecycle side effects", async (providerId) => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ openshellDriver: providerId }));

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain(providerId);
    expect(result.message).toContain("has no registered lifecycle provider");
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
    expect(h.dockerUnpause).not.toHaveBeenCalled();
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it.each([
    ["null driver", sandbox({ openshellDriver: null })],
    ["docker driver", sandbox({ openshellDriver: "docker" })],
    ["vm driver", sandbox({ openshellDriver: "vm" })],
  ])("allows the %s like privileged exec does (#6026)", async (_label, entry) => {
    const h = harness();
    h.getSandbox.mockReturnValue(entry);

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
  });

  it("propagates a probe rejection instead of reporting success (#6026)", async () => {
    const h = harness();
    h.verifyGateway.mockRejectedValue(new Error("probe exploded"));

    await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow("probe exploded");
  });
});
