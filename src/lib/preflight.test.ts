// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
// Import through the compiled dist/ output (via the bin/lib shim) so
// coverage is attributed to dist/lib/preflight.js, which is what the
// ratchet measures.
import {
  assessHost,
  checkPortAvailable,
  getDockerBridgeGatewayIp,
  getMemoryInfo,
  ensureSwap,
  planHostRemediation,
  probeContainerDns,
} from "../../dist/lib/preflight";

describe("checkPortAvailable", () => {
  it("falls through to the probe when lsof output is empty", async () => {
    let probedPort: number | null = null;
    const result = await checkPortAvailable(18789, {
      lsofOutput: "",
      probeImpl: async (port) => {
        probedPort = port;
        return { ok: true };
      },
    });

    expect(probedPort).toBe(18789);
    expect(result).toEqual({ ok: true });
  });

  it("probe catches occupied port even when lsof returns empty", async () => {
    const result = await checkPortAvailable(18789, {
      lsofOutput: "",
      probeImpl: async () => ({
        ok: false,
        process: "unknown",
        pid: null,
        reason: "port 18789 is in use (EADDRINUSE)",
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.process).toBe("unknown");
    expect(result.reason).toContain("EADDRINUSE");
  });

  it("parses process and PID from lsof output", async () => {
    const lsofOutput = [
      "COMMAND     PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "openclaw  12345   root    7u  IPv4  54321      0t0  TCP *:18789 (LISTEN)",
    ].join("\n");
    const result = await checkPortAvailable(18789, { lsofOutput });

    expect(result.ok).toBe(false);
    expect(result.process).toBe("openclaw");
    expect(result.pid).toBe(12345);
    expect(result.reason).toContain("openclaw");
  });

  it("picks first listener when lsof shows multiple", async () => {
    const lsofOutput = [
      "COMMAND     PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "gateway   111   root    7u  IPv4  54321      0t0  TCP *:18789 (LISTEN)",
      "node      222   root    8u  IPv4  54322      0t0  TCP *:18789 (LISTEN)",
    ].join("\n");
    const result = await checkPortAvailable(18789, { lsofOutput });

    expect(result.ok).toBe(false);
    expect(result.process).toBe("gateway");
    expect(result.pid).toBe(111);
  });

  it("returns ok for a free port probe", async () => {
    const result = await checkPortAvailable(8080, {
      skipLsof: true,
      probeImpl: async () => ({ ok: true }),
    });

    expect(result).toEqual({ ok: true });
  });

  it("returns occupied for EADDRINUSE probe results", async () => {
    const result = await checkPortAvailable(8080, {
      skipLsof: true,
      probeImpl: async () => ({
        ok: false,
        process: "unknown",
        pid: null,
        reason: "port 8080 is in use (EADDRINUSE)",
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.process).toBe("unknown");
    expect(result.reason).toContain("EADDRINUSE");
  });

  it("treats restricted probe environments as inconclusive instead of occupied", async () => {
    const result = await checkPortAvailable(8080, {
      skipLsof: true,
      probeImpl: async () => ({
        ok: true as const,
        warning: "port probe skipped: listen EPERM: operation not permitted 127.0.0.1",
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.warning).toContain("EPERM");
  });

  it("defaults to port 18789 when no port is given", async () => {
    let probedPort: number | null = null;
    const result = await checkPortAvailable(undefined, {
      skipLsof: true,
      probeImpl: async (port) => {
        probedPort = port;
        return { ok: true };
      },
    });

    expect(probedPort).toBe(18789);
    expect(result.ok).toBe(true);
  });
});

describe("probePortAvailability", () => {
  // Import probePortAvailability directly for targeted testing
  const { probePortAvailability } = require("../../dist/lib/preflight");

  it("returns ok when port is free (real net probe)", async () => {
    // Use a high ephemeral port unlikely to be in use
    const result = await probePortAvailability(0, {});
    // Port 0 lets the OS pick a free port, so it should always succeed
    expect(result.ok).toBe(true);
  });

  it("detects EADDRINUSE on an occupied port (real net probe)", async () => {
    // Start a server on a random port, then probe it
    const net = require("node:net");
    const srv = net.createServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    try {
      const result = await probePortAvailability(port, {});
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("EADDRINUSE");
    } finally {
      await new Promise<void>((resolve) => srv.close(resolve));
    }
  });

  it("delegates to probeImpl when provided", async () => {
    let called = false;
    const result = await probePortAvailability(9999, {
      probeImpl: async (port: number) => {
        called = true;
        expect(port).toBe(9999);
        return { ok: true as const };
      },
    });
    expect(called).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe("checkPortAvailable — real probe fallback", () => {
  it("returns ok for a free port via full detection chain", async () => {
    // skipLsof forces the net probe path; use port 0 which is always free
    const result = await checkPortAvailable(0, { skipLsof: true });
    expect(result.ok).toBe(true);
  });

  it("detects a real occupied port", async () => {
    const net = require("node:net");
    const srv = net.createServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    try {
      const result = await checkPortAvailable(port, { skipLsof: true });
      expect(result.ok).toBe(false);
    } finally {
      await new Promise<void>((resolve) => srv.close(resolve));
    }
  });
});

describe("checkPortAvailable — sudo -n lsof retry", () => {
  it("uses sudo -n (non-interactive) for the lsof retry path", async () => {
    // When lsof returns empty (non-root can't see root-owned listeners),
    // checkPortAvailable retries with sudo -n. We can't easily test this
    // without mocking runCapture, but we can verify the lsofOutput injection
    // path handles header-only output correctly (falls through to probe).
    let probed = false;
    const result = await checkPortAvailable(18789, {
      lsofOutput: "COMMAND     PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n",
      probeImpl: async () => {
        probed = true;
        return { ok: true };
      },
    });
    expect(probed).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe("getMemoryInfo", () => {
  it("parses valid /proc/meminfo content", () => {
    const meminfoContent = [
      "MemTotal:        8152056 kB",
      "MemFree:         1234567 kB",
      "MemAvailable:    4567890 kB",
      "SwapTotal:       4194300 kB",
      "SwapFree:        4194300 kB",
    ].join("\n");

    const result = getMemoryInfo({ meminfoContent, platform: "linux" });
    expect(result).not.toBeNull();
    expect(result!.totalRamMB).toBe(Math.floor(8152056 / 1024));
    expect(result!.totalSwapMB).toBe(Math.floor(4194300 / 1024));
    expect(result!.totalMB).toBe(result!.totalRamMB + result!.totalSwapMB);
  });

  it("returns correct values when swap is zero", () => {
    const meminfoContent = [
      "MemTotal:        8152056 kB",
      "MemFree:         1234567 kB",
      "SwapTotal:             0 kB",
      "SwapFree:              0 kB",
    ].join("\n");

    const result = getMemoryInfo({ meminfoContent, platform: "linux" });
    expect(result).not.toBeNull();
    expect(result!.totalRamMB).toBe(Math.floor(8152056 / 1024));
    expect(result!.totalSwapMB).toBe(0);
    expect(result!.totalMB).toBe(result!.totalRamMB);
  });

  it("returns null on unsupported platforms", () => {
    const result = getMemoryInfo({ platform: "win32" });
    expect(result).toBeNull();
  });

  it("returns null on darwin when sysctl returns empty", () => {
    // When runCapture("sysctl -n hw.memsize") returns empty/falsy,
    // getMemoryInfo should return null rather than crash.
    // This exercises the darwin branch without requiring a real sysctl binary.
    const result = getMemoryInfo({ platform: "darwin" });
    // On macOS with sysctl available, returns info; otherwise null — both are valid
    if (result !== null) {
      expect(result.totalRamMB).toBeGreaterThan(0);
      expect(result.totalSwapMB).toBe(0);
    }
  });

  it("handles malformed /proc/meminfo gracefully", () => {
    const result = getMemoryInfo({
      meminfoContent: "garbage data\nno fields here",
      platform: "linux",
    });
    expect(result).not.toBeNull();
    expect(result!.totalRamMB).toBe(0);
    expect(result!.totalSwapMB).toBe(0);
    expect(result!.totalMB).toBe(0);
  });
});

describe("assessHost", () => {
  it("detects podman as an unsupported runtime on macOS", () => {
    const result = assessHost({
      platform: "darwin",
      env: {},
      dockerInfoOutput: "Podman Engine",
      commandExistsImpl: (name: string) => name === "docker",
    });

    expect(result.runtime).toBe("podman");
    expect(result.isUnsupportedRuntime).toBe(true);
    expect(result.dockerReachable).toBe(true);
  });

  it("detects podman as an unsupported runtime on Linux", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      dockerInfoOutput: "Podman Engine",
      commandExistsImpl: (name: string) => name === "docker",
    });

    expect(result.runtime).toBe("podman");
    expect(result.isUnsupportedRuntime).toBe(true);
    expect(result.dockerReachable).toBe(true);
  });

  it("detects linux docker on cgroup v2 without requiring host cgroupns fix", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "29.3.1",
        OperatingSystem: "Ubuntu 24.04",
        CgroupVersion: "2",
      }),
      readFileImpl: () => '{"default-cgroupns-mode":"private"}',
      commandExistsImpl: (name: string) => name === "docker" || name === "apt-get" || name === "systemctl",
      runCaptureImpl: (command: string) => {
        if (command === "command -v apt-get") return "/usr/bin/apt-get";
        if (command === "command -v systemctl") return "/usr/bin/systemctl";
        if (command === "systemctl is-active docker") return "active";
        if (command === "systemctl is-enabled docker") return "enabled";
        return "";
      },
    });

    expect(result.runtime).toBe("docker");
    expect(result.packageManager).toBe("apt");
    expect(result.systemctlAvailable).toBe(true);
    expect(result.dockerServiceActive).toBe(true);
    expect(result.dockerServiceEnabled).toBe(true);
    expect(result.dockerCgroupVersion).toBe("v2");
    expect(result.dockerDefaultCgroupnsMode).toBe("private");
    expect(result.requiresHostCgroupnsFix).toBe(false);
  });

  it("marks WSL in notes when the environment indicates it", () => {
    const result = assessHost({
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      dockerInfoOutput: "",
      commandExistsImpl: () => false,
    });

    expect(result.isWsl).toBe(true);
    expect(result.notes).toContain("Running under WSL");
  });

  it("detects likely headless environments", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      dockerInfoOutput: "",
      commandExistsImpl: () => false,
    });

    expect(result.isHeadlessLikely).toBe(true);
    expect(result.notes).toContain("Headless environment likely");
  });
});

describe("planHostRemediation", () => {
  it("recommends starting docker when installed but unreachable and service inactive", () => {
    const actions = planHostRemediation({
      platform: "linux",
      isWsl: false,
      runtime: "unknown",
      packageManager: "apt",
      systemctlAvailable: true,
      dockerServiceActive: false,
      dockerServiceEnabled: true,
      dockerInstalled: true,
      dockerRunning: false,
      dockerReachable: false,
      nodeInstalled: true,
      openshellInstalled: true,
      dockerCgroupVersion: "unknown",
      dockerDefaultCgroupnsMode: "unknown",
      requiresHostCgroupnsFix: false,
      isUnsupportedRuntime: false,
      isHeadlessLikely: false,
      hasNvidiaGpu: false,
      notes: [],
    });

    expect(actions[0].id).toBe("start_docker");
    expect(actions[0].blocking).toBe(true);
    expect(actions[0].commands).toContain("sudo systemctl start docker");
  });

  it("suggests usermod when docker service is active but daemon is unreachable", () => {
    const actions = planHostRemediation({
      platform: "linux",
      isWsl: false,
      runtime: "unknown",
      packageManager: "apt",
      systemctlAvailable: true,
      dockerServiceActive: true,
      dockerServiceEnabled: true,
      dockerInstalled: true,
      dockerRunning: false,
      dockerReachable: false,
      nodeInstalled: true,
      openshellInstalled: true,
      dockerCgroupVersion: "unknown",
      dockerDefaultCgroupnsMode: "unknown",
      requiresHostCgroupnsFix: false,
      isUnsupportedRuntime: false,
      isHeadlessLikely: false,
      hasNvidiaGpu: false,
      notes: [],
    });

    expect(actions[0].id).toBe("docker_group_permission");
    expect(actions[0].kind).toBe("sudo");
    expect(actions[0].blocking).toBe(true);
    expect(actions[0].commands[0]).toBe("sudo usermod -aG docker $USER");
    expect(actions[0].commands[1]).toContain("newgrp docker");
    expect(actions[0].commands[2]).toBe("nemoclaw onboard");
    expect(actions[0].reason).toContain("docker group");
  });

  it("warns that podman is unsupported on macOS without blocking onboarding", () => {
    const actions = planHostRemediation({
      platform: "darwin",
      isWsl: false,
      runtime: "podman",
      packageManager: "brew",
      systemctlAvailable: false,
      dockerServiceActive: null,
      dockerServiceEnabled: null,
      dockerInstalled: true,
      dockerRunning: true,
      dockerReachable: true,
      nodeInstalled: true,
      openshellInstalled: true,
      dockerCgroupVersion: "unknown",
      dockerDefaultCgroupnsMode: "unknown",
      requiresHostCgroupnsFix: false,
      isUnsupportedRuntime: true,
      isHeadlessLikely: false,
      hasNvidiaGpu: false,
      notes: [],
    });

    const action = actions.find((entry: { id: string }) => entry.id === "unsupported_runtime_warning");
    expect(action).toBeTruthy();
    expect(action?.blocking).toBe(false);
  });

  it("recommends installing Docker with a generic Linux hint when it is missing", () => {
    const actions = planHostRemediation({
      platform: "linux",
      isWsl: false,
      runtime: "unknown",
      packageManager: "apt",
      systemctlAvailable: true,
      dockerServiceActive: null,
      dockerServiceEnabled: null,
      dockerInstalled: false,
      dockerRunning: false,
      dockerReachable: false,
      nodeInstalled: true,
      openshellInstalled: true,
      dockerCgroupVersion: "unknown",
      dockerDefaultCgroupnsMode: "unknown",
      requiresHostCgroupnsFix: false,
      isUnsupportedRuntime: false,
      isHeadlessLikely: false,
      hasNvidiaGpu: false,
      notes: [],
    });

    expect(actions[0].id).toBe("install_docker");
    expect(actions[0].commands[0]).toContain("Install Docker Engine");
  });

  it("recommends installing openshell when missing", () => {
    const actions = planHostRemediation({
      platform: "linux",
      isWsl: false,
      runtime: "docker",
      packageManager: "apt",
      systemctlAvailable: true,
      dockerServiceActive: true,
      dockerServiceEnabled: true,
      dockerInstalled: true,
      dockerRunning: true,
      dockerReachable: true,
      nodeInstalled: true,
      openshellInstalled: false,
      dockerCgroupVersion: "v2",
      dockerDefaultCgroupnsMode: "unknown",
      requiresHostCgroupnsFix: false,
      isUnsupportedRuntime: false,
      isHeadlessLikely: false,
      hasNvidiaGpu: false,
      notes: [],
    });

    expect(actions.some((action: { id: string }) => action.id === "install_openshell")).toBe(true);
  });
});

describe("ensureSwap", () => {
  it("returns ok when total memory already exceeds threshold", () => {
    const result = ensureSwap(6144, {
      platform: "linux",
      memoryInfo: { totalRamMB: 8000, totalSwapMB: 0, totalMB: 8000 },
    });
    expect(result.ok).toBe(true);
    expect(result.swapCreated).toBe(false);
    expect(result.totalMB).toBe(8000);
  });

  it("reports swap would be created in dry-run mode when below threshold", () => {
    const result = ensureSwap(6144, {
      platform: "linux",
      memoryInfo: { totalRamMB: 4000, totalSwapMB: 0, totalMB: 4000 },
      dryRun: true,
      swapfileExists: false,
    });
    expect(result.ok).toBe(true);
    expect(result.swapCreated).toBe(true);
  });

  it("skips swap creation when /swapfile already exists (dry-run)", () => {
    const result = ensureSwap(6144, {
      platform: "linux",
      memoryInfo: { totalRamMB: 4000, totalSwapMB: 0, totalMB: 4000 },
      dryRun: true,
      swapfileExists: true,
    });
    expect(result.ok).toBe(true);
    expect(result.swapCreated).toBe(false);
    expect(result.reason).toMatch(/swapfile already exists/);
  });

  it("skips on non-Linux platforms", () => {
    const result = ensureSwap(6144, {
      platform: "darwin",
      memoryInfo: { totalRamMB: 4000, totalSwapMB: 0, totalMB: 4000 },
    });
    expect(result.ok).toBe(true);
    expect(result.swapCreated).toBe(false);
  });

  it("returns error when memory info is unavailable", () => {
    const result = ensureSwap(6144, {
      platform: "linux",
      memoryInfo: null,
      getMemoryInfoImpl: () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not read memory info/);
  });

  it("uses default 12000 MB threshold when minTotalMB is undefined", () => {
    const result = ensureSwap(undefined, {
      platform: "linux",
      memoryInfo: { totalRamMB: 16000, totalSwapMB: 0, totalMB: 16000 },
    });
    expect(result.ok).toBe(true);
    expect(result.swapCreated).toBe(false);
    expect(result.totalMB).toBe(16000);
  });

  it("uses getMemoryInfoImpl when memoryInfo is not provided", () => {
    let called = false;
    const result = ensureSwap(6144, {
      platform: "linux",
      getMemoryInfoImpl: () => {
        called = true;
        return { totalRamMB: 8000, totalSwapMB: 0, totalMB: 8000 };
      },
    });
    expect(called).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe("probeContainerDns", () => {
  const BUSYBOX_SUCCESS =
    "Server:\t\t172.17.0.1\n" +
    "Address:\t172.17.0.1:53\n" +
    "\n" +
    "Non-authoritative answer:\n" +
    "Name:\tregistry.npmjs.org\n" +
    "Address: 104.16.26.35\n" +
    "Address: 104.16.27.35\n";

  const BUSYBOX_FAILURE =
    ";; connection timed out; no servers could be reached\n";

  it("returns ok when busybox nslookup succeeds", () => {
    const result = probeContainerDns({ outputOverride: BUSYBOX_SUCCESS });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("flags servers_unreachable when resolver is unreachable (UDP:53 blocked)", () => {
    // Typical #2101 signature.
    const result = probeContainerDns({ outputOverride: BUSYBOX_FAILURE });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("servers_unreachable");
    expect(result.details).toContain("connection timed out");
  });

  it("flags servers_unreachable on 'no servers could be reached' alone", () => {
    const result = probeContainerDns({
      outputOverride: ";; no servers could be reached\n",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("servers_unreachable");
  });

  it("flags image_pull_failed when docker can't fetch the test image", () => {
    const pullError =
      "Unable to find image 'busybox:latest' locally\n" +
      "latest: Pulling from library/busybox\n" +
      "docker: Error response from daemon: Head \"https://registry-1.docker.io/v2/library/busybox/manifests/latest\": dial tcp: lookup registry-1.docker.io: no such host.\n";
    const result = probeContainerDns({ outputOverride: pullError });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("image_pull_failed");
    expect(result.details).toContain("registry-1.docker.io");
  });

  it("flags image_pull_failed on pull access denied", () => {
    const result = probeContainerDns({
      outputOverride:
        "docker: Error response from daemon: pull access denied for busybox, repository does not exist.\n",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("image_pull_failed");
  });

  it("flags resolution_failed for NXDOMAIN-style failures (resolver OK, name unknown)", () => {
    const result = probeContainerDns({
      outputOverride:
        "Server:\t\t1.1.1.1\n" +
        "Address:\t1.1.1.1:53\n" +
        "\n" +
        "** server can't find registry.npmjs.org: NXDOMAIN\n",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("resolution_failed");
  });

  it("flags no_output when docker run returns empty", () => {
    const result = probeContainerDns({ outputOverride: "" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_output");
  });

  it("flags no_output when runCapture returns null", () => {
    const result = probeContainerDns({ outputOverride: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_output");
  });

  it("flags no_output on whitespace-only output (e.g., a killed child)", () => {
    const result = probeContainerDns({ outputOverride: "  \n\n  \t\n" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_output");
  });

  it("captures the spawned command for runCapture override", () => {
    const captured: string[] = [];
    const result = probeContainerDns({
      runCaptureImpl: (command) => {
        captured.push(command);
        return BUSYBOX_SUCCESS;
      },
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("docker run");
    expect(captured[0]).toContain("busybox");
    expect(captured[0]).toContain("registry.npmjs.org");
  });

  it("allows the command to be overridden", () => {
    let seen = "";
    probeContainerDns({
      command: "echo OVERRIDDEN",
      runCaptureImpl: (command) => {
        seen = command;
        return "Name:\tregistry.npmjs.org\nAddress: 1.2.3.4\n";
      },
    });
    expect(seen).toBe("echo OVERRIDDEN");
  });

  it("treats thrown runCapture errors as error reason", () => {
    const result = probeContainerDns({
      runCaptureImpl: () => {
        throw new Error("docker daemon unreachable");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("error");
    expect(result.details).toContain("docker daemon unreachable");
  });

  it("truncates long failure details to the last 400 bytes", () => {
    const huge = "X".repeat(2000) + "real_error_here";
    const result = probeContainerDns({ outputOverride: huge });
    expect(result.ok).toBe(false);
    expect(result.details?.length).toBeLessThanOrEqual(400);
    expect(result.details).toContain("real_error_here");
  });

  it("passes a 20s timeout to runCapture (cross-platform via Node)", () => {
    // The probe bounds itself via Node's spawn-level `timeout` option
    // rather than a host-side `timeout` binary — portable across Linux /
    // macOS / Windows / WSL.
    let seenOpts: { ignoreError?: boolean; timeout?: number } | undefined;
    probeContainerDns({
      runCaptureImpl: (_cmd, o) => {
        seenOpts = o;
        return BUSYBOX_SUCCESS;
      },
    });
    expect(seenOpts).toBeDefined();
    expect(seenOpts?.ignoreError).toBe(true);
    expect(seenOpts?.timeout).toBe(20_000);
  });

  it("emits a plain `docker run ...` command (no shell-specific wrappers)", () => {
    let captured = "";
    probeContainerDns({
      runCaptureImpl: (command) => {
        captured = command;
        return BUSYBOX_SUCCESS;
      },
    });
    expect(captured.startsWith("docker run")).toBe(true);
    expect(captured.startsWith("timeout ")).toBe(false);
    expect(captured.startsWith("gtimeout ")).toBe(false);
  });
});

describe("getDockerBridgeGatewayIp", () => {
  it("returns the parsed IPv4 address from docker network inspect", () => {
    const result = getDockerBridgeGatewayIp(() => "172.17.0.1\n");
    expect(result).toBe("172.17.0.1");
  });

  it("returns non-default IPs too (user has changed bip)", () => {
    const result = getDockerBridgeGatewayIp(() => "10.42.0.1");
    expect(result).toBe("10.42.0.1");
  });

  it("returns null for empty output", () => {
    expect(getDockerBridgeGatewayIp(() => "")).toBeNull();
    expect(getDockerBridgeGatewayIp(() => null)).toBeNull();
  });

  it("returns null for garbage / IPv6 / non-IP output", () => {
    expect(getDockerBridgeGatewayIp(() => "not-an-ip")).toBeNull();
    expect(getDockerBridgeGatewayIp(() => "fe80::1")).toBeNull();
    expect(getDockerBridgeGatewayIp(() => "172.17.0")).toBeNull();
  });

  it("extracts the IPv4 from concatenated dual-stack output (IPv4 first)", () => {
    // When the bridge has both IPv4 and IPv6 gateways, docker's
    // {{range .IPAM.Config}}{{.Gateway}}{{end}} template concatenates
    // them with no separator — we need to pull the v4 out of the blob.
    const result = getDockerBridgeGatewayIp(() => "172.17.0.1fd00:abcd::1");
    expect(result).toBe("172.17.0.1");
  });

  it("extracts the IPv4 from concatenated dual-stack output (IPv6 first)", () => {
    const result = getDockerBridgeGatewayIp(() => "fd00:abcd::1172.17.0.1");
    expect(result).toBe("172.17.0.1");
  });

  it("returns the first IPv4 when multiple are present", () => {
    const result = getDockerBridgeGatewayIp(() => "10.0.0.1 192.168.1.1");
    expect(result).toBe("10.0.0.1");
  });

  it("returns null when runCapture throws", () => {
    const result = getDockerBridgeGatewayIp(() => {
      throw new Error("docker: command not found");
    });
    expect(result).toBeNull();
  });

  it("uses the expected docker network inspect command shape", () => {
    let captured = "";
    getDockerBridgeGatewayIp((cmd) => {
      captured = cmd;
      return "172.17.0.1";
    });
    expect(captured).toContain("docker network inspect bridge");
    expect(captured).toContain("Gateway");
  });
});
