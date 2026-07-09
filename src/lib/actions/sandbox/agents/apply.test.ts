// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAgentsApplyDiff,
  buildOpenclawAgentAddArgs,
  buildOpenclawAgentDeleteArgs,
  computeAgentsApplyDiff,
  parseOpenClawAgentsList,
  runAgentsApply,
  validateAgentsManifestForApply,
} from "./apply";

let tmpDir: string;

function manifestFile(name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agents-apply-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("computeAgentsApplyDiff", () => {
  it("adds manifest agents that are not currently in the sandbox", () => {
    const result = computeAgentsApplyDiff(
      [{ id: "main" }],
      [
        { id: "research", workspace: "/sandbox/.openclaw/workspace-research" },
        { id: "writer", workspace: "/sandbox/.openclaw/workspace-writer" },
      ],
    );
    expect(result.toAdd).toEqual([
      { id: "research", workspace: "/sandbox/.openclaw/workspace-research", agentDir: undefined },
      { id: "writer", workspace: "/sandbox/.openclaw/workspace-writer", agentDir: undefined },
    ]);
    expect(result.toDelete).toEqual([]);
  });

  it("deletes secondary agents that are missing from the manifest", () => {
    const result = computeAgentsApplyDiff(
      [{ id: "main" }, { id: "research" }, { id: "obsolete" }],
      [{ id: "research" }],
    );
    expect(result.toAdd).toEqual([]);
    expect(result.toDelete).toEqual(["obsolete"]);
  });

  it("never deletes the canonical main agent even when missing from the manifest", () => {
    const result = computeAgentsApplyDiff([{ id: "main" }], []);
    expect(result.toDelete).toEqual([]);
  });

  it("ignores the manifest entry whose id is 'main'", () => {
    const result = computeAgentsApplyDiff([{ id: "main" }], [{ id: "main" }, { id: "alpha" }]);
    expect(result.toAdd).toEqual([{ id: "alpha", workspace: undefined, agentDir: undefined }]);
  });
});

describe("buildAgentsApplyDiff", () => {
  it("surfaces rebuild-only fields when the manifest declares any", () => {
    const diff = buildAgentsApplyDiff([{ id: "main" }, { id: "alpha" }], {
      agents: [
        { id: "alpha", model: "test/secondary" },
        { id: "beta", subagents: { allowAgents: ["alpha"] } },
      ],
      defaults: { subagents: { maxSpawnDepth: 3 } },
      main: { subagents: { allowAgents: ["alpha"] } },
    });
    expect(diff.toAdd.map((entry) => entry.id)).toEqual(["beta"]);
    expect(diff.toDelete).toEqual([]);
    expect(diff.rebuildOnlyFields.sort()).toEqual(
      ["agents[alpha].model", "agents[beta].subagents", "defaults", "main"].sort(),
    );
  });

  it("treats per-agent tools as rebuild-only so a live add cannot drop a tool policy", () => {
    const diff = buildAgentsApplyDiff([{ id: "main" }], {
      agents: [
        { id: "alpha", tools: { allow: ["read"] } },
        { id: "beta", tools: { allow: [], deny: ["write"] } },
        { id: "gamma", tools: {} },
        { id: "delta", tools: [] },
      ],
    });
    expect(diff.toAdd.map((entry) => entry.id)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(diff.rebuildOnlyFields.sort()).toEqual(
      ["agents[alpha].tools", "agents[beta].tools"].sort(),
    );
  });
});

describe("parseOpenClawAgentsList", () => {
  it("parses the bare array returned by current OpenClaw", () => {
    expect(
      parseOpenClawAgentsList(
        JSON.stringify([{ id: "main" }, { id: "alpha" }, { name: "missing-id" }]),
      ),
    ).toEqual([{ id: "main" }, { id: "alpha" }]);
  });

  it("accepts an object wrapper with an agents array", () => {
    expect(parseOpenClawAgentsList(JSON.stringify({ agents: [{ id: "main" }] }))).toEqual([
      { id: "main" },
    ]);
  });

  it("strips leading warning text before the JSON payload", () => {
    expect(
      parseOpenClawAgentsList(
        [
          "[plugins] warning: deprecated config key ignored",
          "OpenClaw warning: falling back to default workspace",
          JSON.stringify([{ id: "main" }, { id: "logs-reader" }]),
        ].join("\n"),
      ),
    ).toEqual([{ id: "main" }, { id: "logs-reader" }]);
  });
});

describe("validateAgentsManifestForApply", () => {
  it("rejects ids that do not match the AGENT_ID regex", () => {
    for (const id of [
      "--help",
      "-h",
      "Alpha",
      "ALPHA",
      "1leading",
      "alpha space",
      "../escape",
      "alpha/sub",
      "a".repeat(33),
    ]) {
      expect(() =>
        validateAgentsManifestForApply([
          {
            id,
            workspace: `/sandbox/.openclaw/workspace-${id}`,
            agentDir: `/sandbox/.openclaw/agents/${id}`,
          },
        ]),
      ).toThrow(/must match/);
    }
  });

  it("rejects the reserved `main` id", () => {
    expect(() =>
      validateAgentsManifestForApply([
        {
          id: "main",
          workspace: "/sandbox/.openclaw/workspace-main",
          agentDir: "/sandbox/.openclaw/agents/main",
        },
      ]),
    ).toThrow(/reserved for the primary agent/);
  });

  it("rejects duplicate ids in the manifest", () => {
    expect(() =>
      validateAgentsManifestForApply([
        {
          id: "alpha",
          workspace: "/sandbox/.openclaw/workspace-alpha",
          agentDir: "/sandbox/.openclaw/agents/alpha",
        },
        {
          id: "alpha",
          workspace: "/sandbox/.openclaw/workspace-alpha",
          agentDir: "/sandbox/.openclaw/agents/alpha",
        },
      ]),
    ).toThrow(/duplicated/);
  });

  it("rejects non-canonical workspace paths", () => {
    expect(() =>
      validateAgentsManifestForApply([
        {
          id: "alpha",
          workspace: "/sandbox/.openclaw/openclaw.json",
          agentDir: "/sandbox/.openclaw/agents/alpha",
        },
      ]),
    ).toThrow(/workspace must equal/);
  });

  it("rejects non-canonical agentDir paths", () => {
    expect(() =>
      validateAgentsManifestForApply([
        {
          id: "alpha",
          workspace: "/sandbox/.openclaw/workspace-alpha",
          agentDir: "/etc/passwd",
        },
      ]),
    ).toThrow(/agentDir must equal/);
  });

  it("rejects entries with unsupported top-level keys", () => {
    expect(() =>
      validateAgentsManifestForApply([
        {
          id: "alpha",
          workspace: "/sandbox/.openclaw/workspace-alpha",
          agentDir: "/sandbox/.openclaw/agents/alpha",
          env: { LEAK: "1" },
        },
      ]),
    ).toThrow(/unsupported field "env"/);
  });

  it("accepts valid entries with the allowed key set", () => {
    expect(() =>
      validateAgentsManifestForApply([
        {
          id: "alpha",
          workspace: "/sandbox/.openclaw/workspace-alpha",
          agentDir: "/sandbox/.openclaw/agents/alpha",
          description: "research bot",
          model: "test-provider/secondary",
          tools: { allow: ["read"] },
          subagents: { allowAgents: ["beta"] },
        },
      ]),
    ).not.toThrow();
  });
});

describe("runAgentsApply", () => {
  it("invokes add for missing manifest agents and delete for orphans", async () => {
    const manifestPath = manifestFile(
      "roster.yaml",
      [
        "agents:",
        "  - id: alpha",
        "    tools:",
        "      allow: [read]",
        "  - id: bravo",
        "    tools:",
        "      allow: [read]",
        "",
      ].join("\n"),
    );
    const log = vi.fn();
    const ensureLive = vi.fn(async () => undefined);
    const listAgents = vi.fn(() => [{ id: "main" }, { id: "obsolete" }]);
    const addAgent = vi.fn();
    const deleteAgent = vi.fn();
    await runAgentsApply(
      { sandboxName: "my-assistant", manifestPath, yes: true },
      { ensureLive, listAgents, addAgent, deleteAgent, log },
    );
    expect(ensureLive).toHaveBeenCalledWith("my-assistant", { allowNonReadyPhase: false });
    expect(deleteAgent.mock.calls).toEqual([["my-assistant", "obsolete"]]);
    expect(addAgent.mock.calls.map(([, id]) => id)).toEqual(["alpha", "bravo"]);
  });

  it("prints rebuild-only fields without applying them", async () => {
    const manifestPath = manifestFile(
      "rebuild-only.yaml",
      [
        "defaults:",
        "  subagents:",
        "    maxSpawnDepth: 3",
        "agents:",
        "  - id: alpha",
        "    model: test-provider/alpha",
        "    tools:",
        "      allow: [read]",
        "",
      ].join("\n"),
    );
    const messages: string[] = [];
    const addAgent = vi.fn();
    const deleteAgent = vi.fn();
    await runAgentsApply(
      { sandboxName: "my-assistant", manifestPath, yes: true },
      {
        ensureLive: async () => undefined,
        listAgents: () => [{ id: "main" }, { id: "alpha" }],
        addAgent,
        deleteAgent,
        log: (message) => messages.push(message),
      },
    );
    expect(messages.some((line) => line.includes("agents[alpha].model"))).toBe(true);
    expect(messages.some((line) => line.includes("defaults"))).toBe(true);
    expect(messages.some((line) => line.includes("--recreate-sandbox"))).toBe(true);
    expect(addAgent).not.toHaveBeenCalled();
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  it("refuses to apply roster changes without --yes in non-interactive mode", async () => {
    const manifestPath = manifestFile(
      "roster.yaml",
      ["agents:", "  - id: alpha", "    tools:", "      allow: [read]", ""].join("\n"),
    );
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    const addAgent = vi.fn();
    await expect(
      runAgentsApply(
        { sandboxName: "my-assistant", manifestPath, nonInteractive: true },
        {
          ensureLive: async () => undefined,
          listAgents: () => [{ id: "main" }],
          addAgent,
          deleteAgent: vi.fn(),
          log: () => {},
          exit: exit as unknown as (code: number) => never,
        },
      ),
    ).rejects.toThrow("exit:1");
    expect(addAgent).not.toHaveBeenCalled();
  });

  it("warns before adding a manifest agent that declares a tools policy", async () => {
    const manifestPath = manifestFile(
      "tools.yaml",
      ["agents:", "  - id: alpha", "    tools:", "      allow: [read]", "  - id: bravo", ""].join(
        "\n",
      ),
    );
    const messages: string[] = [];
    const addAgent = vi.fn();
    const deleteAgent = vi.fn();
    await runAgentsApply(
      { sandboxName: "my-assistant", manifestPath, yes: true },
      {
        ensureLive: async () => undefined,
        listAgents: () => [{ id: "main" }],
        addAgent,
        deleteAgent,
        log: (message) => messages.push(message),
      },
    );
    expect(messages.some((line) => line.includes("agents[alpha].tools"))).toBe(true);
    const warningIndex = messages.findIndex((line) =>
      line.includes('Manifest declares tools for "alpha"'),
    );
    const addIndex = messages.findIndex((line) => line === "  Adding agent: alpha");
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(addIndex).toBeGreaterThan(warningIndex);
    expect(messages.some((line) => line.includes('Manifest declares tools for "bravo"'))).toBe(
      false,
    );
    expect(addAgent.mock.calls.map(([, id]) => id)).toEqual(["alpha", "bravo"]);
  });

  it("refuses to mutate a sandbox when the manifest fails id/workspace validation", async () => {
    const manifestPath = manifestFile(
      "bad-id.yaml",
      [
        "agents:",
        '  - id: "--help"',
        "    workspace: /sandbox/.openclaw/workspace---help",
        "    agentDir: /sandbox/.openclaw/agents/--help",
        "",
      ].join("\n"),
    );
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    const messages: string[] = [];
    const addAgent = vi.fn();
    const deleteAgent = vi.fn();
    await expect(
      runAgentsApply(
        { sandboxName: "my-assistant", manifestPath, yes: true },
        {
          ensureLive: async () => undefined,
          listAgents: () => [{ id: "main" }],
          addAgent,
          deleteAgent,
          log: (message) => messages.push(message),
          exit: exit as unknown as (code: number) => never,
        },
      ),
    ).rejects.toThrow("exit:1");
    expect(addAgent).not.toHaveBeenCalled();
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(messages.some((line) => line.includes("Manifest rejected before mutation"))).toBe(true);
  });

  it("refuses to apply against a non-OpenClaw sandbox", async () => {
    const manifestPath = manifestFile(
      "hermes.yaml",
      ["agents:", "  - id: alpha", "    tools:", "      allow: [read]", ""].join("\n"),
    );
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    const messages: string[] = [];
    const addAgent = vi.fn();
    const deleteAgent = vi.fn();
    const listAgents = vi.fn();
    await expect(
      runAgentsApply(
        { sandboxName: "hermes-sandbox", manifestPath, yes: true },
        {
          ensureLive: async () => undefined,
          getSandboxAgent: () => "hermes",
          listAgents,
          addAgent,
          deleteAgent,
          log: (message) => messages.push(message),
          exit: exit as unknown as (code: number) => never,
        },
      ),
    ).rejects.toThrow("exit:1");
    expect(listAgents).not.toHaveBeenCalled();
    expect(addAgent).not.toHaveBeenCalled();
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(messages.some((line) => line.includes("OpenClaw-specific"))).toBe(true);
  });

  it("returns cleanly when the roster already matches the manifest", async () => {
    const manifestPath = manifestFile(
      "match.yaml",
      ["agents:", "  - id: alpha", "    tools:", "      allow: [read]", ""].join("\n"),
    );
    const messages: string[] = [];
    const addAgent = vi.fn();
    const deleteAgent = vi.fn();
    await runAgentsApply(
      { sandboxName: "my-assistant", manifestPath },
      {
        ensureLive: async () => undefined,
        listAgents: () => [{ id: "main" }, { id: "alpha" }],
        addAgent,
        deleteAgent,
        log: (message) => messages.push(message),
      },
    );
    expect(addAgent).not.toHaveBeenCalled();
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(messages.some((line) => /No roster changes to apply/.test(line))).toBe(true);
  });
});

describe("openclaw agents argv (#5656)", () => {
  it("delete uses --force and never --non-interactive (rejected by openclaw agents delete)", () => {
    const args = buildOpenclawAgentDeleteArgs("logs-reader");
    expect(args).toEqual(["openclaw", "agents", "delete", "logs-reader", "--force"]);
    expect(args).not.toContain("--non-interactive");
  });

  it("add still passes --non-interactive (accepted by openclaw agents add) and optional --workspace", () => {
    expect(buildOpenclawAgentAddArgs("logs-reader")).toEqual([
      "openclaw",
      "agents",
      "add",
      "logs-reader",
      "--non-interactive",
    ]);
    expect(
      buildOpenclawAgentAddArgs("logs-reader", "/sandbox/.openclaw/workspace-logs-reader"),
    ).toEqual([
      "openclaw",
      "agents",
      "add",
      "logs-reader",
      "--non-interactive",
      "--workspace",
      "/sandbox/.openclaw/workspace-logs-reader",
    ]);
  });
});
