// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const logPresetScopeMock = vi.hoisted(() => vi.fn());
vi.mock("../policy", () => ({
  mergePresetNamesIntoPolicy: (policy: string, presetNames: string[]) => {
    const additions = presetNames.flatMap((preset) => {
      const policyKey = preset === "wechat" ? "wechat_bridge" : preset;
      return new RegExp(`^  ${policyKey}:`, "mu").test(policy) ? [] : [`  ${policyKey}: {}`];
    });
    return {
      policy: additions.length === 0 ? policy : `${policy.trimEnd()}\n${additions.join("\n")}\n`,
      appliedPresets: presetNames,
      missingPresets: [],
    };
  },
  logPresetScope: logPresetScopeMock,
}));

import {
  buildDirectGpuPolicyYaml,
  buildDirectSandboxGpuProofCommands,
  discloseInitialSandboxPolicy,
  discoverHostStationGb300SysfsReadOnlyPaths,
  discoverStationGb300SysfsReadOnlyPaths,
  getNetworkPolicyNames,
  isStationGb300ProductName,
  planHermesPortableInitialSandboxPolicy,
  prepareInitialSandboxCreatePolicy,
} from "./initial-policy";

const BASE_POLICY_FIXTURE = `
version: 1
filesystem_policy:
  read_only:
    - /usr
    - /proc
  read_write:
    - /tmp
network_policies:
  managed_inference:
    name: managed_inference
    endpoints: []
`;

const STATION_GB300_SYSFS_READ_ONLY_PATHS = [
  "/sys/bus/pci/devices/0008:05:00.0",
  "/sys/bus/pci/devices/0009:06:00.0",
  "/sys/devices/system/cpu",
  "/sys/devices/system/memory",
  "/sys/devices/system/node",
  "/sys/module/nvidia/initstate",
  "/sys/module/nvidia_uvm/initstate",
];

function expectSingleOccurrence(entries: string[], expected: string): void {
  expect(entries.filter((entry) => entry === expected)).toHaveLength(1);
}

const tmpRoots: string[] = [];
const originalOtelEnv = {
  enabled: process.env.NEMOCLAW_OPENCLAW_OTEL,
  endpoint: process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT,
  serviceName: process.env.NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME,
  sampleRate: process.env.NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE,
};

beforeEach(() => {
  logPresetScopeMock.mockReset();
  delete process.env.NEMOCLAW_OPENCLAW_OTEL;
  delete process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT;
  delete process.env.NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME;
  delete process.env.NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE;
});

function tmpPolicy(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-initial-policy-test-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "base.yaml");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

function tmpHostedInstallerPolicy(content: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hosted-policy-test-"));
  tmpRoots.push(root);
  const policies = path.join(root, "nemoclaw-blueprint", "policies");
  const presets = path.join(policies, "presets");
  fs.mkdirSync(presets, { recursive: true });
  fs.chmodSync(policies, 0o775);
  fs.chmodSync(presets, 0o775);
  const basePolicyPath = path.join(policies, "base.yaml");
  fs.writeFileSync(basePolicyPath, content, { mode: 0o664 });
  fs.chmodSync(basePolicyPath, 0o664);
  const presetPath = path.join(presets, "personal-open-internet.yaml");
  fs.writeFileSync(presetPath, "version: 1\nnetwork_policies: {}\n", { mode: 0o664 });
  fs.chmodSync(presetPath, 0o664);
  return basePolicyPath;
}

function tmpSysfsRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-sysfs-test-"));
  tmpRoots.push(dir);
  return dir;
}

function writeSysfsFile(root: string, relativePath: string, content: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

function addPciDevice(
  root: string,
  bdf: string,
  vendor: string,
  pciClass: string,
  device = "0x31c2\n",
): void {
  writeSysfsFile(root, path.join("bus", "pci", "devices", bdf, "vendor"), vendor);
  writeSysfsFile(root, path.join("bus", "pci", "devices", bdf, "device"), device);
  writeSysfsFile(root, path.join("bus", "pci", "devices", bdf, "class"), pciClass);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalOtelEnv.enabled === undefined) delete process.env.NEMOCLAW_OPENCLAW_OTEL;
  else process.env.NEMOCLAW_OPENCLAW_OTEL = originalOtelEnv.enabled;
  if (originalOtelEnv.endpoint === undefined) delete process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT;
  else process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = originalOtelEnv.endpoint;
  if (originalOtelEnv.serviceName === undefined)
    delete process.env.NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME;
  else process.env.NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME = originalOtelEnv.serviceName;
  if (originalOtelEnv.sampleRate === undefined)
    delete process.env.NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE;
  else process.env.NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE = originalOtelEnv.sampleRate;
});

