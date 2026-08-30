// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  materializeRebuildPolicyHandoff,
  mergeReplacementPolicyAccess,
} from "./rebuild-policy-handoff";

const roots: string[] = [];

function tempPolicy(name: string, source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-handoff-test-"));
  roots.push(root);
  const policyPath = path.join(root, name);
  fs.writeFileSync(policyPath, source, { mode: 0o600 });
  return policyPath;
}

function readPrivatePolicy(policyPath: string): { mode: number; policy: unknown } {
  const descriptor = fs.openSync(
    policyPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    return {
      mode: fs.fstatSync(descriptor).mode & 0o777,
      policy: YAML.parse(fs.readFileSync(descriptor, "utf8")),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("rebuild policy handoff", () => {
  it("adds missing replacement access while preserving OpenShell's live choices", () => {
    const live = `
version: 1
filesystem_policy:
  include_workdir: false
  read_only: [/usr, /host-read]
  read_write: [/sandbox, /host-write, /replacement-write]
landlock:
  compatibility: host_choice
network_policies:
  host_edit:
    name: host_edit
    endpoints: [{host: host.example.com, port: 443}]
  host_npm_alias:
    name: npm
    endpoints: [{host: host-npm.example.com, port: 443}]
`;
    const replacement = `
version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/usr, /replacement-read, /replacement-write]
  read_write: [/sandbox, /host-read]
network_policies:
  host_edit:
    name: host_edit
    endpoints: [{host: replacement-host.example.com, port: 443}]
  npm:
    name: npm
    endpoints: [{host: registry.npmjs.org, port: 443}]
  replacement_network:
    name: replacement_network
    endpoints: [{host: replacement.example.com, port: 443}]
landlock:
  compatibility: replacement_choice
seccomp:
  profile: replacement-default
`;

    const merged = mergeReplacementPolicyAccess(live, replacement);
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
    expect(policy).toMatchObject({
      landlock: { compatibility: "host_choice" },
    });
    expect(policy.network_policies).toEqual({
      host_edit: {
        name: "host_edit",
        endpoints: [{ host: "host.example.com", port: 443 }],
      },
      host_npm_alias: {
        name: "npm",
        endpoints: [{ host: "host-npm.example.com", port: 443 }],
      },
    });
    expect(policy.network_policies).not.toHaveProperty("npm");
    expect(policy).not.toHaveProperty("seccomp");
  });

  it("reuses the exact live source when the replacement needs no additional access", () => {
    const live = "version: 1\nfilesystem_policy:\n  read_only: [/usr]\n  read_write: [/sandbox]\n";
    expect(mergeReplacementPolicyAccess(live, live)).toEqual({
      changed: false,
      source: live,
    });
  });

  it("preserves live network policy when no filesystem change is needed", () => {
    const live = "version: 1\nnetwork_policies:\n  host_edit: {name: host_edit}\n";
    const replacement =
      "version: 1\nnetwork_policies:\n  managed_inference: {name: managed_inference}\n";
    expect(mergeReplacementPolicyAccess(live, replacement)).toEqual({
      changed: false,
      source: live,
    });
  });

  it("adds only explicitly required messaging keys and lets live collisions win", () => {
    const live = `
version: 1
network_policies:
  host_edit: {name: host_edit}
  teams: {name: host_teams}
`;
    const replacement = `
version: 1
network_policies:
  teams: {name: generated_teams}
  wechat: {name: generated_wechat}
  unrelated: {name: unrelated}
`;

    const merged = mergeReplacementPolicyAccess(live, replacement, ["teams", "wechat"]);

    expect(merged.changed).toBe(true);
    expect(YAML.parse(merged.source).network_policies).toEqual({
      host_edit: { name: "host_edit" },
      teams: { name: "host_teams" },
      wechat: { name: "generated_wechat" },
    });
  });

  it("rejects an active messaging requirement missing from the replacement policy", () => {
    expect(() =>
      mergeReplacementPolicyAccess(
        "version: 1\nnetwork_policies: {}\n",
        "version: 1\nnetwork_policies: {}\n",
        ["wechat"],
      ),
    ).toThrow("required network policy 'wechat' is absent");
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
    const materialized = readPrivatePolicy(handoff.policyPath);
    expect(materialized.mode).toBe(0o600);
    expect(materialized.policy).toMatchObject({
      filesystem_policy: { read_only: ["/usr", "/run/replacement"] },
      network_policies: { host_edit: {} },
    });
    expect(materialized.policy).not.toMatchObject({ network_policies: { replacement: {} } });
    expect(handoff.appliedPresets).toEqual([]);
    expect(handoff.cleanup?.()).toBe(true);
    expect(cleanupReplacement).toHaveBeenCalledOnce();
    expect(fs.existsSync(handoff.policyPath)).toBe(false);
    expect(fs.existsSync(livePath)).toBe(true);
  });
});
