// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  buildRuntimePermissivePolicy,
  type ExactManagedMcpPolicy,
} from "../src/lib/shields/permissive-runtime.js";

const BASE_PERMISSIVE = YAML.stringify({
  filesystem_policy: {
    include_workdir: true,
    read_only: ["/proc", "/etc"],
    read_write: ["/tmp", "/sandbox/.openclaw"],
  },
  landlock: { compatibility: "best_effort" },
});

const MANAGED_POLICY: ExactManagedMcpPolicy = {
  key: "mcp_bridge_alpha",
  networkPolicy: {
    endpoints: [{ host: "alpha.example.com", port: 443, protocol: "mcp" }],
    binaries: [{ path: "/opt/hermes/.venv/bin/python*" }],
  },
  policyName: "mcp-bridge-alpha",
  server: "alpha",
};

const HERMES_DISCORD_PERMISSIVE = YAML.stringify({
  network_policies: {
    discord: {
      endpoints: [
        {
          host: "discord.com",
          port: 443,
          credential_binding: { provider: "{sandboxName}-discord-bridge" },
        },
        {
          host: "gateway.discord.gg",
          port: 443,
          credential_binding: { provider: "{sandboxName}-discord-bridge" },
        },
        {
          host: "*.discord.gg",
          port: 443,
          credential_binding: { provider: "{sandboxName}-discord-bridge" },
        },
        { host: "cdn.discordapp.com", port: 443 },
      ],
    },
  },
});

const tempFilesToClean: string[] = [];

function trackTempForCleanup(out: string, basePath: string): void {
  // Defensive: if the helper degrades to the static base path we must
  // never try to `rm -rf` its parent dir — that would target the
  // user's checkout. Only enqueue paths that the helper actually
  // produced via mkdtemp.
  if (out === basePath) return;
  const tempRoot = path.resolve(os.tmpdir());
  const parent = path.resolve(path.dirname(out));
  const rel = path.relative(tempRoot, parent);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return;
  tempFilesToClean.push(out);
}

