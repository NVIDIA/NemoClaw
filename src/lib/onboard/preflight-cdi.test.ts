// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
// Import through the compiled dist/ output so coverage is attributed to the
// CLI build output that the ratchet measures.
import { assessHost, planHostRemediation } from "../../../dist/lib/onboard/preflight";

type HostAssessment = Parameters<typeof planHostRemediation>[0];

function baseAssessment(overrides: Partial<HostAssessment> = {}): HostAssessment {
  return {
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
    openshellInstalled: true,
    dockerCgroupVersion: "v2",
    dockerDefaultCgroupnsMode: "unknown",
    isContainerRuntimeUnderProvisioned: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: false,
    isHeadlessLikely: false,
    hasNvidiaGpu: true,
    dockerCdiSpecDirs: ["/etc/cdi", "/var/run/cdi"],
    cdiNvidiaGpuSpecMissing: false,
    nvidiaContainerToolkitInstalled: true,
    notes: [],
    ...overrides,
  };
}

function healthySystemctlAndStat(command: readonly string[]) {
  if (command[0] === "systemctl" && command[1] === "is-enabled") return "enabled";
  if (command[0] === "systemctl" && command[1] === "is-active") return "active";
  if (command[0] === "systemctl" && command[1] === "is-failed") return "inactive";
  if (command[0] === "stat" && command[3] === "/dev/nvidia-uvm") return "1f3 0";
  return "";
}

