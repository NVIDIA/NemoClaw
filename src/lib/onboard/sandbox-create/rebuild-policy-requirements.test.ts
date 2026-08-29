// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  materializeRebuildCreatePolicy,
  mergeRebuildPolicyRequirements,
} from "./rebuild-policy-requirements";

const LIVE_POLICY = `
version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/usr]
  read_write: [/sandbox, /tmp]
landlock:
  compatibility: best_effort
process:
  run_as_user: sandbox
  run_as_group: sandbox
network_policies:
  managed_inference:
    name: managed_inference
    endpoints: [{host: inference.local, port: 443}]
  host_edit:
    name: host_edit
    endpoints: [{host: host.example.com, port: 443}]
`;

const CURRENT_POLICY = `
version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/usr, /run/nemoclaw/managed-startup-runtime.env]
  read_write: [/sandbox, /tmp, /dev/pts, /run/nemoclaw/runtime-state-mutation-startup]
landlock:
  compatibility: best_effort
process:
  run_as_user: sandbox
  run_as_group: sandbox
network_policies:
  managed_inference:
    name: managed_inference
    endpoints: [{host: replacement.example.com, port: 443}]
  current_required:
    name: current_required
    endpoints: [{host: required.example.com, port: 443}]
`;

describe("rebuild create policy requirements", () => {
  it("preserves host policy choices while adding missing replacement requirements", () => {
    const merged = YAML.parse(mergeRebuildPolicyRequirements(LIVE_POLICY, CURRENT_POLICY)) as {
      filesystem_policy: { read_only: string[]; read_write: string[] };
      network_policies: Record<string, { endpoints: Array<{ host: string }> }>;
    };

    expect(merged.filesystem_policy.read_only).toEqual([
      "/usr",
      "/run/nemoclaw/managed-startup-runtime.env",
    ]);
    expect(merged.filesystem_policy.read_write).toEqual([
      "/sandbox",
      "/tmp",
      "/dev/pts",
      "/run/nemoclaw/runtime-state-mutation-startup",
    ]);
    expect(merged.network_policies.host_edit).toBeDefined();
    expect(merged.network_policies.current_required).toBeDefined();
    expect(merged.network_policies.managed_inference?.endpoints[0]?.host).toBe("inference.local");
  });

  it("materializes one private ephemeral policy and removes only that generation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-requirements-test-"));
    const livePath = path.join(root, "live.yaml");
    const currentPath = path.join(root, "current.yaml");
    fs.writeFileSync(livePath, LIVE_POLICY, { mode: 0o600 });
    fs.writeFileSync(currentPath, CURRENT_POLICY, { mode: 0o600 });
    try {
      const policy = materializeRebuildCreatePolicy({
        livePolicyPath: livePath,
        currentPolicy: { policyPath: currentPath, appliedPresets: [] },
      });
      expect(fs.statSync(policy.policyPath).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(policy.policyPath, "utf8")).toContain("host_edit");
      expect(policy.cleanup?.()).toBe(true);
      expect(fs.existsSync(policy.policyPath)).toBe(false);
      expect(fs.existsSync(livePath)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
