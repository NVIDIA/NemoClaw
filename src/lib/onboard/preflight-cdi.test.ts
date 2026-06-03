// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
// Import through the compiled dist/ output (via the bin/lib shim) so
// coverage is attributed to dist/lib/onboard/preflight.js, which is what the
// ratchet measures.
import {
  assessHost,
  getNvidiaCdiSpecPath,
  parseDockerCdiSpecDirs,
  planHostRemediation,
} from "../../../dist/lib/onboard/preflight";

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

describe("parseDockerCdiSpecDirs", () => {
  it("extracts the dirs from `docker info --format '{{json .}}'` output", () => {
    const fixture = JSON.stringify({ CDISpecDirs: ["/etc/cdi", "/var/run/cdi"] });
    expect(parseDockerCdiSpecDirs(fixture)).toEqual(["/etc/cdi", "/var/run/cdi"]);
  });

  it("returns an empty array when CDISpecDirs is absent", () => {
    expect(parseDockerCdiSpecDirs(JSON.stringify({ ServerVersion: "27.0" }))).toEqual([]);
  });

  it("returns an empty array when CDISpecDirs is the empty list", () => {
    expect(parseDockerCdiSpecDirs(JSON.stringify({ CDISpecDirs: [] }))).toEqual([]);
  });

  it("returns an empty array on empty input", () => {
    expect(parseDockerCdiSpecDirs("")).toEqual([]);
  });
});

