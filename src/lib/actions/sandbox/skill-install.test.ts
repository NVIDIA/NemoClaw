// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureOpenshell = vi.hoisted(() => vi.fn());
const runOpenshell = vi.hoisted(() => vi.fn());
const sdkCommandExecutor = vi.hoisted(() => ({
  runStreaming: vi.fn(),
}));
const ensureLiveSandboxOrExit = vi.hoisted(() => vi.fn());
const getSandboxTargetGatewayName = vi.hoisted(() => vi.fn());
const getSessionAgent = vi.hoisted(() => vi.fn());
const resolveSessionAgentDefinition = vi.hoisted(() => vi.fn());

vi.mock("../../adapters/openshell/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/runtime")>()),
  captureOpenshell,
  runOpenshell,
}));
vi.mock("../../adapters/openshell/sandbox-command-sdk", () => ({
  createSdkOpenShellSandboxCommandExecutor: () => sdkCommandExecutor,
}));
vi.mock("../../agent/runtime", () => ({ getSessionAgent, resolveSessionAgentDefinition }));
vi.mock("./gateway-state", () => ({ ensureLiveSandboxOrExit }));
vi.mock("./gateway-target", () => ({ getSandboxTargetGatewayName }));

import { installSandboxSkill, listSandboxSkills, removeSandboxSkill } from "./skill-install";
import type { AgentSkillIntegration } from "../../agent/skill-integration";

const roots: string[] = [];

function localSkill(name = "demo-skill"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-action-test-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "SKILL.md"), `---\nname: ${name}\n---\n# Demo\n`);
  return root;
}

function selectAgent(
  name: string,
  binary: string,
  integration: AgentSkillIntegration | null,
): void {
  resolveSessionAgentDefinition.mockReturnValue({
    resolved: true,
    requestedName: name,
    agent: {
      name,
      displayName: name,
      binary_path: binary,
      skillIntegration: integration,
    },
  });
}

const OPENCLAW: AgentSkillIntegration = {
  writableRoot: "/sandbox/.openclaw/workspace/skills",
  listCommand: ["skills", "list", "--agent", "main"],
  addCommand: ["skills", "install", "{source}", "--agent", "main", "--force"],
  removeCommand: null,
};
const HERMES: AgentSkillIntegration = {
  writableRoot: "/sandbox/.hermes/skills",
  listCommand: ["skills", "list"],
  addCommand: null,
  removeCommand: null,
};
const DCODE: AgentSkillIntegration = {
  writableRoot: "/sandbox/.deepagents/agent/skills",
  listCommand: ["skills", "list", "--agent", "agent"],
  addCommand: null,
  removeCommand: ["skills", "delete", "{name}", "--agent", "agent", "--force", "--json"],
};

