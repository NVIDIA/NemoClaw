// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveOnboardOptions, runOnboardCommand } from "./command";

function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("onboard --agents", () => {
  it("resolves an existing manifest to an absolute path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-agents-"));
    const manifestPath = path.join(tmpDir, "agents.yaml");
    fs.writeFileSync(manifestPath, "agents: []\n");
    const relativeManifestPath = path.relative(process.cwd(), manifestPath);

    const result = resolveOnboardOptions(
      { agents: relativeManifestPath },
      { env: {}, exit: exitWithCode },
    );
    expect(result.agentsManifest).toBe(path.resolve(relativeManifestPath));
  });

  it("rejects a missing manifest", () => {
    const errors: string[] = [];
    expect(() =>
      resolveOnboardOptions(
        { agents: "/nonexistent/agents.yaml" },
        {
          env: {},
          error: (message = "") => errors.push(message),
          exit: exitWithCode,
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--agents path not found");
  });

  it("rejects manifests for non-OpenClaw runtimes before mutating the environment", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-agents-hermes-"));
    const manifestPath = path.join(tmpDir, "agents.yaml");
    fs.writeFileSync(manifestPath, "agents: []\n");
    const errors: string[] = [];
    vi.stubEnv("NEMOCLAW_EXTRA_AGENTS_JSON", "unchanged");

    try {
      await expect(
        runOnboardCommand({
          flags: { agent: "hermes", agents: manifestPath },
          env: {},
          listAgents: () => ["openclaw", "hermes"],
          error: (message = "") => errors.push(message),
          exit: exitWithCode,
          runOnboard: vi.fn(),
        }),
      ).rejects.toThrow("exit:1");
      expect(errors.join("\n")).toContain("--agents is OpenClaw-specific");
      expect(process.env.NEMOCLAW_EXTRA_AGENTS_JSON).toBe("unchanged");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("applies the manifest environment before invoking onboard", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-agents-env-"));
    const manifestPath = path.join(tmpDir, "agents.yaml");
    fs.writeFileSync(
      manifestPath,
      ["agents:", "  - id: alpha", "    tools:", "      allow: [read]", ""].join("\n"),
    );
    const previous = process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
    delete process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
    const restoreEnvironment =
      previous === undefined
        ? () => delete process.env.NEMOCLAW_EXTRA_AGENTS_JSON
        : () => {
            process.env.NEMOCLAW_EXTRA_AGENTS_JSON = previous;
          };
    let observedRaw: string | undefined;
    const runOnboard = vi.fn(async () => {
      observedRaw = process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
    });
    try {
      await runOnboardCommand({
        flags: { agents: manifestPath },
        env: process.env,
        runOnboard,
        exit: exitWithCode,
      });
      expect(observedRaw).toBeDefined();
      const payload = JSON.parse(observedRaw as string);
      expect(payload.agents).toHaveLength(1);
      expect(payload.agents[0]).toMatchObject({
        id: "alpha",
        workspace: "/sandbox/.openclaw/workspace-alpha",
        agentDir: "/sandbox/.openclaw/agents/alpha",
      });
    } finally {
      restoreEnvironment();
    }
  });

  it.each([
    [
      "secondary-agent",
      ["agents:", "  - id: alpha", "    subagents:", "      maxSpawnDepth: 2", ""].join("\n"),
      "NEMOCLAW_EXTRA_AGENTS_JSON.agents[0].subagents.maxSpawnDepth",
    ],
    [
      "main-agent",
      ["main:", "  subagents:", "    maxSpawnDepth: 2", ""].join("\n"),
      "NEMOCLAW_EXTRA_AGENTS_JSON.main.subagents.maxSpawnDepth",
    ],
  ])("rejects %s maxSpawnDepth before invoking onboard", async (_label, manifest, message) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-agents-invalid-"));
    const manifestPath = path.join(tmpDir, "agents.yaml");
    fs.writeFileSync(manifestPath, manifest);
    const runOnboard = vi.fn();

    await expect(
      runOnboardCommand({
        flags: { agents: manifestPath },
        env: {},
        exit: exitWithCode,
        runOnboard,
      }),
    ).rejects.toThrow(`${message} is not accepted per-agent`);

    expect(runOnboard).not.toHaveBeenCalled();
  });

  it.each([
    [
      "secondary-agent",
      [{ id: "alpha", subagents: { maxSpawnDepth: 2 } }],
      "NEMOCLAW_EXTRA_AGENTS_JSON.agents[0].subagents.maxSpawnDepth",
    ],
    [
      "main-agent",
      { agents: [], main: { subagents: { maxSpawnDepth: 2 } } },
      "NEMOCLAW_EXTRA_AGENTS_JSON.main.subagents.maxSpawnDepth",
    ],
  ])("rejects raw %s maxSpawnDepth before invoking onboard", async (_label, payload, message) => {
    const runOnboard = vi.fn();

    await expect(
      runOnboardCommand({
        flags: {},
        env: {
          NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify(payload),
        },
        exit: exitWithCode,
        runOnboard,
      }),
    ).rejects.toThrow(`${message} is not accepted per-agent`);

    expect(runOnboard).not.toHaveBeenCalled();
  });

  it.each([
    ["--agent", "nemoclaw"],
    ["--agent", "nemo-claw"],
    ["NEMOCLAW_AGENT", "nemoclaw"],
    ["NEMOCLAW_AGENT", "nemo-claw"],
  ])("rejects raw maxSpawnDepth for the %s %s alias", async (source, agent) => {
    const runOnboard = vi.fn();
    const raw = JSON.stringify([{ id: "alpha", subagents: { maxSpawnDepth: 2 } }]);

    await expect(
      runOnboardCommand({
        flags: source === "--agent" ? { agent } : {},
        env:
          source === "NEMOCLAW_AGENT"
            ? { NEMOCLAW_AGENT: agent, NEMOCLAW_EXTRA_AGENTS_JSON: raw }
            : { NEMOCLAW_EXTRA_AGENTS_JSON: raw },
        listAgents: () => ["openclaw", "hermes"],
        exit: exitWithCode,
        runOnboard,
      }),
    ).rejects.toThrow(
      "NEMOCLAW_EXTRA_AGENTS_JSON.agents[0].subagents.maxSpawnDepth is not accepted per-agent",
    );

    expect(runOnboard).not.toHaveBeenCalled();
  });
});