describe("assessHost — CDI device-spec gap (#3152)", () => {
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

  it("flags disabled NVIDIA CDI refresh units even when a spec is present", () => {
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
        if (command[0] === "systemctl" && command[1] === "is-enabled") return "disabled";
        if (command[0] === "systemctl" && command[1] === "is-active") return "inactive";
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

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
    expect(result.cdiNvidiaGpuRefreshUnhealthy).toBe(true);
    expect(result.cdiNvidiaGpuSpecNeedsRepair).toBe(false);
    expect(result.nvidiaCdiRefreshPathEnabled).toBe(false);
    expect(result.nvidiaCdiRefreshPathActive).toBe(false);
  });

  it("does not flag the normal path-only refresh pattern as unhealthy", () => {
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

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
    expect(result.cdiNvidiaGpuRefreshUnhealthy).toBe(false);
    expect(result.cdiNvidiaGpuSpecNeedsRepair).toBe(false);
    expect(result.nvidiaCdiRefreshPathEnabled).toBe(true);
    expect(result.nvidiaCdiRefreshPathActive).toBe(true);
    expect(result.nvidiaCdiRefreshServiceEnabled).toBe(false);
  });

  it("flags a stale NVIDIA CDI spec when nvidia-uvm omits minor and its major no longer matches", () => {
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
      runCaptureImpl: (command: readonly string[]) => {
        if (command[0] === "systemctl" && command[1] === "is-enabled") return "enabled";
        if (command[0] === "systemctl" && command[1] === "is-active") return "active";
        if (command[0] === "systemctl" && command[1] === "is-failed") return "inactive";
        if (command[0] === "stat" && command[3] === "/dev/nvidia-uvm") return "1f3 0";
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

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
    expect(result.cdiNvidiaGpuRefreshUnhealthy).toBe(false);
    expect(result.cdiNvidiaGpuSpecStale).toBe(true);
    expect(result.cdiNvidiaGpuSpecNeedsRepair).toBe(true);
    expect(result.cdiNvidiaGpuSpecMismatch).toContain("/dev/nvidia-uvm=498:0");
    expect(result.cdiNvidiaGpuSpecMismatch).toContain("live=499:0");
  });

  it("flags a stale NVIDIA CDI spec when a non-uvm device no longer matches the live device", () => {
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
              "        - path: /dev/nvidia0",
              "          type: c",
              "          major: 196",
              "          minor: 0",
              "",
            ].join("\n")
          : "Linux version 6.8.0-58-generic",
      readdirImpl: (dir: string) => (dir === "/etc/cdi" ? ["nvidia.yaml"] : []),
      runCaptureImpl: (command: readonly string[]) => {
        if (command[0] === "systemctl" && command[1] === "is-enabled") return "enabled";
        if (command[0] === "systemctl" && command[1] === "is-active") return "active";
        if (command[0] === "systemctl" && command[1] === "is-failed") return "inactive";
        if (command[0] === "stat" && command[3] === "/dev/nvidia0") return "c3 0";
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

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
    expect(result.cdiNvidiaGpuRefreshUnhealthy).toBe(false);
    expect(result.cdiNvidiaGpuSpecStale).toBe(true);
    expect(result.cdiNvidiaGpuSpecNeedsRepair).toBe(true);
    expect(result.cdiNvidiaGpuSpecMismatch).toContain("/dev/nvidia0=196:0");
    expect(result.cdiNvidiaGpuSpecMismatch).toContain("live=195:0");
  });

  it("skips declared CDI device nodes whose live device is absent", () => {
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
              "        - path: /dev/nvidia1",
              "          type: c",
              "          major: 195",
              "          minor: 1",
              "",
            ].join("\n")
          : "Linux version 6.8.0-58-generic",
      readdirImpl: (dir: string) => (dir === "/etc/cdi" ? ["nvidia.yaml"] : []),
      runCaptureImpl: (command: readonly string[]) => {
        if (command[0] === "systemctl" && command[1] === "is-enabled") return "enabled";
        if (command[0] === "systemctl" && command[1] === "is-active") return "active";
        if (command[0] === "systemctl" && command[1] === "is-failed") return "inactive";
        if (command[0] === "stat" && command[3] === "/dev/nvidia1") return "";
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

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
    expect(result.cdiNvidiaGpuRefreshUnhealthy).toBe(false);
    expect(result.cdiNvidiaGpuSpecStale).toBe(false);
    expect(result.cdiNvidiaGpuSpecNeedsRepair).toBe(false);
  });

  it("accepts a healthy refresh service with all CDI device nodes matching live devices", () => {
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
              "        - path: /dev/nvidia0",
              "          type: c",
              "          major: 195",
              "          minor: 0",
              "        - path: /dev/nvidia-uvm",
              "          hostPath: /dev/nvidia-uvm",
              "          type: c",
              "          major: 499",
              "        - path: /dev/nvidia-uvm-tools",
              "          type: c",
              "          major: 499",
              "          minor: 1",
              "",
            ].join("\n")
          : "Linux version 6.8.0-58-generic",
      readdirImpl: (dir: string) => (dir === "/etc/cdi" ? ["nvidia.yaml"] : []),
      runCaptureImpl: (command: readonly string[]) => {
        if (command[0] === "systemctl" && command[1] === "is-enabled") return "enabled";
        if (command[0] === "systemctl" && command[1] === "is-active") return "active";
        if (command[0] === "systemctl" && command[1] === "is-failed") return "inactive";
        if (command[0] === "stat" && command[3] === "/dev/nvidia0") return "c3 0";
        if (command[0] === "stat" && command[3] === "/dev/nvidia-uvm") return "1f3 0";
        if (command[0] === "stat" && command[3] === "/dev/nvidia-uvm-tools") return "1f3 1";
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

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
    expect(result.cdiNvidiaGpuRefreshUnhealthy).toBe(false);
    expect(result.cdiNvidiaGpuSpecStale).toBe(false);
    expect(result.cdiNvidiaGpuSpecNeedsRepair).toBe(false);
  });

  it("does not flag a CDI device node whose explicit minor matches the live device", () => {
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
              "        - path: /dev/nvidia-uvm-tools",
              "          type: c",
              "          major: 499",
              "          minor: 1",
              "",
            ].join("\n")
          : "Linux version 6.8.0-58-generic",
      readdirImpl: (dir: string) => (dir === "/etc/cdi" ? ["nvidia.yaml"] : []),
      runCaptureImpl: (command: readonly string[]) => {
        if (command[0] === "systemctl" && command[1] === "is-enabled") return "enabled";
        if (command[0] === "systemctl" && command[1] === "is-active") return "active";
        if (command[0] === "systemctl" && command[1] === "is-failed") return "inactive";
        if (command[0] === "stat" && command[3] === "/dev/nvidia-uvm-tools") return "1f3 1";
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

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
    expect(result.cdiNvidiaGpuRefreshUnhealthy).toBe(false);
    expect(result.cdiNvidiaGpuSpecStale).toBe(false);
    expect(result.cdiNvidiaGpuSpecNeedsRepair).toBe(false);
  });

  it("stats CDI hostPath instead of the container path when both are present", () => {
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
              "        - path: /container/nvidia0",
              "          hostPath: /dev/nvidia0",
              "          type: c",
              "          major: 196",
              "          minor: 0",
              "",
            ].join("\n")
          : "Linux version 6.8.0-58-generic",
      readdirImpl: (dir: string) => (dir === "/etc/cdi" ? ["nvidia.yaml"] : []),
      runCaptureImpl: (command: readonly string[]) => {
        if (command[0] === "systemctl" && command[1] === "is-enabled") return "enabled";
        if (command[0] === "systemctl" && command[1] === "is-active") return "active";
        if (command[0] === "systemctl" && command[1] === "is-failed") return "inactive";
        if (command[0] === "stat" && command[3] === "/dev/nvidia0") return "c3 0";
        if (command[0] === "stat" && command[3] === "/container/nvidia0") return "c4 0";
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

    expect(result.cdiNvidiaGpuSpecStale).toBe(true);
    expect(result.cdiNvidiaGpuSpecMismatch).toContain("/dev/nvidia0=196:0");
    expect(result.cdiNvidiaGpuSpecMismatch).toContain("live=195:0");
  });

  it("accepts a JSON-serialised CDI spec as well", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: (filePath: string) =>
        filePath.endsWith("nvidia.json")
          ? '{"cdiVersion":"0.5.0","kind":"nvidia.com/gpu","devices":[]}'
          : "Linux version 6.8.0-58-generic",
      readdirImpl: (dir: string) => (dir === "/etc/cdi" ? ["nvidia.json"] : []),
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "27.0",
        CDISpecDirs: ["/etc/cdi"],
      }),
      commandExistsImpl: (name: string) => name === "docker",
      gpuProbeImpl: () => true,
    });

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
  });

  it("does not flag a non-NVIDIA Linux host even with CDI dirs configured", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: () => "Linux version 6.8.0-58-generic",
      readdirImpl: () => [],
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "27.0",
        CDISpecDirs: ["/etc/cdi"],
      }),
      commandExistsImpl: (name: string) => name === "docker",
      gpuProbeImpl: () => false,
    });

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
  });

  it("does not flag a host that does not advertise CDISpecDirs", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: () => "Linux version 6.8.0-58-generic",
      readdirImpl: () => [],
      dockerInfoOutput: JSON.stringify({ ServerVersion: "24.0" }),
      commandExistsImpl: (name: string) => name === "docker",
      gpuProbeImpl: () => true,
    });

    expect(result.dockerCdiSpecDirs).toEqual([]);
    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
  });

  it("does not flag macOS even when the docker info shape would otherwise match", () => {
    const result = assessHost({
      platform: "darwin",
      env: {},
      readFileImpl: () => "",
      readdirImpl: () => [],
      dockerInfoOutput: JSON.stringify({ CDISpecDirs: ["/etc/cdi"] }),
      commandExistsImpl: (name: string) => name === "docker",
      gpuProbeImpl: () => true,
    });

    expect(result.cdiNvidiaGpuSpecMissing).toBe(false);
  });

  it("does not accept a sibling device class such as nvidia.com/gpu-extra as a satisfying spec", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: (filePath: string) =>
        filePath.endsWith("nvidia-extra.yaml")
          ? "cdiVersion: 0.5.0\nkind: nvidia.com/gpu-extra\ndevices: []\n"
          : "Linux version 6.8.0-58-generic",
      readdirImpl: (dir: string) => (dir === "/etc/cdi" ? ["nvidia-extra.yaml"] : []),
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "27.0",
        CDISpecDirs: ["/etc/cdi"],
      }),
      commandExistsImpl: (name: string) => name === "docker",
      gpuProbeImpl: () => true,
    });

    expect(result.cdiNvidiaGpuSpecMissing).toBe(true);
  });

  it("does not accept a sibling device class in JSON form either", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: (filePath: string) =>
        filePath.endsWith("nvidia-extra.json")
          ? '{"cdiVersion":"0.5.0","kind":"nvidia.com/gpu-extra","devices":[]}'
          : "Linux version 6.8.0-58-generic",
      readdirImpl: (dir: string) => (dir === "/etc/cdi" ? ["nvidia-extra.json"] : []),
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "27.0",
        CDISpecDirs: ["/etc/cdi"],
      }),
      commandExistsImpl: (name: string) => name === "docker",
      gpuProbeImpl: () => true,
    });

    expect(result.cdiNvidiaGpuSpecMissing).toBe(true);
  });

  it("ignores spec files whose `kind` only mentions nvidia.com/gpu in a comment", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: (filePath: string) =>
        filePath.endsWith("notes.yaml")
          ? "# this used to declare nvidia.com/gpu; now stripped\nkind: example.com/cpu\n"
          : "Linux version 6.8.0-58-generic",
      readdirImpl: (dir: string) => (dir === "/etc/cdi" ? ["notes.yaml"] : []),
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "27.0",
        CDISpecDirs: ["/etc/cdi"],
      }),
      commandExistsImpl: (name: string) => name === "docker",
      gpuProbeImpl: () => true,
    });

    expect(result.cdiNvidiaGpuSpecMissing).toBe(true);
  });
});

