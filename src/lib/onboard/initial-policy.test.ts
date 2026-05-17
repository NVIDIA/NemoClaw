// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

vi.mock("../policy", () => ({
  mergePresetNamesIntoPolicy: (policy: string, presetNames: string[]) => ({
    policy: `${policy.trimEnd()}\n  slack: {}\n`,
    appliedPresets: presetNames,
    missingPresets: [],
  }),
}));

import {
  buildDirectGpuPolicyYaml,
  buildDirectSandboxGpuProofCommands,
  getNetworkPolicyNames,
  prepareInitialSandboxCreatePolicy,
} from "./initial-policy";

const tmpRoots: string[] = [];

function tmpPolicy(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-initial-policy-test-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "base.yaml");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("initial sandbox policy helpers", () => {
  it("removes /proc from direct GPU create policy so OpenShell can own GPU enrichment", () => {
    const basePolicy = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "..", "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
      "utf-8",
    );
    const gpuPolicy = buildDirectGpuPolicyYaml(basePolicy);
    const baseDoc = YAML.parse(basePolicy);
    const gpuDoc = YAML.parse(gpuPolicy);

    // /proc is added at runtime by OpenShell's GPU enrichment;
    // create-time must not pre-declare it.
    expect(baseDoc.filesystem_policy.read_only).toContain("/proc");
    expect(gpuDoc.filesystem_policy.read_only).not.toContain("/proc");
    expect(gpuDoc.filesystem_policy.read_write).not.toContain("/proc");
    expect(gpuDoc.filesystem_policy.read_write).not.toContain("/proc/self/task/*/comm");
  });

  it("adds /proc read-write when Docker GPU patch must own GPU enrichment", () => {
    const basePolicy = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "..", "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
      "utf-8",
    );
    const gpuPolicy = buildDirectGpuPolicyYaml(basePolicy, { procReadWrite: true });
    const gpuDoc = YAML.parse(gpuPolicy);

    expect(gpuDoc.filesystem_policy.read_only).not.toContain("/proc");
    expect(gpuDoc.filesystem_policy.read_write).toContain("/proc");
    expect(gpuDoc.filesystem_policy.read_write).not.toContain("/proc/self/task/*/comm");
  });

  it("removes stale proc entries from GPU policy input", () => {
    const gpuPolicy = buildDirectGpuPolicyYaml(`
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
`);
    const gpuDoc = YAML.parse(gpuPolicy);

    expect(gpuDoc.filesystem_policy.read_only).toEqual(["/usr"]);
    expect(gpuDoc.filesystem_policy.read_write).toEqual(["/tmp"]);
  });

  it("builds direct sandbox GPU proof commands", () => {
    const commands = buildDirectSandboxGpuProofCommands("alpha");
    expect(commands.map((entry) => entry.label)).toEqual([
      "nvidia-smi when available",
      "/proc/<pid>/task/<tid>/comm write",
      "cuInit(0) via libcuda.so.1",
    ]);
    expect(commands.map((entry) => entry.id)).toEqual(["nvidia-smi", "proc-comm-write", "cuda-init"]);
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
    for (const command of commands) {
      for (const arg of command.args) {
        expect(arg).not.toMatch(/[\r\n]/);
      }
    }
  });

  it("returns network policy names from a policy document", () => {
    expect(getNetworkPolicyNames("version: 1\nnetwork_policies:\n  slack: {}\n  npm: {}\n")).toEqual(
      new Set(["slack", "npm"]),
    );
  });

  it("returns null when policy YAML cannot be parsed", () => {
    expect(getNetworkPolicyNames("network_policies: [unterminated")).toBeNull();
  });

  it("keeps the base policy when no channel needs a create-time preset", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");

    expect(prepareInitialSandboxCreatePolicy(basePolicyPath, ["telegram"])).toEqual({
      policyPath: basePolicyPath,
      appliedPresets: [],
    });
  });

  it("records an existing create-time preset without writing a temp policy", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  slack: {}\n");

    expect(prepareInitialSandboxCreatePolicy(basePolicyPath, ["slack"])).toEqual({
      policyPath: basePolicyPath,
      appliedPresets: ["slack"],
    });
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
});