afterEach(() => {
  while (tempFilesToClean.length > 0) {
    const p = tempFilesToClean.pop();
    if (!p) continue;
    try {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("buildRuntimePermissivePolicy (#3942)", () => {
  it("keeps the Hermes Discord provider binding in Shields down", () => {
    let stagedPolicy = "";
    const out = buildRuntimePermissivePolicy("/unused-hermes-permissive.yaml", {
      livePolicyYaml: "",
      readBasePolicy: () => HERMES_DISCORD_PERMISSIVE,
      sandboxName: "hermes-box",
      writeTempPolicy: (yaml) => {
        stagedPolicy = yaml;
        return "/staged-hermes-permissive.yaml";
      },
    });

    expect(out).toBe("/staged-hermes-permissive.yaml");
    const policy = YAML.parse(stagedPolicy);
    const endpoints = policy.network_policies.discord.endpoints as Array<{
      host: string;
      credential_binding?: { provider?: string };
    }>;
    const credentialEndpoints = endpoints.filter((endpoint) =>
      ["discord.com", "gateway.discord.gg", "*.discord.gg"].includes(endpoint.host),
    );
    expect(credentialEndpoints.map((endpoint) => endpoint.host).sort()).toEqual([
      "*.discord.gg",
      "discord.com",
      "gateway.discord.gg",
    ]);
    expect(credentialEndpoints.map((endpoint) => endpoint.credential_binding?.provider)).toEqual([
      "hermes-box-discord-bridge",
      "hermes-box-discord-bridge",
      "hermes-box-discord-bridge",
    ]);
    expect(
      endpoints.find((endpoint) => endpoint.host === "cdn.discordapp.com")?.credential_binding,
    ).toBeUndefined();
    expect(stagedPolicy).not.toContain("{sandboxName}");
  });

  it("rejects an unsafe Hermes sandbox name before staging Shields down", () => {
    const writeTempPolicy = vi.fn(() => "/must-not-stage.yaml");

    expect(() =>
      buildRuntimePermissivePolicy("/unused-hermes-permissive.yaml", {
        livePolicyYaml: "",
        readBasePolicy: () => HERMES_DISCORD_PERMISSIVE,
        sandboxName: "bad:provider",
        writeTempPolicy,
      }),
    ).toThrow("Cannot materialize the Shields-down credential provider binding");
    expect(writeTempPolicy).not.toHaveBeenCalled();
  });

  it("preserves exact managed MCP entries without copying unrelated live egress (#7952)", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_write: ["/proc"] },
      network_policies: {
        mcp_bridge_alpha: MANAGED_POLICY.networkPolicy,
        unrelated_live_entry: {
          endpoints: [{ host: "unrelated.example.com", port: 443 }],
        },
      },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      managedMcpPolicies: [MANAGED_POLICY],
      readBasePolicy: () =>
        YAML.stringify({
          ...YAML.parse(BASE_PERMISSIVE),
          network_policies: {
            permissive_baseline: {
              endpoints: [{ host: "*", port: 443 }],
            },
          },
        }),
    });
    trackTempForCleanup(out, "/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.network_policies).toMatchObject({
      mcp_bridge_alpha: MANAGED_POLICY.networkPolicy,
      permissive_baseline: {
        endpoints: [{ host: "*", port: 443 }],
      },
    });
    expect(result.network_policies).not.toHaveProperty("unrelated_live_entry");
  });

  it("preserves /proc when the live GPU sandbox has it in read_write", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: {
        read_only: ["/etc", "/usr"],
        // GPU enrichment from src/lib/onboard/initial-policy.ts:57.
        read_write: ["/tmp", "/proc", "/home/linuxbrew"],
      },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");
    expect(out).not.toBe("/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.filesystem_policy.read_write).toEqual(
      expect.arrayContaining(["/tmp", "/sandbox/.openclaw", "/proc", "/home/linuxbrew"]),
    );
    // /proc must NOT also appear in read_only; rw wins.
    expect(result.filesystem_policy.read_only).not.toContain("/proc");
  });

  it("preserves non-list filesystem_policy fields (e.g. include_workdir)", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_write: ["/proc"], read_only: ["/usr"] },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");
    expect(out).not.toBe("/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.filesystem_policy.include_workdir).toBe(true);
  });

  it("merges live read_only paths into base read_only without clobbering rw", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: {
        // /tmp is in base read_write — live ro should NOT downgrade it.
        read_only: ["/usr", "/tmp"],
        read_write: [],
      },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");
    expect(out).not.toBe("/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.filesystem_policy.read_write).toContain("/tmp");
    expect(result.filesystem_policy.read_only).toContain("/usr");
    expect(result.filesystem_policy.read_only).not.toContain("/tmp");
  });

  it("deduplicates entries within each list and across lists", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: {
        read_only: ["/etc", "/etc"],
        read_write: ["/tmp", "/tmp", "/proc"],
      },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");
    expect(out).not.toBe("/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    const rwCount = result.filesystem_policy.read_write.filter((p: string) => p === "/tmp").length;
    const roCount = result.filesystem_policy.read_only.filter((p: string) => p === "/etc").length;
    expect(rwCount).toBe(1);
    expect(roCount).toBe(1);
    const rwSet = new Set(result.filesystem_policy.read_write);
    const readOnlyPaths = result.filesystem_policy.read_only as string[];
    expect(readOnlyPaths.every((pathname) => !rwSet.has(pathname))).toBe(true);
  });

  it("returns the static base path when live policy is empty", () => {
    const basePath = "/path/to/static.yaml";
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: "",
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    expect(out).toBe(basePath);
  });

  it("carries the live landlock stanza so a startup-sealed field is not changed (#8461)", () => {
    // Deep Agents Code starts with `strict` but ships no permissive policy of
    // its own, so the base is the OpenClaw document with `best_effort`.
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_only: ["/etc"], read_write: ["/tmp"] },
      landlock: { compatibility: "strict" },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.landlock).toEqual({ compatibility: "strict" });
  });

  it("carries a live landlock stanza that already equals the base (#8461)", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_only: ["/etc"], read_write: ["/tmp"] },
      landlock: { compatibility: "best_effort" },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.landlock).toEqual({ compatibility: "best_effort" });
  });

  it("keeps the base landlock stanza when the live policy carries none (#8461)", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_only: ["/etc"], read_write: ["/tmp"] },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.landlock).toEqual({ compatibility: "best_effort" });
  });

  it("carries Landlock when the live policy has no filesystem paths (#8461)", () => {
    const basePath = "/unused-base.yaml";
    const liveYaml = YAML.stringify({ landlock: { compatibility: "strict" } });
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, basePath);

    expect(out).not.toBe(basePath);
    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.landlock).toEqual({ compatibility: "strict" });
  });

  it("returns the static base path when readBasePolicy throws (I/O failure)", () => {
    const basePath = "/path/to/static.yaml";
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_write: ["/proc"] },
    });
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => {
        throw new Error("ENOENT");
      },
    });
    expect(out).toBe(basePath);
  });

  it("fails closed when the base cannot be read with managed MCP policies active (#7952)", () => {
    expect(() =>
      buildRuntimePermissivePolicy("/path/to/static.yaml", {
        livePolicyYaml: "version: 1\nnetwork_policies: {}\n",
        managedMcpPolicies: [MANAGED_POLICY],
        readBasePolicy: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toThrow(/Cannot read the Shields-down policy/);
  });

  it("fails closed when the base is not a mapping with managed MCP policies active (#7952)", () => {
    expect(() =>
      buildRuntimePermissivePolicy("/path/to/static.yaml", {
        livePolicyYaml: "version: 1\nnetwork_policies: {}\n",
        managedMcpPolicies: [MANAGED_POLICY],
        readBasePolicy: () => "[]",
      }),
    ).toThrow(/Cannot parse the Shields-down policy/);
  });

  it("fails closed when staging fails with managed MCP policies active (#7952)", () => {
    expect(() =>
      buildRuntimePermissivePolicy("/path/to/static.yaml", {
        livePolicyYaml: "version: 1\nnetwork_policies: {}\n",
        managedMcpPolicies: [MANAGED_POLICY],
        readBasePolicy: () => BASE_PERMISSIVE,
        writeTempPolicy: () => {
          throw new Error("ENOSPC: simulated /tmp full");
        },
      }),
    ).toThrow(/Cannot stage the Shields-down policy/);
  });

  it("returns the static base path when base YAML is unparseable", () => {
    const basePath = "/path/to/static.yaml";
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_write: ["/proc"] },
    });
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => "::: not yaml :::",
    });
    expect(out).toBe(basePath);
  });

  it("returns the static base path when temp-file write throws", () => {
    const basePath = "/path/to/static.yaml";
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_write: ["/proc"] },
    });
    let writeAttempts = 0;
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
      writeTempPolicy: () => {
        writeAttempts += 1;
        throw new Error("ENOSPC: simulated /tmp full");
      },
    });
    expect(out).toBe(basePath);
    expect(writeAttempts).toBe(1);
  });
});
