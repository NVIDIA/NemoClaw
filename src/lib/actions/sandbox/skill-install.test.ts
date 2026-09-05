// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureSandboxSshConfig = vi.hoisted(() => vi.fn());
const fingerprintOpenShellSandboxSshConfigTarget = vi.hoisted(() => vi.fn());
const fingerprintOpenShellSandboxSshTarget = vi.hoisted(() => vi.fn());
const inspectOpenShellSandboxIdentityFingerprint = vi.hoisted(() => vi.fn());
const getSessionAgent = vi.hoisted(() => vi.fn());
const ensureLiveSandboxOrExit = vi.hoisted(() => vi.fn());
const getSandboxTargetGatewayName = vi.hoisted(() => vi.fn());
const execSandbox = vi.hoisted(() => vi.fn());
const mutationLockState = vi.hoisted(() => ({ active: false }));
const withSandboxMutationLock = vi.hoisted(() =>
  vi.fn(async (_sandboxName: string, operation: () => unknown) => {
    mutationLockState.active = true;
    try {
      return await operation();
    } finally {
      mutationLockState.active = false;
    }
  }),
);
const skillInstall = vi.hoisted(() => ({
  bindNativeSkillCommandToSandboxIdentity: vi.fn(),
  validateSkillName: vi.fn(),
  resolveNativeSkillState: vi.fn(),
  parseFrontmatter: vi.fn(),
  collectFiles: vi.fn(),
  installNativeAgentSkill: vi.fn(),
  installOpenClawSkill: vi.fn(),
  probeOpenClawSkillRemoveCapability: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureSandboxSshConfig,
}));

vi.mock("../../adapters/openshell/sandbox-identity", () => ({
  fingerprintOpenShellSandboxSshConfigTarget,
  fingerprintOpenShellSandboxSshTarget,
}));

vi.mock("../../adapters/openshell/sandbox-identity-cli", () => ({
  inspectOpenShellSandboxIdentityFingerprint,
}));

vi.mock("../../agent/runtime", () => ({
  getSessionAgent,
}));

vi.mock("../../skill-install", () => skillInstall);

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withSandboxMutationLock,
}));

vi.mock("./gateway-state", () => ({
  ensureLiveSandboxOrExit,
}));

vi.mock("./gateway-target", () => ({
  getSandboxTargetGatewayName,
}));

vi.mock("./exec", () => ({ execSandbox }));

import { installSandboxSkill, listSandboxSkills, removeSandboxSkill } from "./skill-install";

const paths = {
  stateDir: "/sandbox/.openclaw",
  isOpenClaw: true,
};

const agent = { name: "openclaw", configPaths: { dir: "/sandbox/.openclaw" } };
const genericAgent = { name: "hermes", configPaths: { dir: "/sandbox/.hermes" } };
const genericPaths = {
  stateDir: "/sandbox/.hermes",
  isOpenClaw: false,
};
const deepAgent = {
  name: "langchain-deepagents-code",
  configPaths: { dir: "/sandbox/.deepagents" },
};
const unsupportedAgent = { name: "pi", configPaths: { dir: "/sandbox/.pi/agent" } };
const sharedPaths = {
  stateDir: "/sandbox/.deepagents",
  isOpenClaw: false,
};

function makeSkillDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-action-skill-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: demo-skill\n---\n# Demo\n");
  return dir;
}

function restoreExitCode(previousExitCode: typeof process.exitCode): void {
  process.exitCode = previousExitCode;
}

function expectTempSshConfigCleanedUp(configFile: string): void {
  const configDir = path.dirname(configFile);
  expect(configDir).not.toBe(os.tmpdir());
  expect(path.basename(configDir)).toMatch(/^nemoclaw-ssh-skill-/);
  expect(path.basename(configFile)).toBe("ssh_config");
  expect(fs.existsSync(configDir)).toBe(false);
}

