// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { buildMcpBridgePolicyYaml } from "../src/lib/actions/sandbox/mcp-bridge-policy-render.js";
import { withoutProviderComposedPolicies } from "../src/lib/policy/merge.js";
import { buildRuntimePermissivePolicy } from "../src/lib/shields/permissive-runtime.js";

const BASE_PERMISSIVE = YAML.stringify({
  filesystem_policy: {
    include_workdir: true,
    read_only: ["/proc", "/etc"],
    read_write: ["/tmp", "/sandbox/.openclaw"],
  },
  landlock: { compatibility: "best_effort" },
});

// Mirrors the shape of the shipped baseline: a fixed network allowlist that
// cannot see routes registered at runtime.
const BASE_PERMISSIVE_WITH_NETWORK = YAML.stringify({
  filesystem_policy: {
    include_workdir: true,
    read_only: ["/proc", "/etc"],
    read_write: ["/tmp", "/sandbox/.openclaw"],
  },
  network_policies: {
    nvidia: {
      name: "nvidia",
      endpoints: [{ host: "integrate.api.nvidia.com", port: 443, access: "full" }],
      binaries: [{ path: "/**" }],
    },
  },
});

// The real generated MCP entry, not a hand-written approximation.
const GENERATED_MCP = YAML.parse(
  buildMcpBridgePolicyYaml("fake", "https://mcp.example.com/mcp", "hermes-config", ["203.0.113.7"]),
).network_policies as Record<string, unknown>;

const MCP_KEY = "mcp_bridge_fake";

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
    for (const p of result.filesystem_policy.read_only) {
      expect(rwSet.has(p)).toBe(false);
    }
  });

  it("returns the static base path when live policy is empty", () => {
    const basePath = "/path/to/static.yaml";
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: "",
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    expect(out).toBe(basePath);
  });

  it("returns the static base path when live policy has no filesystem_policy section", () => {
    const basePath = "/path/to/static.yaml";
    const liveYaml = YAML.stringify({ landlock: { compatibility: "best_effort" } });
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    expect(out).toBe(basePath);
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

describe("buildRuntimePermissivePolicy network routes (#7952)", () => {
  it("keeps a registered MCP route that only the live policy knows about", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_only: ["/etc"], read_write: ["/tmp"] },
      network_policies: { ...GENERATED_MCP },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE_WITH_NETWORK,
    });
    trackTempForCleanup(out, "/unused-base.yaml");
    expect(out).not.toBe("/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.network_policies[MCP_KEY]).toEqual(GENERATED_MCP[MCP_KEY]);
    // The baseline's own routes survive untouched.
    expect(result.network_policies.nvidia.name).toBe("nvidia");
  });

  it("merges live routes even when the live policy has no filesystem section", () => {
    const liveYaml = YAML.stringify({ network_policies: { ...GENERATED_MCP } });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE_WITH_NETWORK,
    });
    trackTempForCleanup(out, "/unused-base.yaml");
    expect(out).not.toBe("/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.network_policies[MCP_KEY]).toEqual(GENERATED_MCP[MCP_KEY]);
  });

  it("keeps the permissive baseline entry when a route name exists in both", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_write: ["/tmp"] },
      network_policies: {
        nvidia: {
          name: "nvidia",
          // A narrower live rule must not tighten the permissive posture.
          endpoints: [{ host: "integrate.api.nvidia.com", port: 443, access: "read" }],
        },
      },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE_WITH_NETWORK,
    });
    trackTempForCleanup(out, "/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.network_policies.nvidia.endpoints[0].access).toBe("full");
  });

  it("never carries provider-composed entries into the applied policy", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_write: ["/tmp"] },
      network_policies: {
        ...GENERATED_MCP,
        _provider_openai: { name: "_provider_openai", endpoints: [] },
      },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE_WITH_NETWORK,
    });
    trackTempForCleanup(out, "/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.network_policies[MCP_KEY]).toBeDefined();
    expect(result.network_policies._provider_openai).toBeUndefined();
  });

  it("still returns the static base path when the live policy is entirely empty", () => {
    const basePath = "/path/to/static.yaml";
    const liveYaml = YAML.stringify({ landlock: { compatibility: "best_effort" } });
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE_WITH_NETWORK,
    });
    expect(out).toBe(basePath);
  });

  it("ignores a live network_policies that is not a mapping", () => {
    const basePath = "/path/to/static.yaml";
    const liveYaml = YAML.stringify({ network_policies: ["not", "a", "mapping"] });
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE_WITH_NETWORK,
    });
    expect(out).toBe(basePath);
  });

  it("carries across exactly what the canonical provider filter keeps (#7952)", () => {
    // This helper inlines the provider-composed prefix instead of importing
    // the canonical filter, which is only reachable through a built
    // artifact. Compare the two by behavior so the copies cannot drift.
    const live = {
      ...GENERATED_MCP,
      nvidia: { name: "nvidia" },
      _provider_openai: { name: "_provider_openai" },
      _provider_nvidia_nim: { name: "_provider_nvidia_nim" },
    };
    const expected = Object.keys(withoutProviderComposedPolicies(live)).sort();

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: YAML.stringify({ network_policies: live }),
      // A base with no routes of its own, so the applied document holds
      // exactly what the merge chose to carry across.
      readBasePolicy: () => YAML.stringify({ filesystem_policy: { include_workdir: true } }),
    });
    trackTempForCleanup(out, "/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(Object.keys(result.network_policies).sort()).toEqual(expected);
    expect(expected).toContain(MCP_KEY);
  });

  it("replaces a non-mapping base network_policies rather than indexing into it", () => {
    const liveYaml = YAML.stringify({ network_policies: { ...GENERATED_MCP } });
    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => YAML.stringify({ network_policies: ["unexpected"] }),
    });
    trackTempForCleanup(out, "/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.network_policies[MCP_KEY]).toEqual(GENERATED_MCP[MCP_KEY]);
  });
});