describe("stateless sandbox skill orchestration", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
    captureOpenshell.mockReturnValue({ status: 0, output: "", stdout: "", stderr: "" });
    runOpenshell.mockReturnValue({ status: 0 });
    sdkCommandExecutor.runStreaming.mockResolvedValue({
      outcome: { kind: "completed", exitCode: 0 },
      release: vi.fn(),
    });
    ensureLiveSandboxOrExit.mockResolvedValue(undefined);
    getSandboxTargetGatewayName.mockReturnValue("nemoclaw");
    getSessionAgent.mockReturnValue(null);
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
  });

  it.each([
    [
      "openclaw",
      "/usr/local/bin/openclaw",
      OPENCLAW,
      ["/usr/local/bin/openclaw", "skills", "list", "--agent", "main", "--json"],
    ],
    [
      "hermes",
      "/usr/local/bin/hermes",
      HERMES,
      ["/usr/local/bin/hermes", "skills", "list", "--json"],
    ],
    [
      "langchain-deepagents-code",
      "/usr/local/bin/dcode",
      DCODE,
      ["/usr/local/bin/dcode", "skills", "list", "--agent", "agent", "--json"],
    ],
  ] as const)("streams %s native list output", async (name, binary, integration, command) => {
    selectAgent(name, binary, integration);

    await listSandboxSkills("alpha", { extraArgs: ["--json"] });

    const request = sdkCommandExecutor.runStreaming.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      sandboxName: "alpha",
      target: { kind: "named", gatewayName: "nemoclaw" },
      timeoutSeconds: 120,
    });
    expect(request.command.slice(-command.length)).toEqual(command);
    expect(captureOpenshell).not.toHaveBeenCalled();
  });

  it("forwards the native list exit status", async () => {
    selectAgent("hermes", "/usr/local/bin/hermes", HERMES);
    sdkCommandExecutor.runStreaming.mockResolvedValue({
      outcome: { kind: "completed", exitCode: 13 },
      release: vi.fn(),
    });

    await listSandboxSkills("alpha");

    expect(process.exitCode).toBe(13);
  });

  it("uses the existing CLI transport only when the SDK is unavailable", async () => {
    selectAgent("hermes", "/usr/local/bin/hermes", HERMES);
    sdkCommandExecutor.runStreaming.mockResolvedValue({
      outcome: { kind: "failed", error: { kind: "unavailable", message: "SDK unavailable" } },
      release: vi.fn(),
    });

    await listSandboxSkills("alpha");

    expect(runOpenshell).toHaveBeenCalledWith(
      expect.arrayContaining(["sandbox", "exec", "--name", "alpha", "-g", "nemoclaw"]),
      expect.objectContaining({ stdio: ["ignore", "inherit", "inherit"] }),
    );
    expect(process.exitCode).toBe(0);
  });

  it.each([["--"], ["--agent", "other"], ["--agent=other"]])(
    "rejects native list agent overrides %#",
    async (...extraArgs) => {
      selectAgent("hermes", "/usr/local/bin/hermes", HERMES);

      await listSandboxSkills("alpha", { extraArgs });

      expect(process.exitCode).toBe(2);
      expect(sdkCommandExecutor.runStreaming).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["openclaw", "/usr/local/bin/openclaw", OPENCLAW],
    ["hermes", "/usr/local/bin/hermes", HERMES],
  ] as const)(
    "uses only %s's canonical writable root when native remove is absent",
    async (name, binary, integration) => {
      selectAgent(name, binary, integration);

      await removeSandboxSkill("alpha", { name: "demo-skill" });

      const command = sdkCommandExecutor.runStreaming.mock.calls[0]?.[0].command as string[];
      const script = command.at(-1) ?? "";
      expect(command.slice(-3, -1)).toEqual(["/bin/sh", "-c"]);
      expect(script).toContain(integration.writableRoot);
      expect(script).toContain("Native skill list remains authoritative");
    },
  );

  it.each([
    [
      "langchain-deepagents-code",
      "/usr/local/bin/dcode",
      DCODE,
      [
        "/usr/local/bin/dcode",
        "skills",
        "delete",
        "demo-skill",
        "--agent",
        "agent",
        "--force",
        "--json",
      ],
    ],
  ] as const)("uses unmodified %s native remove", async (name, binary, integration, command) => {
    selectAgent(name, binary, integration);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    const request = sdkCommandExecutor.runStreaming.mock.calls[0]?.[0];
    expect(request.command.slice(-command.length)).toEqual(command);
  });

  it("adds through OpenClaw's unmodified native command", async () => {
    selectAgent("openclaw", "/usr/local/bin/openclaw", OPENCLAW);
    const source = localSkill();

    await installSandboxSkill("alpha", { command: "install", path: source });

    const upload = captureOpenshell.mock.calls.find((call) => call[0]?.[1] === "upload");
    expect(upload?.[0].slice(0, 5)).toEqual(["sandbox", "upload", "-g", "nemoclaw", "alpha"]);
    expect(fs.existsSync(path.dirname(upload?.[0]?.[5] as string))).toBe(false);
    const command = sdkCommandExecutor.runStreaming.mock.calls[1]?.[0].command as string[];
    expect(command.slice(-7, -4)).toEqual(["/usr/local/bin/openclaw", "skills", "install"]);
    expect(process.exitCode).toBe(0);
  });

  it.each([
    ["hermes", "/usr/local/bin/hermes", HERMES],
    ["langchain-deepagents-code", "/usr/local/bin/dcode", DCODE],
  ] as const)("adds through the stateless %s fallback", async (name, binary, integration) => {
    selectAgent(name, binary, integration);
    const source = localSkill();

    await installSandboxSkill("alpha", { command: "install", path: source });

    const command = sdkCommandExecutor.runStreaming.mock.calls[1]?.[0].command as string[];
    expect(command.slice(-3, -1)).toEqual(["/bin/sh", "-c"]);
    expect(command.at(-1)).toContain(integration.writableRoot);
    expect(JSON.stringify(captureOpenshell.mock.calls)).not.toMatch(
      /docker|podman|receipt|provenance/u,
    );
    expect(process.exitCode).toBe(0);
  });

  it("fails clearly when the selected agent declares no safe skill integration", async () => {
    selectAgent("pi", "/usr/local/bin/pi", null);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await listSandboxSkills("alpha");

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("  Agent 'pi' has no safe skill integration metadata.");
    expect(sdkCommandExecutor.runStreaming).not.toHaveBeenCalled();
  });
});
