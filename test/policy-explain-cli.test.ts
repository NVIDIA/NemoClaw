// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "NODE_PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "NO_COLOR",
  "FORCE_COLOR",
];

function minimalEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...overrides };
}

function runCli(env: NodeJS.ProcessEnv, args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    env: minimalEnv(env),
  });
  return {
    status: result.status,
    stdout: (result.stdout || "").toString(),
    stderr: (result.stderr || "").toString(),
  };
}

function writeRegistry(home: string, sandboxes: Record<string, unknown>): void {
  const dir = path.join(home, ".nemoclaw");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "sandboxes.json"),
    JSON.stringify({ sandboxes, defaultSandbox: null }, null, 2),
    { mode: 0o600 },
  );
}

let scratchHome: string;

beforeEach(() => {
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-explain-"));
});

afterEach(() => {
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

describe("nemoclaw <sandbox> policy-explain (E2E)", () => {
  it("prints help text via both routing forms", () => {
    const productGrammar = runCli({ HOME: scratchHome }, ["my-sandbox", "policy-explain", "--help"]);
    expect(productGrammar.status).toBe(0);
    expect(productGrammar.stdout).toContain("Explain the active policy context for the sandbox");
    expect(productGrammar.stdout).toContain("--json");
    expect(productGrammar.stdout).toContain("--write");

    const oclifTopic = runCli({ HOME: scratchHome }, ["sandbox", "policy", "explain", "--help"]);
    expect(oclifTopic.status).toBe(0);
    expect(oclifTopic.stdout).toContain("Explain the active policy context for the sandbox");
  });

  it("emits a redacted markdown summary for a sandbox with applied presets", () => {
    writeRegistry(scratchHome, {
      "policy-explain-e2e": {
        name: "policy-explain-e2e",
        createdAt: "2026-06-07T00:00:00.000Z",
        policies: ["slack"],
        policyTier: "balanced",
        policyPresetsFinalized: true,
      },
    });

    const result = runCli({ HOME: scratchHome }, ["policy-explain-e2e", "policy-explain"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("# Sandbox policy context: policy-explain-e2e");
    expect(result.stdout).toContain("## Active presets");
    expect(result.stdout).toContain("`slack`");
    expect(result.stdout).toContain("slack.com");
    expect(result.stdout).toContain("## Failure classification");
    expect(result.stdout).toContain("`balanced`");
    expect(result.stdout).not.toMatch(/enforcement:|websocket_credential_rewrite|binaries:/);
    expect(result.stdout).not.toMatch(/network_policies:/);
  });

  it("emits a structured JSON object when --json is set", () => {
    writeRegistry(scratchHome, {
      "policy-explain-json": {
        name: "policy-explain-json",
        createdAt: "2026-06-07T00:00:00.000Z",
        policies: ["github"],
        policyTier: "balanced",
        policyPresetsFinalized: true,
      },
    });

    const result = runCli(
      { HOME: scratchHome },
      ["policy-explain-json", "policy-explain", "--json"],
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      sandboxName: string;
      tier: { name: string } | null;
      activePresets: Array<{ name: string; allowedHostCategories: string[] }>;
      knownUnappliedPresets: Array<{ name: string }>;
      approvalPath: { inspect: string; add: string; remove: string; documentation: string };
      supportBoundaries: Array<{ capability: string; owner: string }>;
    };

    expect(parsed.sandboxName).toBe("policy-explain-json");
    expect(parsed.tier?.name).toBe("balanced");
    const active = parsed.activePresets.find((p) => p.name === "github");
    expect(active).toBeDefined();
    expect(active?.allowedHostCategories).toContain("api.github.com");
    expect(parsed.knownUnappliedPresets.some((p) => p.name === "slack")).toBe(true);
    expect(parsed.approvalPath.inspect).toBe("nemoclaw policy-explain-json policy-list");
    expect(parsed.approvalPath.add).toBe("nemoclaw policy-explain-json policy-add <preset>");
    expect(parsed.supportBoundaries.some((b) => b.capability === "host allowlist enforcement")).toBe(
      true,
    );
  });

  it("returns an empty active-preset list when the sandbox has no policy applied", () => {
    writeRegistry(scratchHome, {
      bare: {
        name: "bare",
        createdAt: "2026-06-07T00:00:00.000Z",
      },
    });

    const result = runCli({ HOME: scratchHome }, ["bare", "policy-explain", "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      tier: unknown;
      activePresets: unknown[];
      knownUnappliedPresets: unknown[];
    };
    expect(parsed.tier).toBeNull();
    expect(parsed.activePresets).toEqual([]);
    expect(parsed.knownUnappliedPresets.length).toBeGreaterThan(0);
  });
});
