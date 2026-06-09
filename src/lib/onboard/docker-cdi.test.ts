// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
// Import through dist so coverage follows the CLI build output, matching the
// neighboring preflight tests.
import {
  buildNvidiaCdiRepairCommands,
  buildStaleCdiManualWarnCommands,
  buildStaleCdiWarnCommands,
  collectCdiDeviceNodes,
  findCdiDeviceNodeMismatch,
  getNvidiaCdiSpecPath,
  hasNvidiaCdiSpec,
  parseDockerCdiSpecDirs,
} from "../../../dist/lib/onboard/docker-cdi";

function specWithDeviceNodes(deviceNodes: string): string {
  return [
    "cdiVersion: 0.5.0",
    "kind: nvidia.com/gpu",
    "devices:",
    "  - name: all",
    "    containerEdits:",
    "      deviceNodes:",
    deviceNodes,
    "",
  ].join("\n");
}

function cdiFs(files: Record<string, string>) {
  return {
    readdirImpl: (dir: string) =>
      Object.keys(files)
        .filter((filePath) => filePath.startsWith(`${dir}/`))
        .map((filePath) => filePath.slice(dir.length + 1))
        .filter((entry) => entry && !entry.includes("/")),
    readFileImpl: (filePath: string) => files[filePath] ?? "",
  };
}

function statDevices(devices: Record<string, string>) {
  return (command: readonly string[]) => {
    if (command[0] === "stat") return devices[command[3]] ?? "";
    return "";
  };
}

describe("docker-cdi parsing", () => {
  it("extracts CDI dirs from whole docker info JSON and .CDISpecDirs JSON", () => {
    expect(
      parseDockerCdiSpecDirs(JSON.stringify({ CDISpecDirs: ["/etc/cdi", "/var/run/cdi"] })),
    ).toEqual(["/etc/cdi", "/var/run/cdi"]);
    expect(parseDockerCdiSpecDirs('["/etc/cdi","/var/run/cdi"]')).toEqual([
      "/etc/cdi",
      "/var/run/cdi",
    ]);
  });

  it("returns an empty array when CDI dirs are absent or empty", () => {
    expect(parseDockerCdiSpecDirs(JSON.stringify({ ServerVersion: "27.0" }))).toEqual([]);
    expect(parseDockerCdiSpecDirs(JSON.stringify({ CDISpecDirs: [] }))).toEqual([]);
    expect(parseDockerCdiSpecDirs("")).toEqual([]);
  });

  it("builds the default NVIDIA CDI spec path from Docker CDI dirs", () => {
    expect(getNvidiaCdiSpecPath({ dockerCdiSpecDirs: ["/etc/cdi/", "/var/run/cdi"] })).toBe(
      "/etc/cdi/nvidia.yaml",
    );
  });

  it("accepts exact nvidia.com/gpu YAML and JSON specs only", () => {
    const fs = cdiFs({
      "/etc/cdi/nvidia.yaml": "cdiVersion: 0.5.0\nkind: nvidia.com/gpu\ndevices: []\n",
      "/etc/cdi/nvidia.json": '{"cdiVersion":"0.5.0","kind":"nvidia.com/gpu","devices":[]}',
      "/etc/cdi/nvidia-extra.yaml": "kind: nvidia.com/gpu-extra\ndevices: []\n",
      "/etc/cdi/notes.yaml": "# nvidia.com/gpu used to be here\nkind: example.com/cpu\n",
    });

    expect(hasNvidiaCdiSpec(["/etc/cdi"], fs.readdirImpl, fs.readFileImpl)).toBe(true);
    expect(
      hasNvidiaCdiSpec(["/etc/cdi"], () => ["nvidia-extra.yaml", "notes.yaml"], fs.readFileImpl),
    ).toBe(false);
  });
});