describe("initial sandbox policy helpers", () => {
  it("discloses the effective in-memory policy when exact source bytes are available (#9203)", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");
    const effectivePolicy = Buffer.from(
      "version: 1\nnetwork_policies:\n  personal-open-internet: {}\n",
    );

    discloseInitialSandboxPolicy({
      policyPath: basePolicyPath,
      appliedPresets: ["personal-open-internet"],
      sourceBytes: effectivePolicy,
    });

    expect(logPresetScopeMock).toHaveBeenCalledWith(effectivePolicy.toString("utf8"));
  });

  it("plans schema-5 Personal policy bytes without creating a temporary file (#9203)", () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");
    const mkdtemp = vi.spyOn(fs, "mkdtempSync");
    const writeFile = vi.spyOn(fs, "writeFileSync");

    const planned = planHermesPortableInitialSandboxPolicy(basePolicyPath, [], {
      agentName: "hermes",
      additionalPresets: ["personal-open-internet", "slack"],
    });

    expect(planned.policyPath).toBe(basePolicyPath);
    expect(planned.appliedPresets).toEqual(["personal-open-internet", "slack"]);
    expect(planned.sourceBytes?.toString("utf8")).toContain("personal-open-internet");
    expect(planned.cleanup).toBeUndefined();
    expect(planned.cleanupExact).toBeUndefined();
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("accepts the hosted installer policy source owned by the current user and group (#9203)", () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const basePolicyPath = tmpHostedInstallerPolicy("version: 1\nnetwork_policies:\n  base: {}\n");

    const planned = planHermesPortableInitialSandboxPolicy(basePolicyPath, [], {
      agentName: "hermes",
      additionalPresets: ["personal-open-internet"],
    });

    const policies = path.dirname(basePolicyPath);
    const presets = path.join(policies, "presets");
    const presetPath = path.join(presets, "personal-open-internet.yaml");
    const baseStat = fs.statSync(basePolicyPath);
    const presetStat = fs.statSync(presetPath);
    expect(fs.statSync(policies).mode & 0o777).toBe(0o775);
    expect(fs.statSync(presets).mode & 0o777).toBe(0o775);
    expect(baseStat.mode & 0o777).toBe(0o664);
    expect(baseStat.uid).toBe(process.getuid?.());
    expect(baseStat.gid).toBe(process.getgid?.());
    expect(presetStat.mode & 0o777).toBe(0o664);
    expect(presetStat.uid).toBe(process.getuid?.());
    expect(presetStat.gid).toBe(process.getgid?.());
    expect(planned.sourceBytes?.toString("utf8")).toContain("personal-open-internet");
  });

  it("rejects malformed schema-5 base policy bytes before planning effects (#9203)", () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(basePolicyPath, Buffer.from([0xff, 0xfe]));

    expect(() =>
      planHermesPortableInitialSandboxPolicy(basePolicyPath, [], {
        agentName: "hermes",
        additionalPresets: ["personal-open-internet"],
      }),
    ).toThrow("not strict UTF-8");
  });

  it("rejects a UTF-8 byte-order mark before schema-5 policy planning (#9203)", () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      basePolicyPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("version: 1\nnetwork_policies: {}\n"),
      ]),
    );

    expect(() =>
      planHermesPortableInitialSandboxPolicy(basePolicyPath, [], {
        agentName: "hermes",
        additionalPresets: ["personal-open-internet"],
      }),
    ).toThrow("must not include a UTF-8 byte-order mark");
  });

  it("rejects replaced, linked, or writable schema-5 policy requirements (#9203)", () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const original = tmpPolicy("version: 1\nnetwork_policies: {}\n");
    const replacement = path.join(path.dirname(original), "replacement.yaml");
    const plan = (policyPath: string) =>
      planHermesPortableInitialSandboxPolicy(policyPath, [], {
        agentName: "hermes",
        additionalPresets: ["personal-open-internet"],
      });

    fs.writeFileSync(replacement, "version: 1\nnetwork_policies: {}\n", { mode: 0o600 });
    fs.unlinkSync(original);
    fs.symlinkSync(replacement, original);
    expect(() => plan(original)).toThrow("source authority is unsafe");

    fs.unlinkSync(original);
    fs.linkSync(replacement, original);
    expect(() => plan(original)).toThrow("source authority is unsafe");

    fs.unlinkSync(original);
    fs.writeFileSync(original, "version: 1\nnetwork_policies: {}\n", { mode: 0o666 });
    fs.chmodSync(original, 0o666);
    expect(() => plan(original)).toThrow("source authority is unsafe");

    fs.chmodSync(original, 0o620);
    expect(() => plan(original)).toThrow("source authority is unsafe");

    fs.chmodSync(original, 0o602);
    expect(() => plan(original)).toThrow("source authority is unsafe");
  });

  it.each([
    ["Dell Pro Max with Station GB300", true],
    ["NVIDIA DGX Station GB300", true],
    ["NVIDIA DGX Station-GB300 Rev A", true],
    ["P3830", false],
    ["NVIDIA DGX Station GB300X", false],
    ["NVIDIA DGX Station A100", false],
    ["NVIDIA Jetson AGX GB300", false],
  ])("classifies only Station GB300 DMI products: %s (#7103)", (productName, expected) => {
    expect(isStationGb300ProductName(productName)).toBe(expected);
  });

  it("discovers exact NVIDIA GB300 PCI BDFs and fails closed without one (#7103)", () => {
    const sysfsRoot = tmpSysfsRoot();
    addPciDevice(sysfsRoot, "0009:06:00.0", "0x10de\n", "0x030200\n");
    addPciDevice(sysfsRoot, "0008:05:00.0", "0X10DE\n", "0x030000\n");
    addPciDevice(sysfsRoot, "0000:01:00.0", "0x10de\n", "0x020000\n");
    addPciDevice(sysfsRoot, "0000:02:00.0", "0x1002\n", "0x030000\n");
    addPciDevice(sysfsRoot, "0000:03:00.8", "0x10de\n", "0x030000\n");
    addPciDevice(sysfsRoot, "0000:04:00.0", "0x10de\n", "0x030000\n", "0xffff\n");

    for (const relativePath of [
      "devices/system/cpu",
      "devices/system/memory",
      "devices/system/node",
      "module/nvidia/initstate",
      "module/nvidia_uvm/initstate",
    ]) {
      fs.mkdirSync(path.join(sysfsRoot, relativePath), { recursive: true });
    }

    expect(discoverStationGb300SysfsReadOnlyPaths("NVIDIA DGX Station GB300", sysfsRoot)).toEqual(
      STATION_GB300_SYSFS_READ_ONLY_PATHS,
    );
    expect(discoverStationGb300SysfsReadOnlyPaths("NVIDIA DGX Station A100", sysfsRoot)).toEqual(
      [],
    );

    const noGpuSysfsRoot = tmpSysfsRoot();
    addPciDevice(noGpuSysfsRoot, "0000:01:00.0", "0x10de\n", "0x020000\n");
    expect(() =>
      discoverStationGb300SysfsReadOnlyPaths("NVIDIA DGX Station GB300", noGpuSysfsRoot),
    ).toThrow("no exact NVIDIA GB300 PCI device was found");
  });

  it("rejects a Station-classified non-GB300 product before GPU policy creation", () => {
    expect(() =>
      discoverHostStationGb300SysfsReadOnlyPaths({
        platform: "linux",
        architecture: "arm64",
        identity: {
          nvidiaPlatform: "station",
          productName: "NVIDIA DGX Station A100",
          stationProfile: "supported-dgx-os",
          stationGb300PciGpu: true,
          osId: "ubuntu",
          osVersionId: "24.04",
        },
      }),
    ).toThrow("the detected Station product is not a qualified GB300 system");
  });

  it("rejects Station GPU policy when host GPU availability fails", () => {
    expect(() =>
      discoverHostStationGb300SysfsReadOnlyPaths({
        platform: "linux",
        architecture: "arm64",
        hasNvidiaGpu: false,
        identity: {
          nvidiaPlatform: "station",
          productName: "NVIDIA DGX Station GB300",
          stationProfile: "supported-dgx-os",
          stationGb300PciGpu: true,
          osId: "ubuntu",
          osVersionId: "24.04",
        },
      }),
    ).toThrow("an available GB300 GPU");
  });

  it.each([
    "/sys/class",
    "/sys/class/net",
    "/sys/bus/pci/devices",
    "/sys/firmware",
    "/sys/fs",
    "/sys/kernel",
  ])(
    "scopes sysfs read access and lets OpenShell own /proc GPU enrichment [%s] (#7103)",
    (unrelatedPath) => {
      const gpuPolicy = buildDirectGpuPolicyYaml(BASE_POLICY_FIXTURE, {
        sysfsReadOnlyPaths: STATION_GB300_SYSFS_READ_ONLY_PATHS,
      });
      const baseDoc = YAML.parse(BASE_POLICY_FIXTURE);
      const gpuDoc = YAML.parse(gpuPolicy);

      // /proc is added at runtime by OpenShell's GPU enrichment;
      // create-time must not pre-declare it.
      expect(baseDoc.filesystem_policy.read_only).toContain("/proc");
      expect(gpuDoc.filesystem_policy.read_only).not.toContain("/proc");
      expect(gpuDoc.filesystem_policy.read_only).not.toContain("/sys");
      expect(gpuDoc.filesystem_policy.read_only).toEqual(
        expect.arrayContaining(STATION_GB300_SYSFS_READ_ONLY_PATHS),
      );

      expect(gpuDoc.filesystem_policy.read_only).not.toContain(unrelatedPath);

      expect(gpuDoc.filesystem_policy.read_write).not.toContain("/proc");
      expect(gpuDoc.filesystem_policy.read_write).not.toContain("/proc/self/task/*/comm");
    },
  );

  it("adds /proc read-write when Docker GPU patch must own GPU enrichment (#7103)", () => {
    const gpuPolicy = buildDirectGpuPolicyYaml(BASE_POLICY_FIXTURE, {
      procReadWrite: true,
      sysfsReadOnlyPaths: STATION_GB300_SYSFS_READ_ONLY_PATHS,
    });
    const gpuDoc = YAML.parse(gpuPolicy);

    expect(gpuDoc.filesystem_policy.read_only).not.toContain("/proc");
    expect(gpuDoc.filesystem_policy.read_only).not.toContain("/sys");
    expect(gpuDoc.filesystem_policy.read_only).toEqual(
      expect.arrayContaining(STATION_GB300_SYSFS_READ_ONLY_PATHS),
    );
    expect(gpuDoc.filesystem_policy.read_write).toContain("/proc");
    expect(gpuDoc.filesystem_policy.read_write).not.toContain("/proc/self/task/*/comm");
  });

  it.each(STATION_GB300_SYSFS_READ_ONLY_PATHS)(
    "removes stale proc entries from GPU policy input [case %#] (#7103)",
    (sysfsPath) => {
      const gpuPolicy = buildDirectGpuPolicyYaml(
        `
version: 1
filesystem_policy:
  include_workdir: true
  read_only:
    - /usr
    - /proc
    - /proc/self/task/*/comm
  read_write:
    - /tmp
    - /proc
    - /proc/self/task/*/comm
network_policies:
  nvidia:
    name: nvidia
    endpoints:
      - host: integrate.api.nvidia.com
        port: 443
`,
        { sysfsReadOnlyPaths: STATION_GB300_SYSFS_READ_ONLY_PATHS },
      );
      const gpuDoc = YAML.parse(gpuPolicy);

      expect(gpuDoc.filesystem_policy.read_only).toContain("/usr");
      expect(gpuDoc.filesystem_policy.read_only).not.toContain("/proc");
      expect(gpuDoc.filesystem_policy.read_only).not.toContain("/proc/self/task/*/comm");
      expect(gpuDoc.filesystem_policy.read_only).not.toContain("/sys");

      expectSingleOccurrence(gpuDoc.filesystem_policy.read_only, sysfsPath);

      expect(gpuDoc.filesystem_policy.read_write).toContain("/tmp");
      expect(gpuDoc.filesystem_policy.read_write).not.toContain("/proc");
      expect(gpuDoc.filesystem_policy.read_write).not.toContain("/proc/self/task/*/comm");
    },
  );

  it.each(Array.from(STATION_GB300_SYSFS_READ_ONLY_PATHS, (value) => [value]))(
    "preserves an existing broad read-only sysfs policy without expanding %s (#7103)",
    (sysfsPath) => {
      const gpuPolicy = buildDirectGpuPolicyYaml(
        `
version: 1
filesystem_policy:
  read_only:
    - /usr
    - /sys
  read_write:
    - /tmp
network_policies: {}
`,
        { sysfsReadOnlyPaths: STATION_GB300_SYSFS_READ_ONLY_PATHS },
      );
      const gpuDoc = YAML.parse(gpuPolicy);

      expect(gpuDoc.filesystem_policy.read_only).toContain("/usr");
      expectSingleOccurrence(gpuDoc.filesystem_policy.read_only, "/sys");

      expect(gpuDoc.filesystem_policy.read_only).not.toContain(sysfsPath);
    },
  );

  it.each(Array.from(STATION_GB300_SYSFS_READ_ONLY_PATHS, (value) => [value]))(
    "preserves an existing broad writable sysfs policy without expanding %s (#7103)",
    (sysfsPath) => {
      const gpuPolicy = buildDirectGpuPolicyYaml(
        `
version: 1
filesystem_policy:
  read_only:
    - /usr
  read_write:
    - /tmp
    - /sys
network_policies: {}
`,
        { sysfsReadOnlyPaths: STATION_GB300_SYSFS_READ_ONLY_PATHS },
      );
      const gpuDoc = YAML.parse(gpuPolicy);

      expect(gpuDoc.filesystem_policy.read_only).not.toContain("/sys");
      expect(gpuDoc.filesystem_policy.read_write).toContain("/tmp");
      expectSingleOccurrence(gpuDoc.filesystem_policy.read_write, "/sys");

      expect(gpuDoc.filesystem_policy.read_only).not.toContain(sysfsPath);
    },
  );

  it("deduplicates scoped sysfs paths and lets exact read-write entries win (#7103)", () => {
    const writablePath = "/sys/bus/pci/devices/0009:06:00.0";
    const gpuPolicy = buildDirectGpuPolicyYaml(
      `
version: 1
filesystem_policy:
  read_only:
    - /usr
    - ${writablePath}
    - ${writablePath}
    - /sys/devices/system/cpu
    - /sys/devices/system/cpu
  read_write:
    - /tmp
    - ${writablePath}
    - ${writablePath}
network_policies: {}
`,
      { sysfsReadOnlyPaths: STATION_GB300_SYSFS_READ_ONLY_PATHS },
    );
    const gpuDoc = YAML.parse(gpuPolicy);

    expect(gpuDoc.filesystem_policy.read_only).not.toContain(writablePath);
    expectSingleOccurrence(gpuDoc.filesystem_policy.read_write, writablePath);
    STATION_GB300_SYSFS_READ_ONLY_PATHS.filter((candidate) => candidate !== writablePath).forEach(
      (sysfsPath) => {
        expectSingleOccurrence(gpuDoc.filesystem_policy.read_only, sysfsPath);
      },
    );
  });

  it.each(Array.from(STATION_GB300_SYSFS_READ_ONLY_PATHS, (value) => [value]))(
    "keeps %s outside the non-Station direct GPU policy (#7103)",
    (sysfsPath) => {
      const gpuPolicy = buildDirectGpuPolicyYaml(BASE_POLICY_FIXTURE);
      const gpuDoc = YAML.parse(gpuPolicy);

      expect(gpuDoc.filesystem_policy.read_only).not.toContain("/sys");

      expect(gpuDoc.filesystem_policy.read_only).not.toContain(sysfsPath);
    },
  );

  it("preserves best-effort Landlock for missing Station sysfs paths (#7103)", () => {
    const sysfsRoot = tmpSysfsRoot();
    addPciDevice(sysfsRoot, "0009:06:00.0", "0x10de\n", "0x030200\n");
    const discoveredPaths = discoverStationGb300SysfsReadOnlyPaths(
      "NVIDIA DGX Station GB300",
      sysfsRoot,
    );
    const gpuPolicy = buildDirectGpuPolicyYaml(
      `${BASE_POLICY_FIXTURE}\nlandlock:\n  compatibility: best_effort\n`,
      { sysfsReadOnlyPaths: discoveredPaths },
    );
    const gpuDoc = YAML.parse(gpuPolicy);

    expect(gpuDoc.landlock.compatibility).toBe("best_effort");
    expect(discoveredPaths).toEqual(["/sys/bus/pci/devices/0009:06:00.0"]);
    expect(gpuDoc.filesystem_policy.read_only).toContain(discoveredPaths[0]);
    expect(gpuDoc.filesystem_policy.read_only).not.toContain("/sys/module/nvidia/initstate");
  });

  it("threads discovered Station sysfs paths through public policy preparation (#7103)", () => {
    const sysfsRoot = tmpSysfsRoot();
    addPciDevice(sysfsRoot, "0009:06:00.0", "0x10de\n", "0x030200\n");
    fs.mkdirSync(path.join(sysfsRoot, "devices", "system", "cpu"), { recursive: true });
    fs.mkdirSync(path.join(sysfsRoot, "module", "nvidia", "initstate"), { recursive: true });
    const discoveredPaths = discoverStationGb300SysfsReadOnlyPaths(
      "NVIDIA DGX Station GB300",
      sysfsRoot,
    );
    const basePolicyPath = tmpPolicy(BASE_POLICY_FIXTURE);

    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, [], {
      directGpu: true,
      stationGb300SysfsReadOnlyPaths: discoveredPaths,
    });
    const preparedDoc = YAML.parse(fs.readFileSync(prepared.policyPath, "utf-8"));

    expect(discoveredPaths).toEqual([
      "/sys/bus/pci/devices/0009:06:00.0",
      "/sys/devices/system/cpu",
      "/sys/module/nvidia/initstate",
    ]);
    discoveredPaths.forEach((discoveredPath) => {
      expectSingleOccurrence(preparedDoc.filesystem_policy.read_only, discoveredPath);
    });
    expect(preparedDoc.filesystem_policy.read_only).not.toContain("/sys");
    expect(prepared.cleanup?.()).toBe(true);
    expect(fs.existsSync(prepared.policyPath)).toBe(false);
  });

  it("builds direct sandbox GPU proof commands", () => {
    const commands = buildDirectSandboxGpuProofCommands("alpha");
    expect(commands.map((entry) => entry.label)).toEqual([
      "nvidia-smi when available",
      "/proc/<pid>/task/<tid>/comm write",
      "cuInit(0) via libcuda.so.1",
    ]);
    expect(commands.map((entry) => entry.id)).toEqual([
      "nvidia-smi",
      "proc-comm-write",
      "cuda-init",
    ]);
    expect(commands[1].optional).toBe(true);
    expect(commands[2].optional).toBe(true);
    expect(commands[0].args).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "sh",
      "-lc",
      expect.stringContaining("command -v nvidia-smi"),
    ]);
    expect(commands[1].args.join(" ")).toContain("/proc/self/comm");
    expect(commands[1].args.join(" ")).not.toContain("ls /proc/self/task");
    expect(commands[2].args.join(" ")).toContain("cuInit(0)");
    commands.forEach((command) => {
      expect(command.args.every((arg) => !/[\r\n]/.test(arg))).toBe(true);
    });
    expect(buildDirectSandboxGpuProofCommands("alpha", "nemoclaw")[0]?.args).toEqual([
      "sandbox",
      "exec",
      "-g",
      "nemoclaw",
      "-n",
      "alpha",
      "--",
      "sh",
      "-lc",
      expect.stringContaining("command -v nvidia-smi"),
    ]);
  });

  it("returns network policy names from a policy document", () => {
    expect(
      getNetworkPolicyNames("version: 1\nnetwork_policies:\n  slack: {}\n  npm: {}\n"),
    ).toEqual(new Set(["slack", "npm"]));
  });

  it("returns null when policy YAML cannot be parsed", () => {
    expect(getNetworkPolicyNames("network_policies: [unterminated")).toBeNull();
  });

  it("keeps the base policy when no channel needs a create-time preset", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");

    expect(prepareInitialSandboxCreatePolicy(basePolicyPath, ["whatsapp"])).toEqual({
      policyPath: basePolicyPath,
      appliedPresets: [],
    });
  });

  it("applies the WeChat bridge policy at sandbox creation", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");

    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, ["wechat"]);

    expect(prepared.policyPath).not.toBe(basePolicyPath);
    expect(prepared.appliedPresets).toEqual(["wechat"]);
    expect(getNetworkPolicyNames(fs.readFileSync(prepared.policyPath, "utf-8"))).toEqual(
      new Set(["base", "wechat_bridge"]),
    );
    expect(prepared.cleanup?.()).toBe(true);
    expect(fs.existsSync(prepared.policyPath)).toBe(false);
  });

  it("replaces an existing messaging key with its active channel preset", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  slack: {}\n");

    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, ["slack"], {
      sandboxName: "active-slack",
    });

    expect(prepared.policyPath).not.toBe(basePolicyPath);
    expect(prepared.appliedPresets).toEqual(["slack"]);
    expect(prepared.cleanup?.()).toBe(true);
  });

  it("materializes active channel policy authority over an agent base entry", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  discord: {}\n");

    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, ["discord"]);

    expect(prepared.policyPath).not.toBe(basePolicyPath);
    expect(prepared.appliedPresets).toEqual(["discord"]);
    expect(prepared.cleanup?.()).toBe(true);
  });

  it("filters inactive Hermes messaging policies from the create-time policy", () => {
    const basePolicyPath = tmpPolicy(
      [
        "version: 1",
        "network_policies:",
        "  pypi: {}",
        "  telegram: {}",
        "  discord: {}",
        "  slack: {}",
        "  teams: {}",
        "  wechat_bridge: {}",
        "",
      ].join("\n"),
    );

    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, ["discord"], {
      agentName: "hermes",
    });

    expect(prepared.policyPath).not.toBe(basePolicyPath);
    expect(prepared.appliedPresets).toEqual(["discord"]);
    expect(getNetworkPolicyNames(fs.readFileSync(prepared.policyPath, "utf-8"))).toEqual(
      new Set(["pypi", "discord"]),
    );
    expect(prepared.cleanup?.()).toBe(true);
    expect(fs.existsSync(prepared.policyPath)).toBe(false);
  });

  it("gives only portable Hermes an exact replacement-safe policy cleanup (#9203)", () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  discord: {}\n  slack: {}\n");
    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, ["discord"], {
      agentName: "hermes",
    });
    const parent = path.dirname(prepared.policyPath);
    const original = path.join(parent, "original.yaml");
    tmpRoots.push(parent);

    expect(prepared.cleanupExact).toEqual(expect.any(Function));
    fs.renameSync(prepared.policyPath, original);
    fs.writeFileSync(prepared.policyPath, "replacement\n", { mode: 0o600 });
    expect(prepared.cleanupExact?.()).toBe(false);
    expect(fs.readFileSync(prepared.policyPath, "utf8")).toBe("replacement\n");
    expect(fs.existsSync(original)).toBe(true);

    const ordinary = prepareInitialSandboxCreatePolicy(basePolicyPath, ["discord"], {
      agentName: "openclaw",
    });
    expect(ordinary).not.toHaveProperty("cleanupExact");
  });

  it("filters inactive Hermes messaging policies from the relative Hermes policy path", () => {
    const hermesPolicyPath = path.relative(
      process.cwd(),
      path.join(import.meta.dirname, "..", "..", "..", "agents", "hermes", "policy-additions.yaml"),
    );

    const prepared = prepareInitialSandboxCreatePolicy(hermesPolicyPath, ["discord"]);
    const policyNames = getNetworkPolicyNames(fs.readFileSync(prepared.policyPath, "utf-8"));

    expect(policyNames?.has("discord")).toBe(true);
    expect(policyNames?.has("telegram")).toBe(false);
    expect(policyNames?.has("slack")).toBe(false);
    expect(policyNames?.has("teams")).toBe(false);
    expect(policyNames?.has("wechat_bridge")).toBe(false);
    expect(prepared.cleanup?.()).toBe(true);
    expect(fs.existsSync(prepared.policyPath)).toBe(false);
  });

  it("merges missing create-time presets into a temporary policy", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");

    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, ["slack"]);

    expect(prepared.policyPath).not.toBe(basePolicyPath);
    expect(prepared.appliedPresets).toEqual(["slack"]);
    expect(fs.readFileSync(prepared.policyPath, "utf-8")).toContain("slack");
    expect(prepared.cleanup?.()).toBe(true);
    expect(fs.existsSync(prepared.policyPath)).toBe(false);
  });

  it("merges additional create-time presets with channel presets", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");

    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, ["slack"], {
      additionalPresets: ["nous-web"],
    });

    expect(prepared.appliedPresets).toEqual(["slack", "nous-web"]);
    expect(prepared.cleanup?.()).toBe(true);
  });

  it("removes all temporary policies when a later materialization write fails", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");
    const realWriteFileSync = fs.writeFileSync;
    const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
    let createdDirs: string[] = [];
    const writeSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementationOnce((...args) => realWriteFileSync(...args))
      .mockImplementationOnce(() => {
        throw new Error("policy write failed");
      });

    try {
      expect(() =>
        prepareInitialSandboxCreatePolicy(basePolicyPath, [], {
          directGpu: true,
          additionalPresets: ["slack"],
        }),
      ).toThrow("policy write failed");
    } finally {
      createdDirs = mkdtempSpy.mock.results.map(({ value }) => String(value));
      writeSpy.mockRestore();
      mkdtempSpy.mockRestore();
    }

    expect(createdDirs).toHaveLength(2);
    expect(createdDirs.every((dir) => Object.is(fs.existsSync(dir), false))).toBe(true);
  });

  it("merges openclaw-diagnostics-otel-local at create time when OTEL is enabled and the tier is known non-restricted", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");
    process.env.NEMOCLAW_OPENCLAW_OTEL = "1";
    process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = "http://host.openshell.internal:4318";
    delete process.env.NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME;
    delete process.env.NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE;
    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, [], {
      agentName: "openclaw",
      policyTier: "balanced",
    });

    expect(prepared.appliedPresets).toEqual(["openclaw-diagnostics-otel-local"]);
    expect(prepared.policyPath).not.toBe(basePolicyPath);
    expect(prepared.cleanup?.()).toBe(true);
  });

  it("defers openclaw-diagnostics-otel-local at create time when the tier is unknown (interactive flow)", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");
    process.env.NEMOCLAW_OPENCLAW_OTEL = "1";
    process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = "http://host.openshell.internal:4318";

    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, [], {
      agentName: "openclaw",
    });

    expect(prepared.appliedPresets).toEqual([]);
    expect(prepared.policyPath).toBe(basePolicyPath);
  });

  it("does not merge OpenClaw OTEL policy at create time for terminal agents", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");
    process.env.NEMOCLAW_OPENCLAW_OTEL = "1";
    process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = "http://host.openshell.internal:4318";

    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, [], {
      agentName: "langchain-deepagents-code",
    });

    expect(prepared.appliedPresets).toEqual([]);
    expect(prepared.policyPath).toBe(basePolicyPath);
    expect(prepared.cleanup).toBeUndefined();
  });

  it("suppresses openclaw-diagnostics-otel-local at create time on the restricted tier (defence-in-depth)", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");
    process.env.NEMOCLAW_OPENCLAW_OTEL = "1";
    process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = "http://host.openshell.internal:4318";

    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, [], {
      agentName: "openclaw",
      policyTier: "restricted",
    });

    expect(prepared.appliedPresets).toEqual([]);
    expect(prepared.policyPath).toBe(basePolicyPath);
  });

  it("keeps openclaw-diagnostics-otel-local at create time on the balanced tier when OTEL is enabled", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");
    process.env.NEMOCLAW_OPENCLAW_OTEL = "1";
    process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = "http://host.openshell.internal:4318";

    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, [], {
      agentName: "openclaw",
      policyTier: "balanced",
    });

    expect(prepared.appliedPresets).toEqual(["openclaw-diagnostics-otel-local"]);
    expect(prepared.cleanup?.()).toBe(true);
  });
});
