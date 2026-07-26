// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createDockerGpuDnsInspectFixture as inspectFixture } from "./__test-helpers__/docker-gpu-patch-fixtures";
import { buildDockerGpuCloneRunArgs, getDockerGpuCloneFallbackDns } from "./docker-gpu-patch-clone";
import { buildDockerGpuMode } from "./docker-gpu-patch-mode";
import { recreateOpenShellDockerSandboxWithGpu } from "./docker-gpu-patch-recreate";
import type { DockerGpuPatchDeps } from "./docker-gpu-patch-types";

function recreateDeps(dns: string | null, inspect = inspectFixture()) {
  const dockerResponses: Record<string, string> = {
    ps: "old-container-id\n",
    inspect: JSON.stringify([inspect]),
  };
  const dockerCapture = vi.fn((args: readonly string[]) => {
    return dockerResponses[args[0] ?? ""] ?? "";
  });
  return {
    dockerCapture,
    dockerRun: vi.fn(() => ({ status: 0, stdout: "probe-id\n" })),
    dockerRunDetached: vi.fn(() => ({ status: 0, stdout: "new-container-id\n" })),
    dockerRename: vi.fn(() => ({ status: 0 })),
    dockerStop: vi.fn(() => ({ status: 0 })),
    dockerRm: vi.fn(() => ({ status: 0 })),
    runOpenshell: vi.fn(() => ({ status: 0 })),
    sleep: vi.fn(),
    now: () => new Date("2026-05-15T00:00:00Z"),
    detectSandboxFallbackDns: vi.fn(() => dns),
    probeContainerDns: vi.fn<NonNullable<DockerGpuPatchDeps["probeContainerDns"]>>(() => ({
      ok: true,
    })),
  };
}

describe("Docker GPU recreate DNS fallback (#3579)", () => {
  it("injects a discovered upstream only when Docker DNS is otherwise unavailable", () => {
    const inspect = inspectFixture();
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), {
      sandboxFallbackDns: "8.8.8.8",
    });
    expect(args).toEqual(expect.arrayContaining(["--dns", "8.8.8.8"]));

    inspect.HostConfig = { ...inspect.HostConfig, Dns: ["10.43.0.10"] };
    const configured = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), {
      sandboxFallbackDns: "8.8.8.8",
    });
    expect(configured).toEqual(expect.arrayContaining(["--dns", "10.43.0.10"]));
    expect(configured).not.toEqual(expect.arrayContaining(["--dns", "8.8.8.8"]));

    const host = buildDockerGpuCloneRunArgs(inspectFixture(), buildDockerGpuMode("gpus"), {
      networkMode: "host",
      sandboxFallbackDns: "8.8.8.8",
    });
    expect(host).not.toEqual(expect.arrayContaining(["--dns", "8.8.8.8"]));
  });

  it.each([
    {
      name: "bridge networking without explicit DNS",
      inspectDns: [] as string[],
      networkMode: undefined,
      expected: "8.8.8.8",
    },
    {
      name: "explicit container DNS",
      inspectDns: ["10.43.0.10"],
      networkMode: undefined,
      expected: null,
    },
    {
      name: "host networking",
      inspectDns: [] as string[],
      networkMode: "host",
      expected: null,
    },
  ])("keeps clone and preflight fallback selection in parity for $name", (scenario) => {
    const inspect = inspectFixture();
    inspect.HostConfig = { ...inspect.HostConfig, Dns: scenario.inspectDns };
    const options = {
      networkMode: scenario.networkMode,
      sandboxFallbackDns: "8.8.8.8",
    };

    const resolver = getDockerGpuCloneFallbackDns(inspect, options);
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), options);

    expect(resolver).toBe(scenario.expected);
    expect(args.includes("8.8.8.8")).toBe(resolver !== null);
  });

  it("plumbs the discovered upstream through recreate into clone args", () => {
    const deps = recreateDeps("9.9.9.9");
    recreateOpenShellDockerSandboxWithGpu({ sandboxName: "alpha", timeoutSecs: 1 }, deps);

    expect(deps.detectSandboxFallbackDns).toHaveBeenCalled();
    expect(deps.probeContainerDns).toHaveBeenCalledWith({ dnsServer: "9.9.9.9" });
    expect(deps.dockerRunDetached).toHaveBeenCalledWith(
      expect.arrayContaining(["--dns", "9.9.9.9"]),
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("does not add DNS through recreate when no upstream is discovered", () => {
    const deps = recreateDeps(null);
    recreateOpenShellDockerSandboxWithGpu({ sandboxName: "alpha", timeoutSecs: 1 }, deps);

    expect(deps.dockerRunDetached).not.toHaveBeenCalledWith(
      expect.arrayContaining(["--dns"]),
      expect.anything(),
    );
    expect(deps.probeContainerDns).not.toHaveBeenCalled();
  });

  it("continues recreation with the selected DNS after an inconclusive probe", () => {
    const deps = recreateDeps("9.9.9.9");
    deps.probeContainerDns.mockReturnValue({
      ok: false,
      reason: "image_pull_failed",
      details: "registry returned HTTP 503",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      recreateOpenShellDockerSandboxWithGpu({ sandboxName: "alpha", timeoutSecs: 1 }, deps);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "fallback DNS probe inconclusive with --dns 9.9.9.9 (reason: image_pull_failed)",
        ),
      );
      expect(deps.dockerStop).toHaveBeenCalled();
      expect(deps.dockerRunDetached).toHaveBeenCalledWith(
        expect.arrayContaining(["--dns", "9.9.9.9"]),
        expect.objectContaining({ ignoreError: true }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    { name: "explicit DNS", dns: ["10.43.0.10"], networkMode: "bridge" },
    { name: "host networking", dns: [] as string[], networkMode: "host" },
  ])("does not probe the fallback before recreating a container with $name", (scenario) => {
    const inspect = inspectFixture();
    inspect.HostConfig = {
      ...inspect.HostConfig,
      Dns: scenario.dns,
      NetworkMode: scenario.networkMode,
    };
    const deps = recreateDeps("9.9.9.9", inspect);

    recreateOpenShellDockerSandboxWithGpu({ sandboxName: "alpha", timeoutSecs: 1 }, deps);

    expect(deps.probeContainerDns).not.toHaveBeenCalled();
    expect(deps.dockerRunDetached).not.toHaveBeenCalledWith(
      expect.arrayContaining(["--dns", "9.9.9.9"]),
      expect.anything(),
    );
  });

  it("blocks a fatal fallback probe before stopping the original container", () => {
    const deps = recreateDeps("9.9.9.9");
    deps.probeContainerDns.mockReturnValue({
      ok: false,
      reason: "servers_unreachable",
      details: "nslookup: no servers could be reached",
    });

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu({ sandboxName: "alpha", timeoutSecs: 1 }, deps),
    ).toThrow(/using --dns 9\.9\.9\.9.*servers_unreachable.*before container recreation/s);
    expect(deps.dockerStop).not.toHaveBeenCalled();
  });

  it("preserves the complete hostname regression contract", () => {
    const args = buildDockerGpuCloneRunArgs(inspectFixture(), buildDockerGpuMode("gpus"), {
      sandboxFallbackDns: "8.8.8.8",
    });
    expect(args).toEqual(
      expect.arrayContaining(["--add-host", "host.openshell.internal:172.17.0.1"]),
    );
    expect(args).not.toEqual(expect.arrayContaining(["--network", "host"]));
    expect(args).toEqual(expect.arrayContaining(["--dns", "8.8.8.8"]));
  });
});
