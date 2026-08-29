// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  materializeRebuildPolicyHandoff,
  mergeReplacementFilesystemAccess,
} from "./rebuild-policy-handoff";

const roots: string[] = [];

function tempPolicy(name: string, source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-handoff-test-"));
  roots.push(root);
  const policyPath = path.join(root, name);
  fs.writeFileSync(policyPath, source, { mode: 0o600 });
  return policyPath;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("rebuild policy handoff", () => {
  it("adds only replacement filesystem access while preserving OpenShell's live policy", () => {
    const live = `
version: 1
filesystem_policy:
  include_workdir: false
  read_only: [/usr, /host-read]
  read_write: [/sandbox, /host-write, /replacement-write]
landlock:
  compatibility: best_effort
network_policies:
  host_edit:
    name: host_edit
    endpoints: [{host: host.example.com, port: 443}]
`;
    const replacement = `
version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/usr, /replacement-read, /replacement-write]
  read_write: [/sandbox, /host-read]
network_policies:
  replacement_network:
    name: replacement_network
    endpoints: [{host: replacement.example.com, port: 443}]
`;

    const merged = mergeReplacementFilesystemAccess(live, replacement);
    const policy = YAML.parse(merged.source) as {
      filesystem_policy: { include_workdir: boolean; read_only: string[]; read_write: string[] };
      network_policies: Record<string, unknown>;
    };

    expect(merged.changed).toBe(true);
    expect(policy.filesystem_policy).toEqual({
      include_workdir: false,
      read_only: ["/usr", "/replacement-read"],
      read_write: ["/sandbox", "/host-write", "/replacement-write", "/host-read"],
    });
    expect(policy.network_policies).toEqual({
      host_edit: {
        name: "host_edit",
        endpoints: [{ host: "host.example.com", port: 443 }],
      },
    });
    expect(policy.network_policies).not.toHaveProperty("replacement_network");
  });

  it("reuses the exact live source when the replacement needs no additional access", () => {
    const live = "version: 1\nfilesystem_policy:\n  read_only: [/usr]\n  read_write: [/sandbox]\n";
    expect(mergeReplacementFilesystemAccess(live, live)).toEqual({
      changed: false,
      source: live,
    });
  });

  it("materializes one private handoff and cleans it with the generated replacement source", () => {
    const livePath = tempPolicy(
      "live.yaml",
      "version: 1\nfilesystem_policy:\n  read_only: [/usr]\n  read_write: [/sandbox]\nnetwork_policies:\n  host_edit: {}\n",
    );
    const replacementPath = tempPolicy(
      "replacement.yaml",
      "version: 1\nfilesystem_policy:\n  read_only: [/usr, /run/replacement]\n  read_write: [/sandbox]\nnetwork_policies:\n  replacement: {}\n",
    );
    const cleanupReplacement = vi.fn(() => true);

    const handoff = materializeRebuildPolicyHandoff({
      livePolicyPath: livePath,
      replacementPolicy: {
        policyPath: replacementPath,
        appliedPresets: ["replacement"],
        cleanup: cleanupReplacement,
      },
    });

    expect(handoff.policyPath).not.toBe(livePath);
    expect(fs.statSync(handoff.policyPath).mode & 0o777).toBe(0o600);
    expect(YAML.parse(fs.readFileSync(handoff.policyPath, "utf8"))).toMatchObject({
      filesystem_policy: { read_only: ["/usr", "/run/replacement"] },
      network_policies: { host_edit: {} },
    });
    expect(handoff.appliedPresets).toEqual([]);
    expect(handoff.cleanup?.()).toBe(true);
    expect(cleanupReplacement).toHaveBeenCalledOnce();
    expect(fs.existsSync(handoff.policyPath)).toBe(false);
    expect(fs.existsSync(livePath)).toBe(true);
  });
});
