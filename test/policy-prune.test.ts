// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");

function runScript(scriptBody: string): SpawnSyncReturns<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-prune-"));
  const scriptPath = path.join(tmpDir, "script.js");
  fs.writeFileSync(scriptPath, scriptBody);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      NEMOCLAW_NON_INTERACTIVE: "1",
    },
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

function buildScript(args: {
  policies: string[];
  customPolicies?: Array<{ name: string; content?: string }>;
}): string {
  const policiesPath = JSON.stringify(
    path.join(REPO_ROOT, "dist", "lib", "policy", "index.js"),
  );
  const registryPath = JSON.stringify(
    path.join(REPO_ROOT, "dist", "lib", "state", "registry.js"),
  );

  return String.raw`
const policies = require(${policiesPath});
const registry = require(${registryPath});

const updates = [];
const initial = ${JSON.stringify({
    name: "alpha",
    policies: args.policies,
    customPolicies: args.customPolicies ?? [],
  })};

registry.getSandbox = (name) => (name === "alpha" ? structuredClone(initial) : null);
registry.updateSandbox = (name, patch) => {
  updates.push({ name, patch });
  Object.assign(initial, patch);
  return true;
};

const warnings = [];
const origWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(" ")); };

const stale = policies.pruneStaleBuiltInPresets("alpha");
console.warn = origWarn;

process.stdout.write(JSON.stringify({ stale, updates, warnings }));
`;
}

describe("policy.pruneStaleBuiltInPresets", () => {
  it("returns empty and leaves the registry untouched when every preset is known", () => {
    const result = runScript(
      buildScript({ policies: ["npm", "brave"] }),
    );
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.stale).toEqual([]);
    expect(payload.updates).toEqual([]);
    expect(payload.warnings).toEqual([]);
  });

  it("drops stale built-in names, warns, and writes the cleaned list back", () => {
    // `brew` and `legacy-nope` are not in the on-disk preset directory after
    // #3757; `npm`, `huggingface`, and `brave` still are.
    const result = runScript(
      buildScript({
        policies: ["npm", "brew", "huggingface", "legacy-nope", "brave"],
      }),
    );
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.stale).toEqual(["brew", "legacy-nope"]);
    expect(payload.updates).toEqual([
      { name: "alpha", patch: { policies: ["npm", "huggingface", "brave"] } },
    ]);
    expect(payload.warnings.join("\n")).toMatch(/dropping stale preset.*brew/);
    expect(payload.warnings.join("\n")).toMatch(/legacy-nope/);
    expect(payload.warnings.join("\n")).toMatch(/nemoclaw alpha rebuild/);
  });

  it("preserves custom preset names even when they are absent from listPresets()", () => {
    const result = runScript(
      buildScript({
        policies: ["npm", "my-internal-api", "brew"],
        customPolicies: [{ name: "my-internal-api", content: "..." }],
      }),
    );
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.stale).toEqual(["brew"]);
    expect(payload.updates).toEqual([
      { name: "alpha", patch: { policies: ["npm", "my-internal-api"] } },
    ]);
  });
});

describe("policy.partitionKnownPresetNames", () => {
  function partitionScript(presetNames: string[], customNames: string[]): string {
    const policiesPath = JSON.stringify(
      path.join(REPO_ROOT, "dist", "lib", "policy", "index.js"),
    );
    return String.raw`
const policies = require(${policiesPath});
process.stdout.write(JSON.stringify(policies.partitionKnownPresetNames(${JSON.stringify(presetNames)}, ${JSON.stringify(customNames)})));
`;
  }

  it("keeps every preset name when all are still defined", () => {
    const result = runScript(partitionScript(["npm", "brave"], []));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ known: ["npm", "brave"], stale: [] });
  });

  it("flags names absent from both built-in and custom lists as stale", () => {
    const result = runScript(partitionScript(["npm", "brew"], []));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ known: ["npm"], stale: ["brew"] });
  });

  it("treats custom preset names as known", () => {
    const result = runScript(
      partitionScript(["npm", "my-internal-api"], ["my-internal-api"]),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      known: ["npm", "my-internal-api"],
      stale: [],
    });
  });
});