describe("docker-cdi staleness detection", () => {
  it("ignores stale lower-precedence /etc/cdi when /var/run/cdi is fresh", () => {
    const fs = cdiFs({
      "/etc/cdi/nvidia.yaml": specWithDeviceNodes(
        "        - path: /dev/nvidia-uvm\n          hostPath: /dev/nvidia-uvm\n          type: c\n          major: 498",
      ),
      "/var/run/cdi/nvidia.yaml": specWithDeviceNodes(
        "        - path: /dev/nvidia-uvm\n          hostPath: /dev/nvidia-uvm\n          type: c\n          major: 499",
      ),
    });

    expect(
      findCdiDeviceNodeMismatch(
        ["/etc/cdi", "/var/run/cdi"],
        fs.readdirImpl,
        fs.readFileImpl,
        statDevices({ "/dev/nvidia-uvm": "1f3 0" }),
      ),
    ).toBeNull();
  });

  it("flags stale /etc/cdi when no higher-precedence /var/run/cdi spec exists", () => {
    const fs = cdiFs({
      "/etc/cdi/nvidia.yaml": specWithDeviceNodes(
        "        - path: /dev/nvidia-uvm\n          hostPath: /dev/nvidia-uvm\n          type: c\n          major: 498",
      ),
    });

    const mismatch = findCdiDeviceNodeMismatch(
      ["/etc/cdi", "/var/run/cdi"],
      fs.readdirImpl,
      fs.readFileImpl,
      statDevices({ "/dev/nvidia-uvm": "1f3 0" }),
    );

    expect(mismatch).toContain("/etc/cdi/nvidia.yaml");
    expect(mismatch).toContain("/dev/nvidia-uvm=498:0");
    expect(mismatch).toContain("live=499:0");
  });

  it("flags stale /var/run/cdi when it is the effective spec", () => {
    const fs = cdiFs({
      "/etc/cdi/nvidia.yaml": specWithDeviceNodes(
        "        - path: /dev/nvidia-uvm\n          hostPath: /dev/nvidia-uvm\n          type: c\n          major: 499",
      ),
      "/var/run/cdi/nvidia.yaml": specWithDeviceNodes(
        "        - path: /dev/nvidia-uvm\n          hostPath: /dev/nvidia-uvm\n          type: c\n          major: 498",
      ),
    });

    const mismatch = findCdiDeviceNodeMismatch(
      ["/etc/cdi", "/var/run/cdi"],
      fs.readdirImpl,
      fs.readFileImpl,
      statDevices({ "/dev/nvidia-uvm": "1f3 0" }),
    );

    expect(mismatch).toContain("/var/run/cdi/nvidia.yaml");
    expect(mismatch).toContain("/dev/nvidia-uvm=498:0");
    expect(mismatch).toContain("live=499:0");
  });

  it("defaults omitted minor to 0 and detects non-uvm drift", () => {
    const fs = cdiFs({
      "/etc/cdi/nvidia.yaml": specWithDeviceNodes(
        "        - path: /dev/nvidia-uvm\n          type: c\n          major: 498\n        - path: /dev/nvidia0\n          type: c\n          major: 195\n          minor: 0",
      ),
    });

    expect(
      findCdiDeviceNodeMismatch(
        ["/etc/cdi"],
        fs.readdirImpl,
        fs.readFileImpl,
        statDevices({ "/dev/nvidia-uvm": "1f3 0", "/dev/nvidia0": "c3 0" }),
      ),
    ).toContain("/dev/nvidia-uvm=498:0");
  });

  it("skips absent devices and accepts matching explicit minors", () => {
    const fs = cdiFs({
      "/etc/cdi/nvidia.yaml": specWithDeviceNodes(
        "        - path: /dev/nvidia1\n          type: c\n          major: 195\n          minor: 1\n        - path: /dev/nvidia-uvm-tools\n          type: c\n          major: 499\n          minor: 1",
      ),
    });

    expect(
      findCdiDeviceNodeMismatch(
        ["/etc/cdi"],
        fs.readdirImpl,
        fs.readFileImpl,
        statDevices({ "/dev/nvidia1": "", "/dev/nvidia-uvm-tools": "1f3 1" }),
      ),
    ).toBeNull();
  });

  it("stats CDI hostPath instead of the container path when both are present", () => {
    const nodes = collectCdiDeviceNodes(
      {
        deviceNodes: [
          { path: "/container/nvidia0", hostPath: "/dev/nvidia0", major: 196, minor: 0 },
        ],
      },
      "/etc/cdi/nvidia.yaml",
    );
    expect(nodes[0]).toMatchObject({ path: "/dev/nvidia0", major: 196, minor: 0 });
  });
});