describe("assessHost — CDI", () => {
  it("flags missing nvidia.com/gpu specs on an NVIDIA Linux host with CDI dirs configured", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: () => "Linux version 6.8.0-58-generic",
      readdirImpl: () => [],
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "27.0",
        OperatingSystem: "Ubuntu 24.04",
        CDISpecDirs: ["/etc/cdi", "/var/run/cdi"],
      }),
      commandExistsImpl: (name: string) => name === "docker",
      gpuProbeImpl: () => true,
    });

    expect(result.dockerCdiSpecDirs).toEqual(["/etc/cdi", "/var/run/cdi"]);
    expect(result.cdiNvidiaGpuSpecMissing).toBe(true);
  });

  it("does not flag the host when an nvidia.com/gpu YAML spec is present", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: (filePath: string) =>
        filePath.endsWith("nvidia.yaml")
          ? "cdiVersion: 0.5.0\nkind: nvidia.com/gpu\ndevices: []\n"
          : "Linux version 6.8.0-58-generic",
      readdirImpl: (dir: string) => (dir === "/etc/cdi" ? ["nvidia.yaml"] : []),
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "27.0",
        CDISpecDirs: ["/etc/cdi", "/var/run/cdi"],
      }),
      commandExistsImpl: (name: string) => name === "docker",
      gpuProbeImpl: () => true,
    });

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
  });

  it("uses the effective CDI spec when assessing staleness", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: (filePath: string) => {
        if (filePath === "/etc/cdi/nvidia.yaml") {
          return [
            "cdiVersion: 0.5.0",
            "kind: nvidia.com/gpu",
            "devices:",
            "  - name: all",
            "    containerEdits:",
            "      deviceNodes:",
            "        - path: /dev/nvidia-uvm",
            "          hostPath: /dev/nvidia-uvm",
            "          type: c",
            "          major: 498",
            "",
          ].join("\n");
        }
        if (filePath === "/var/run/cdi/nvidia.yaml") {
          return [
            "cdiVersion: 0.5.0",
            "kind: nvidia.com/gpu",
            "devices:",
            "  - name: all",
            "    containerEdits:",
            "      deviceNodes:",
            "        - path: /dev/nvidia-uvm",
            "          hostPath: /dev/nvidia-uvm",
            "          type: c",
            "          major: 499",
            "",
          ].join("\n");
        }
        return "Linux version 6.8.0-58-generic";
      },
      readdirImpl: (dir: string) => {
        if (dir === "/etc/cdi") return ["nvidia.yaml"];
        if (dir === "/var/run/cdi") return ["nvidia.yaml"];
        return [];
      },
      runCaptureImpl: healthySystemctlAndStat,
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "27.0",
        CDISpecDirs: ["/etc/cdi", "/var/run/cdi"],
      }),
      commandExistsImpl: (name: string) =>
        name === "docker" || name === "systemctl" || name === "nvidia-ctk",
      gpuProbeImpl: () => true,
    });

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
    expect(result.cdiNvidiaGpuSpecStale).toBe(false);
    expect(result.cdiNvidiaGpuSpecNeedsRepair).toBe(false);
  });

  it("records stale effective CDI specs as repair-blocking", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: (filePath: string) =>
        filePath.endsWith("nvidia.yaml")
          ? [
              "cdiVersion: 0.5.0",
              "kind: nvidia.com/gpu",
              "devices:",
              "  - name: all",
              "    containerEdits:",
              "      deviceNodes:",
              "        - path: /dev/nvidia-uvm",
              "          hostPath: /dev/nvidia-uvm",
              "          type: c",
              "          major: 498",
              "",
            ].join("\n")
          : "Linux version 6.8.0-58-generic",
      readdirImpl: (dir: string) => (dir === "/etc/cdi" ? ["nvidia.yaml"] : []),
      runCaptureImpl: healthySystemctlAndStat,
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "27.0",
        CDISpecDirs: ["/etc/cdi"],
      }),
      commandExistsImpl: (name: string) =>
        name === "docker" || name === "systemctl" || name === "nvidia-ctk",
      gpuProbeImpl: () => true,
    });

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
    expect(result.cdiNvidiaGpuSpecStale).toBe(true);
    expect(result.cdiNvidiaGpuSpecNeedsRepair).toBe(true);
    expect(result.cdiNvidiaGpuSpecMismatch).toContain("/dev/nvidia-uvm=498:0");
    expect(result.cdiNvidiaGpuSpecMismatch).toContain("live=499:0");
  });

  it("treats refresh-unit health as a non-repair warning", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: (filePath: string) =>
        filePath.endsWith("nvidia.yaml")
          ? "cdiVersion: 0.5.0\nkind: nvidia.com/gpu\ndevices: []\n"
          : "Linux version 6.8.0-58-generic",
      readdirImpl: (dir: string) => (dir === "/etc/cdi" ? ["nvidia.yaml"] : []),
      runCaptureImpl: (command: readonly string[]) => {
        if (command[0] === "systemctl" && command[1] === "is-enabled") {
          return command[2] === "nvidia-cdi-refresh.service" ? "disabled" : "enabled";
        }
        if (command[0] === "systemctl" && command[1] === "is-active") return "active";
        if (command[0] === "systemctl" && command[1] === "is-failed") return "inactive";
        if (command[0] === "stat") return "1f3 0";
        return "";
      },
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "27.0",
        CDISpecDirs: ["/etc/cdi"],
      }),
      commandExistsImpl: (name: string) =>
        name === "docker" || name === "systemctl" || name === "nvidia-ctk",
      gpuProbeImpl: () => true,
    });

    expect(result.cdiNvidiaGpuRefreshUnhealthy).toBe(false);
    expect(result.cdiNvidiaGpuSpecNeedsRepair).toBe(false);
    expect(result.nvidiaCdiRefreshServiceEnabled).toBe(false);
  });

  it("does not apply CDI checks without an NVIDIA Linux CDI context", () => {
    const linuxWithoutGpu = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: () => "Linux version 6.8.0-58-generic",
      readdirImpl: () => [],
      dockerInfoOutput: JSON.stringify({ ServerVersion: "27.0", CDISpecDirs: ["/etc/cdi"] }),
      commandExistsImpl: (name: string) => name === "docker",
      gpuProbeImpl: () => false,
    });
    const noCdiDirs = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: () => "Linux version 6.8.0-58-generic",
      readdirImpl: () => [],
      dockerInfoOutput: JSON.stringify({ ServerVersion: "24.0" }),
      commandExistsImpl: (name: string) => name === "docker",
      gpuProbeImpl: () => true,
    });

    expect(linuxWithoutGpu.cdiNvidiaGpuSpecMissing).toBe(false);
    expect(noCdiDirs.dockerCdiSpecDirs).toEqual([]);
    expect(noCdiDirs.cdiNvidiaGpuSpecMissing).toBe(false);
  });
});

