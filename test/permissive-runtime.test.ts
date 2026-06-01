// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import YAML from "yaml";

import { buildRuntimePermissivePolicy } from "../dist/lib/shields/permissive-runtime.js";

const BASE_PERMISSIVE = YAML.stringify({
  filesystem_policy: {
    include_workdir: true,
    read_only: ["/proc", "/etc"],
    read_write: ["/tmp", "/sandbox/.openclaw"],
  },
  landlock: { compatibility: "best_effort" },
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