describe("getNvidiaCdiSpecPath", () => {
  it("builds the default NVIDIA CDI spec path from Docker CDI dirs", () => {
    expect(getNvidiaCdiSpecPath({ dockerCdiSpecDirs: ["/etc/cdi/", "/var/run/cdi"] })).toBe(
      "/etc/cdi/nvidia.yaml",
    );
  });
});

describe("planHostRemediation — CDI", () => {
  it("emits a blocking generate_nvidia_cdi_spec action when CDI dirs are configured but no nvidia.com/gpu spec exists", () => {
    const actions = planHostRemediation(
      baseAssessment({
        cdiNvidiaGpuSpecMissing: true,
      }),
    );

    const action = actions.find(
      (entry: { id: string }) => entry.id === "generate_nvidia_cdi_spec",
    );
    expect(action).toBeTruthy();
    expect(action?.kind).toBe("sudo");
    expect(action?.blocking).toBe(true);
    expect(action?.commands[0]).toBe("sudo mkdir -p /etc/cdi");
    expect(action?.commands[1]).toBe(
      "sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service",
    );
    expect(action?.commands[2]).toBe("sudo systemctl start nvidia-cdi-refresh.service");
    expect(action?.commands[3]).toContain("nvidia-ctk cdi list");
    expect(action?.commands[4]).toContain(
      "sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml",
    );
    expect(action?.commands[5]).toContain("nvidia-ctk cdi list");
    expect(action?.commands[6]).toContain("nemoclaw onboard");
    expect(action?.reason).toContain("nvidia.com/gpu");
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
    expect(action?.commands[0]).toBe(
      "sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service",
    );
    expect(action?.commands[1]).toBe("sudo systemctl start nvidia-cdi-refresh.service");
  });

  it("emits an install_nvidia_container_toolkit action with apt bootstrap when nvidia-ctk is missing on apt hosts", () => {
    const actions = planHostRemediation(
      baseAssessment({
        cdiNvidiaGpuSpecMissing: true,
        nvidiaContainerToolkitInstalled: false,
      }),
    );

    expect(actions.find((entry) => entry.id === "generate_nvidia_cdi_spec")).toBeUndefined();
    const action = actions.find((entry) => entry.id === "install_nvidia_container_toolkit");
    expect(action).toBeTruthy();
    expect(action?.kind).toBe("sudo");
    expect(action?.blocking).toBe(true);
    expect(action?.title).toContain("Install NVIDIA Container Toolkit");
    expect(action?.reason).toContain("nvidia-container-toolkit");
    expect(action?.commands.some((c) => c.includes("nvidia-container-toolkit-keyring.gpg"))).toBe(
      true,
    );
    expect(action?.commands.some((c) => c === "sudo apt-get install -y nvidia-container-toolkit")).toBe(
      true,
    );
    expect(
      action?.commands.some((c) => c.startsWith("sudo nvidia-ctk cdi generate --output=")),
    ).toBe(true);
    const ctkInstallIndex =
      action?.commands.findIndex((c) => c === "sudo apt-get install -y nvidia-container-toolkit") ??
      -1;
    const ctkGenerateIndex =
      action?.commands.findIndex((c) => c.startsWith("sudo nvidia-ctk cdi generate --output=")) ??
      -1;
    expect(ctkInstallIndex).toBeGreaterThanOrEqual(0);
    expect(ctkGenerateIndex).toBeGreaterThan(ctkInstallIndex);
  });

  it("emits an install_nvidia_container_toolkit action with a docs pointer when nvidia-ctk is missing on unknown package managers", () => {
    const actions = planHostRemediation(
      baseAssessment({
        packageManager: "unknown",
        cdiNvidiaGpuSpecMissing: true,
        nvidiaContainerToolkitInstalled: false,
      }),
    );

    const action = actions.find((entry) => entry.id === "install_nvidia_container_toolkit");
    expect(action).toBeTruthy();
    expect(
      action?.commands.some((c) =>
        c.includes("docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide"),
      ),
    ).toBe(true);
    expect(
      action?.commands.some((c) => c.startsWith("sudo nvidia-ctk cdi generate --output=")),
    ).toBe(true);
  });
});