describe("planHostRemediation — CDI", () => {
  it("emits a blocking generate action for missing nvidia.com/gpu specs", () => {
    const actions = planHostRemediation(baseAssessment({ cdiNvidiaGpuSpecMissing: true }));
    const action = actions.find((entry: { id: string }) => entry.id === "generate_nvidia_cdi_spec");

    expect(action).toBeTruthy();
    expect(action?.kind).toBe("sudo");
    expect(action?.blocking).toBe(true);
    expect(action?.commands.some((command) => command.includes("--output='/etc/cdi"))).toBe(true);
    expect(action?.commands.some((command) => command.includes("nvidia-ctk cdi list"))).toBe(true);
  });

  it("emits service-refresh commands for stale nvidia.com/gpu specs", () => {
    const actions = planHostRemediation(
      baseAssessment({
        cdiNvidiaGpuSpecStale: true,
        cdiNvidiaGpuSpecNeedsRepair: true,
        cdiNvidiaGpuSpecMismatch: "/etc/cdi/nvidia.yaml /dev/nvidia-uvm=498:0, live=499:0",
      }),
    );
    const action = actions.find((entry: { id: string }) => entry.id === "refresh_nvidia_cdi_spec");

    expect(action).toBeTruthy();
    expect(action?.blocking).toBe(true);
    expect(action?.commands[0]).toBe(
      "sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service",
    );
    expect(action?.commands[1]).toBe("sudo systemctl start nvidia-cdi-refresh.service");
    expect(
      action?.commands.some((command) => command.includes("sudo rm -f '/etc/cdi/nvidia.yaml'")),
    ).toBe(true);
    expect(action?.commands.some((command) => command.includes("--output=/etc/cdi"))).toBe(false);
    expect(action?.commands.some((command) => command.includes("nvidia-ctk cdi list"))).toBe(false);
  });

  it("emits manual stale-spec guidance without systemctl on non-systemd hosts", () => {
    const actions = planHostRemediation(
      baseAssessment({
        systemctlAvailable: false,
        cdiNvidiaGpuSpecStale: true,
        cdiNvidiaGpuSpecNeedsRepair: true,
        cdiNvidiaGpuSpecMismatch: "/etc/cdi/nvidia.yaml /dev/nvidia-uvm=498:0, live=499:0",
      }),
    );
    const action = actions.find((entry: { id: string }) => entry.id === "refresh_nvidia_cdi_spec");

    expect(action).toBeTruthy();
    expect(action?.blocking).toBe(true);
    expect(action?.kind).toBe("manual");
    expect(action?.commands.join("\n")).toContain("/var/run/cdi/nvidia.yaml");
    expect(action?.commands.join("\n")).not.toContain("systemctl");
  });

  it("emits a non-blocking refresh-service warning when refresh units are unhealthy", () => {
    const actions = planHostRemediation(
      baseAssessment({
        dockerCdiSpecDirs: ["/etc/cdi"],
        cdiNvidiaGpuRefreshUnhealthy: true,
        cdiNvidiaGpuSpecNeedsRepair: false,
        nvidiaCdiRefreshPathEnabled: false,
        nvidiaCdiRefreshPathActive: false,
      }),
    );
    const action = actions.find(
      (entry: { id: string }) => entry.id === "warn_nvidia_cdi_refresh_unhealthy",
    );

    expect(action).toBeTruthy();
    expect(action?.blocking).toBe(false);
    expect(action?.title).toBe("Enable NVIDIA CDI refresh service");
    expect(action?.reason).toContain("path disabled");
  });

  it("bootstraps nvidia-container-toolkit before missing-spec generation", () => {
    const actions = planHostRemediation(
      baseAssessment({
        cdiNvidiaGpuSpecMissing: true,
        nvidiaContainerToolkitInstalled: false,
      }),
    );
    const action = actions.find((entry) => entry.id === "install_nvidia_container_toolkit");

    expect(action).toBeTruthy();
    expect(
      action?.commands.some(
        (command) => command === "sudo apt-get install -y nvidia-container-toolkit",
      ),
    ).toBe(true);
    expect(
      action?.commands.some((command) =>
        command.startsWith("sudo nvidia-ctk cdi generate --output="),
      ),
    ).toBe(true);
  });
});