describe("sandbox skill action orchestration", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
    mutationLockState.active = false;

    captureSandboxSshConfig.mockReturnValue({ status: 0, output: "Host openshell-alpha\n" });
    fingerprintOpenShellSandboxSshConfigTarget.mockReturnValue("t".repeat(64));
    fingerprintOpenShellSandboxSshTarget.mockReturnValue("t".repeat(64));
    inspectOpenShellSandboxIdentityFingerprint.mockReturnValue("f".repeat(64));
    ensureLiveSandboxOrExit.mockResolvedValue(undefined);
    getSandboxTargetGatewayName.mockReturnValue("nemoclaw");
    getSessionAgent.mockReturnValue(genericAgent);
    skillInstall.validateSkillName.mockReturnValue(true);
    skillInstall.bindNativeSkillCommandToSandboxIdentity.mockReturnValue([
      "/bin/sh",
      "-c",
      "identity-bound-native-skill-command",
    ]);
    skillInstall.resolveNativeSkillState.mockReturnValue(genericPaths);
    skillInstall.parseFrontmatter.mockReturnValue({ name: "demo-skill" });
    skillInstall.probeOpenClawSkillRemoveCapability.mockReturnValue(true);
    skillInstall.collectFiles.mockReturnValue({
      files: ["SKILL.md"],
      skippedDotfiles: [],
      unsafePaths: [],
      unsupportedPaths: [],
    });
    skillInstall.installOpenClawSkill.mockReturnValue({
      success: true,
      uploaded: 1,
      contentDigest: "a".repeat(64),
    });
    skillInstall.installNativeAgentSkill.mockReturnValue({
      success: true,
      uploaded: 1,
      contentDigest: "a".repeat(64),
    });
  });

  afterEach(() => {
    restoreExitCode(previousExitCode);
    vi.restoreAllMocks();
  });

  it("delegates OpenClaw removal to the native agent command", async () => {
    getSessionAgent.mockReturnValue(agent);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(withSandboxMutationLock).toHaveBeenCalledWith("alpha", expect.any(Function));
    expect(execSandbox).toHaveBeenCalledWith(
      "alpha",
      ["/bin/sh", "-c", "identity-bound-native-skill-command"],
      { timeoutSeconds: 120 },
      { exit: expect.any(Function) },
    );
    expect(skillInstall.bindNativeSkillCommandToSandboxIdentity).toHaveBeenCalledWith(
      ["/usr/local/bin/openclaw", "skills", "remove", "demo-skill", "--agent", "main"],
      "f".repeat(64),
      {
        diagnostic: expect.stringContaining(
          "Native OpenClaw skill removal timed out in sandbox 'alpha' while running '/usr/local/bin/openclaw skills remove'",
        ),
        seconds: 110,
      },
    );
  });

  it.each([
    [genericAgent, ["/usr/local/bin/hermes", "skills", "uninstall", "demo-skill", "--yes"]],
    [
      deepAgent,
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
  ])("delegates %s removal to native agent state", async (selectedAgent, command) => {
    getSessionAgent.mockReturnValue(selectedAgent);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(skillInstall.bindNativeSkillCommandToSandboxIdentity).toHaveBeenCalledWith(
      command,
      "f".repeat(64),
      {
        diagnostic: expect.stringContaining("skill removal timed out in sandbox 'alpha'"),
        seconds: 110,
      },
    );
    expect(execSandbox).toHaveBeenCalledWith(
      "alpha",
      ["/bin/sh", "-c", "identity-bound-native-skill-command"],
      { timeoutSeconds: 120 },
      { exit: expect.any(Function) },
    );
  });

  it("refuses native removal when the live sandbox identity changes before execution", async () => {
    getSessionAgent.mockReturnValue(agent);
    inspectOpenShellSandboxIdentityFingerprint
      .mockReturnValueOnce("f".repeat(64))
      .mockReturnValueOnce("e".repeat(64));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "  Failed to bind the OpenClaw skill removal to the exact live sandbox identity.",
    );
    expect(execSandbox).not.toHaveBeenCalled();
  });

  it("requires rebuild when a running OpenClaw image lacks native removal", async () => {
    getSessionAgent.mockReturnValue(agent);
    skillInstall.probeOpenClawSkillRemoveCapability.mockReturnValue(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "  This OpenClaw sandbox image does not expose native skill removal. Rebuild it with 'nemoclaw alpha rebuild' and retry; rebuild preserves both workspace and legacy global skill directories.",
    );
    expect(execSandbox).not.toHaveBeenCalled();
  });

  it("refuses removal when the selected agent has no native skill state", async () => {
    getSessionAgent.mockReturnValue(unsupportedAgent);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("  Agent 'pi' has no native skill remove command.");
    expect(execSandbox).not.toHaveBeenCalled();
  });

  it("lists OpenClaw skills from native agent state", async () => {
    getSessionAgent.mockReturnValue(agent);

    await listSandboxSkills("alpha", { extraArgs: ["--json", "--eligible"] });

    expect(execSandbox).toHaveBeenCalledWith("alpha", [
      "/usr/local/bin/openclaw",
      "skills",
      "list",
      "--agent",
      "main",
      "--json",
      "--eligible",
    ]);
  });

  it.each([
    [genericAgent, ["/usr/local/bin/hermes", "skills", "list", "--enabled-only"]],
    [deepAgent, ["/usr/local/bin/dcode", "skills", "list", "--agent", "agent", "--json"]],
  ])("lists skills through %s native state", async (selectedAgent, command) => {
    getSessionAgent.mockReturnValue(selectedAgent);
    const extraArgs = selectedAgent.name === "hermes" ? ["--enabled-only"] : ["--json"];

    await listSandboxSkills("alpha", { extraArgs });

    expect(execSandbox).toHaveBeenCalledWith("alpha", command);
  });

  it("does not let forwarded list arguments change the selected native agent", async () => {
    getSessionAgent.mockReturnValue(agent);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await listSandboxSkills("alpha", { extraArgs: ["--agent", "other"] });

    expect(process.exitCode).toBe(2);
    expect(error).toHaveBeenCalledWith("  `skill list` is bound to the sandbox's primary agent.");
    expect(ensureLiveSandboxOrExit).toHaveBeenCalledWith("alpha");
    expect(execSandbox).not.toHaveBeenCalled();
  });

  it("refuses listing when the selected agent has no native skill state", async () => {
    getSessionAgent.mockReturnValue(unsupportedAgent);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await listSandboxSkills("alpha");

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("  Agent 'pi' has no native skill list command.");
    expect(execSandbox).not.toHaveBeenCalled();
  });

  it("stops skill installation at the shared gateway liveness guard (#2276)", async () => {
    const skillDir = makeSkillDir();
    ensureLiveSandboxOrExit.mockRejectedValueOnce(new Error("wrong gateway active"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(
        installSandboxSkill("alpha", { command: "install", path: skillDir }),
      ).rejects.toThrow("wrong gateway active");
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(ensureLiveSandboxOrExit).toHaveBeenCalledWith("alpha");
    expect(captureSandboxSshConfig).not.toHaveBeenCalled();
  });

  it("refuses installation when the selected agent has no native skill state", async () => {
    const skillDir = makeSkillDir();
    getSessionAgent.mockReturnValue(unsupportedAgent);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("  Agent 'pi' has no native local skill import command.");
    expect(skillInstall.resolveNativeSkillState).not.toHaveBeenCalled();
    expect(captureSandboxSshConfig).not.toHaveBeenCalled();
  });

  it("refuses a SKILL.md symlink before parsing or contacting the sandbox", async () => {
    const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-action-skill-link-"));
    const target = path.join(skillDir, "target.md");
    fs.writeFileSync(target, "---\nname: demo-skill\n---\n# Demo\n");
    fs.symlinkSync(target, path.join(skillDir, "SKILL.md"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    try {
      await expect(
        installSandboxSkill("alpha", { command: "install", path: skillDir }),
      ).rejects.toThrow("process.exit 1");
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(error).toHaveBeenCalledWith(expect.stringContaining("must be a regular file"));
    expect(skillInstall.parseFrontmatter).not.toHaveBeenCalled();
    expect(captureSandboxSshConfig).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("fails closed when SKILL.md is replaced between path validation and descriptor open", async () => {
    const skillDir = makeSkillDir();
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const replacement = path.join(skillDir, "replacement.md");
    fs.writeFileSync(replacement, "---\nname: attacker\n---\n# Replacement\n");
    let openedFlags = 0;
    vi.spyOn(fs, "openSync").mockImplementationOnce((_candidatePath, flags) => {
      openedFlags = flags as number;
      fs.rmSync(skillMdPath);
      fs.symlinkSync(replacement, skillMdPath);
      throw Object.assign(new Error("symbolic link refused"), { code: "ELOOP" });
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    try {
      await expect(
        installSandboxSkill("alpha", { command: "install", path: skillDir }),
      ).rejects.toThrow("process.exit 1");
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(openedFlags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(openedFlags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("must be a regular file"));
    expect(skillInstall.parseFrontmatter).not.toHaveBeenCalled();
    expect(captureSandboxSshConfig).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("delegates OpenClaw installation through the lifecycle mutation lock", async () => {
    const skillDir = makeSkillDir();
    getSessionAgent.mockReturnValue(agent);
    skillInstall.resolveNativeSkillState.mockReturnValue(paths);
    getSandboxTargetGatewayName.mockImplementationOnce(() => {
      expect(mutationLockState.active).toBe(true);
      return "nemoclaw-recorded";
    });
    captureSandboxSshConfig.mockImplementationOnce((_sandboxName, options) => {
      expect(mutationLockState.active).toBe(true);
      expect(options).toMatchObject({ gatewayName: "nemoclaw-recorded" });
      return { status: 0, output: "Host openshell-alpha\n" };
    });
    fingerprintOpenShellSandboxSshConfigTarget.mockImplementationOnce(() => {
      expect(mutationLockState.active).toBe(true);
      return "t".repeat(64);
    });
    inspectOpenShellSandboxIdentityFingerprint.mockImplementationOnce((request) => {
      expect(mutationLockState.active).toBe(true);
      expect(request.gatewayName).toBe("nemoclaw-recorded");
      return "f".repeat(64);
    });
    skillInstall.installOpenClawSkill.mockImplementationOnce(() => {
      expect(mutationLockState.active).toBe(true);
      return { success: true, uploaded: 1, contentDigest: "a".repeat(64) };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(withSandboxMutationLock).toHaveBeenCalledWith("alpha", expect.any(Function));
    expect(skillInstall.installOpenClawSkill).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "alpha" }),
      skillDir,
      paths,
      "demo-skill",
      expect.objectContaining({
        expectedRootIdentity: expect.any(Object),
        expectedSandboxIdentityFingerprint: "f".repeat(64),
      }),
    );
    expect(inspectOpenShellSandboxIdentityFingerprint).toHaveBeenCalledWith({
      sandboxName: "alpha",
      gatewayName: "nemoclaw-recorded",
      timeoutMs: expect.any(Number),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("installed through OpenClaw"));
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses OpenClaw installation when the SSH target differs from the selected sandbox", async () => {
    const skillDir = makeSkillDir();
    getSessionAgent.mockReturnValue(agent);
    skillInstall.resolveNativeSkillState.mockReturnValue(paths);
    fingerprintOpenShellSandboxSshConfigTarget.mockReturnValueOnce("a".repeat(64));
    fingerprintOpenShellSandboxSshTarget.mockReturnValueOnce("b".repeat(64));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "  Failed to bind the OpenClaw skill install to the exact live sandbox identity.",
    );
    expect(withSandboxMutationLock).toHaveBeenCalledWith("alpha", expect.any(Function));
    expect(inspectOpenShellSandboxIdentityFingerprint).not.toHaveBeenCalled();
    expect(skillInstall.installOpenClawSkill).not.toHaveBeenCalled();
  });

  it("refuses OpenClaw installation when the exact sandbox identity is unavailable", async () => {
    const skillDir = makeSkillDir();
    getSessionAgent.mockReturnValue(agent);
    skillInstall.resolveNativeSkillState.mockReturnValue(paths);
    inspectOpenShellSandboxIdentityFingerprint.mockImplementationOnce(() => {
      throw new Error("identity unavailable");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "  Failed to bind the OpenClaw skill install to the exact live sandbox identity.",
    );
    expect(withSandboxMutationLock).toHaveBeenCalledWith("alpha", expect.any(Function));
    expect(skillInstall.installOpenClawSkill).not.toHaveBeenCalled();
  });

  it("fails closed when the pinned OpenClaw installer capability is unavailable", async () => {
    const skillDir = makeSkillDir();
    getSessionAgent.mockReturnValue(agent);
    skillInstall.resolveNativeSkillState.mockReturnValue(paths);
    skillInstall.installOpenClawSkill.mockReturnValue({
      success: false,
      uploaded: 0,
      reason: "native_capability_missing",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "  The pinned OpenClaw runtime does not expose the reviewed native skill install capability.",
    );
    expect(error).toHaveBeenCalledWith(
      "  Rebuild with 'nemoclaw alpha rebuild' and retry; rebuild preserves both workspace and legacy global skill directories.",
    );
  });

  it("reports the supported OpenClaw primary workspace boundary", async () => {
    const skillDir = makeSkillDir();
    getSessionAgent.mockReturnValue(agent);
    skillInstall.resolveNativeSkillState.mockReturnValue(paths);
    skillInstall.installOpenClawSkill.mockReturnValue({
      success: false,
      uploaded: 0,
      reason: "agent_workspace_unsupported",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("supports only the NemoClaw-managed primary 'main' agent"),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("no sandbox staging or publication occurred"),
    );
  });

  it("delegates Deep Agents installation to its native local import command", async () => {
    const skillDir = makeSkillDir();
    getSessionAgent.mockReturnValue(deepAgent);
    skillInstall.resolveNativeSkillState.mockReturnValue(sharedPaths);
    let tempConfig = "";
    skillInstall.installNativeAgentSkill.mockImplementation((ctx) => {
      tempConfig = ctx.configFile;
      return { success: true, uploaded: 1, contentDigest: "a".repeat(64) };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(skillInstall.installNativeAgentSkill).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: tempConfig, sandboxName: "alpha" }),
      skillDir,
      sharedPaths,
      "langchain-deepagents-code",
      "demo-skill",
      {
        expectedRootIdentity: {
          dev: expect.any(Number),
          ino: expect.any(Number),
        },
        expectedSandboxIdentityFingerprint: "f".repeat(64),
      },
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("installed through Deep Agents Code"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`Content digest (SHA-256): ${"a".repeat(64)}`),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Start a new Deep Agents Code session to load the skill."),
    );
    expectTempSshConfigCleanedUp(tempConfig);
    expect(process.exitCode).toBeUndefined();
  });

  it("reports a native Deep Agents import refusal without a host-side fallback", async () => {
    const skillDir = makeSkillDir();
    getSessionAgent.mockReturnValue(deepAgent);
    skillInstall.resolveNativeSkillState.mockReturnValue(sharedPaths);
    skillInstall.installNativeAgentSkill.mockReturnValue({
      success: false,
      uploaded: 0,
      reason: "native_install_failed",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("native skill import refused or failed"),
    );
  });

  it("reports unknown Deep Agents native state with list-before-retry guidance", async () => {
    const skillDir = makeSkillDir();
    getSessionAgent.mockReturnValue(deepAgent);
    skillInstall.resolveNativeSkillState.mockReturnValue(sharedPaths);
    skillInstall.installNativeAgentSkill.mockReturnValue({
      success: false,
      uploaded: 0,
      reason: "remote_state_unknown",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    const output = error.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).toContain("did not confirm whether the staged native skill import completed");
    expect(output).toContain("skill list' before retrying");
  });

  it("reports a Hermes native import failure and deletes the temporary SSH config", async () => {
    const skillDir = makeSkillDir();
    let tempConfig = "";
    skillInstall.installNativeAgentSkill.mockImplementation((ctx) => {
      tempConfig = ctx.configFile;
      return { success: false, uploaded: 0, reason: "native_install_failed" };
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    const output = error.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).toContain("Hermes native skill import refused or failed");
    expect(skillInstall.installNativeAgentSkill).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "alpha" }),
      skillDir,
      genericPaths,
      "hermes",
      "demo-skill",
      expect.objectContaining({ expectedRootIdentity: expect.any(Object) }),
    );
    expectTempSshConfigCleanedUp(tempConfig);
  });

  it("fails when native Hermes state verification fails and deletes the temp SSH config", async () => {
    const skillDir = makeSkillDir();
    let tempConfig = "";
    skillInstall.installNativeAgentSkill.mockImplementation((ctx) => {
      tempConfig = ctx.configFile;
      return { success: false, uploaded: 0, reason: "verification_failed" };
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Hermes imported the skill, but native state or digest verification failed",
      ),
    );
    expectTempSshConfigCleanedUp(tempConfig);
  });
});