describe("docker-cdi remediation commands", () => {
  it("keeps missing-spec remediation on the direct-generation fallback path", () => {
    const commands = buildNvidiaCdiRepairCommands(
      { systemctlAvailable: true },
      "/etc/cdi/nvidia.yaml",
    );

    expect(commands[0]).toBe("sudo mkdir -p '/etc/cdi'");
    expect(commands[1]).toBe(
      "sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service",
    );
    expect(commands[2]).toBe("sudo systemctl start nvidia-cdi-refresh.service");
    expect(commands[3]).toContain("nvidia-ctk cdi list");
    expect(commands[4]).toContain("sudo nvidia-ctk cdi generate --output='/etc/cdi/nvidia.yaml'");
    expect(commands[5]).toContain("nvidia-ctk cdi list");
  });

  it("shell-quotes CDI repair paths in generated commands", () => {
    const commands = buildNvidiaCdiRepairCommands(
      { systemctlAvailable: false },
      "/tmp/cdi dir/nvidia;bad.yaml",
    );

    expect(commands[0]).toBe("sudo mkdir -p '/tmp/cdi dir'");
    expect(commands[1]).toContain("--output='/tmp/cdi dir/nvidia;bad.yaml'");
  });

  it("shows stale-spec refresh commands with optional leftover removal only for /etc/cdi", () => {
    const leftoverCommands = buildStaleCdiWarnCommands("/etc/cdi/nvidia.yaml");
    expect(leftoverCommands[0]).toBe(
      "sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service",
    );
    expect(leftoverCommands[1]).toBe("sudo systemctl start nvidia-cdi-refresh.service");
    expect(leftoverCommands[2]).toContain("sudo rm -f '/etc/cdi/nvidia.yaml'");
    expect(leftoverCommands.join("\n")).not.toContain("--output=/etc/cdi");
    expect(leftoverCommands.join("\n")).not.toContain("nvidia-ctk cdi list");

    const serviceCommands = buildStaleCdiWarnCommands("/var/run/cdi/nvidia.yaml");
    expect(serviceCommands.some((command) => command.includes("rm -f"))).toBe(false);
  });

  it("shows manual stale-spec guidance without systemctl on non-systemd hosts", () => {
    const commands = buildStaleCdiManualWarnCommands("/etc/cdi/nvidia.yaml");

    expect(commands.join("\n")).toContain("/var/run/cdi/nvidia.yaml");
    expect(commands.join("\n")).toContain("sudo rm -f '/etc/cdi/nvidia.yaml'");
    expect(commands.join("\n")).not.toContain("systemctl");
    expect(commands.join("\n")).not.toContain("nvidia-ctk cdi list");
  });

  it("shell-quotes stale leftover paths in displayed guidance", () => {
    expect(buildStaleCdiWarnCommands("/tmp/cdi dir/nvidia;bad.yaml").join("\n")).toContain(
      "sudo rm -f '/tmp/cdi dir/nvidia;bad.yaml'",
    );
    expect(buildStaleCdiManualWarnCommands("/tmp/cdi dir/nvidia;bad.yaml").join("\n")).toContain(
      "sudo rm -f '/tmp/cdi dir/nvidia;bad.yaml'",
    );
  });
});
