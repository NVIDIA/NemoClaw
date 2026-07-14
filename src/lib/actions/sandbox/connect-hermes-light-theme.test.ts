// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";
import { NEMOCLAW_HERMES_LIGHT_SKIN_NAME } from "../../domain/sandbox/connect-env";

const REDACTED_URL_CANARY = "https://user:secret@example.test/hermes";

type ConnectHarness = ReturnType<typeof createConnectHarness>;

function connectCalls(harness: ConnectHarness, sandboxName = "alpha") {
  return harness.spawnSyncSpy.mock.calls.filter(
    ([command, args]) =>
      command === "openshell" &&
      Array.isArray(args) &&
      args.join(" ") === `sandbox connect ${sandboxName}`,
  );
}

function execScript(call: unknown[]): string {
  return String((call[1] as { input?: string } | undefined)?.input ?? "");
}

function skinWriteCalls(harness: ConnectHarness, sandboxName = "alpha") {
  return harness.runOpenshellSpy.mock.calls.filter(
    (call) =>
      Array.isArray(call[0]) &&
      call[0].join(" ") === `sandbox exec --name ${sandboxName} -- sh -s` &&
      execScript(call).includes('mv -f "$tmp" "$skin_dir/nemoclaw-light.yaml"'),
  );
}

function skinRemoveCalls(harness: ConnectHarness, sandboxName = "alpha") {
  return harness.runOpenshellSpy.mock.calls.filter(
    (call) =>
      Array.isArray(call[0]) &&
      call[0].join(" ") === `sandbox exec --name ${sandboxName} -- sh -s` &&
      execScript(call).includes('rm -f "$skin_dir/nemoclaw-light.yaml"'),
  );
}

function warningText(harness: ConnectHarness): string {
  return harness.errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

function expectConnectSucceeded(harness: ConnectHarness, exitSpy: MockInstance): void {
  expect(connectCalls(harness)).toHaveLength(1);
  expect(exitSpy).toHaveBeenCalledWith(0);
}

describe("Hermes sandbox connect light terminal skin", () => {
  let exitSpy: MockInstance;
  const originalStdoutIsTty = process.stdout.isTTY;

  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    vi.stubEnv("HERMES_TUI_LIGHT", "");
    vi.stubEnv("HERMES_TUI_THEME", "");
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutIsTty,
    });
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("prepares the NemoClaw Hermes light skin inside the sandbox on light macOS Terminal.app (#6380)", async () => {
    vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
    vi.stubEnv("COLORFGBG", "0;15");
    vi.stubEnv("HERMES_TUI_LIGHT", "");
    const harness = createConnectHarness({
      agentName: "hermes",
      hermesConfig: { model: "test" },
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.readSandboxConfigSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ agentName: "hermes" }),
    );
    const skinWriteCall = skinWriteCalls(harness)[0];
    expect(skinWriteCall).toBeDefined();
    expect(execScript(skinWriteCall ?? [])).not.toContain("config.yaml");
    expect(harness.writeSandboxConfigSpy).toHaveBeenCalledOnce();
    expect(harness.writeSandboxConfigSpy.mock.calls[0][2]).toMatchObject({
      display: { skin: NEMOCLAW_HERMES_LIGHT_SKIN_NAME },
    });

    const connectCall = connectCalls(harness)[0];
    expect(connectCall?.[2]).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({
          COLORFGBG: "0;15",
          TERM_PROGRAM: "Apple_Terminal",
        }),
      }),
    );
    expect(connectCall?.[2]?.env).not.toEqual(expect.objectContaining({ HERMES_TUI_LIGHT: "1" }));
    expectConnectSucceeded(harness, exitSpy);
  });

  it("does not prepare the NemoClaw Hermes light skin when the sandbox Hermes config already sets display.skin (#6380)", async () => {
    vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
    vi.stubEnv("COLORFGBG", "0;15");
    const harness = createConnectHarness({
      agentName: "hermes",
      hermesConfig: { display: { skin: "solarized-light" } },
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(skinWriteCalls(harness)).toHaveLength(0);
    expect(harness.writeSandboxConfigSpy).not.toHaveBeenCalled();
    expect(harness.readSandboxConfigSpy).toHaveBeenCalledOnce();
    expect(harness.errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Hermes light"));
    expectConnectSucceeded(harness, exitSpy);
  });

  it("removes NemoClaw-managed Hermes light skin state when reconnecting from a dark terminal (#6380)", async () => {
    vi.stubEnv("COLORFGBG", "0;0");
    const hermesConfig = {
      display: { skin: NEMOCLAW_HERMES_LIGHT_SKIN_NAME },
      model: "test",
    };
    const harness = createConnectHarness({
      agentName: "hermes",
      hermesConfig,
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.resolveAgentConfigSpy).toHaveBeenCalledOnce();
    expect(harness.readSandboxConfigSpy).toHaveBeenCalledOnce();
    expect(skinWriteCalls(harness)).toHaveLength(0);
    expect(skinRemoveCalls(harness)).toHaveLength(1);
    expect(harness.writeSandboxConfigSpy).toHaveBeenCalledOnce();
    expect(hermesConfig).toEqual({ model: "test" });
    expectConnectSucceeded(harness, exitSpy);
  });

  it("warns but continues when dark-terminal skin file cleanup fails (#6380)", async () => {
    vi.stubEnv("COLORFGBG", "0;0");
    const hermesConfig = {
      display: { skin: NEMOCLAW_HERMES_LIGHT_SKIN_NAME },
      model: "test",
    };
    const harness = createConnectHarness({
      agentName: "hermes",
      hermesConfig,
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });
    harness.runOpenshellSpy.mockImplementation((_args: unknown, opts: unknown) => {
      const script = String((opts as { input?: string } | undefined)?.input ?? "");
      return script.includes('rm -f "$skin_dir/nemoclaw-light.yaml"')
        ? { status: 2, error: new Error(`remove failed ${REDACTED_URL_CANARY}`) }
        : { status: 0 };
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(skinRemoveCalls(harness)).toHaveLength(1);
    expect(harness.writeSandboxConfigSpy).toHaveBeenCalledOnce();
    expect(warningText(harness)).toContain("Could not remove Hermes light terminal skin");
    expect(warningText(harness)).not.toContain("user:secret");
    expectConnectSucceeded(harness, exitSpy);
  });

  it("does not read or write Hermes config when a Hermes theme override is set (#6380)", async () => {
    vi.stubEnv("COLORFGBG", "0;15");
    vi.stubEnv("HERMES_TUI_THEME", "dark");
    const harness = createConnectHarness({
      agentName: "hermes",
      hermesConfig: { model: "test" },
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.resolveAgentConfigSpy).not.toHaveBeenCalled();
    expect(harness.readSandboxConfigSpy).not.toHaveBeenCalled();
    expect(skinWriteCalls(harness)).toHaveLength(0);
    expect(harness.writeSandboxConfigSpy).not.toHaveBeenCalled();
    expect(warningText(harness)).not.toContain("Could not");
    expectConnectSucceeded(harness, exitSpy);
  });

  it("targets only the requested Hermes sandbox when sibling sandboxes are registered (#6380)", async () => {
    vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
    vi.stubEnv("COLORFGBG", "0;15");
    const alphaConfig = { model: "alpha" };
    const betaConfig = { display: { skin: "beta-owned" }, model: "beta" };
    const harness = createConnectHarness({
      agentName: "hermes",
      registryEntries: [
        { name: "alpha", agent: "hermes" },
        { name: "beta", agent: "hermes" },
      ],
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });
    harness.readSandboxConfigSpy.mockImplementation((name: unknown) =>
      String(name) === "alpha" ? alphaConfig : betaConfig,
    );

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.resolveAgentConfigSpy.mock.calls.map(([name]) => String(name))).toEqual([
      "alpha",
    ]);
    expect(harness.readSandboxConfigSpy.mock.calls.map(([name]) => String(name))).toEqual([
      "alpha",
    ]);
    expect(harness.writeSandboxConfigSpy.mock.calls.map(([name]) => String(name))).toEqual([
      "alpha",
    ]);
    expect(skinWriteCalls(harness, "alpha")).toHaveLength(1);
    expect(skinWriteCalls(harness, "beta")).toHaveLength(0);
    expect(betaConfig).toEqual({
      display: { skin: "beta-owned" },
      model: "beta",
    });
    expect(connectCalls(harness, "beta")).toHaveLength(0);
    expectConnectSucceeded(harness, exitSpy);
  });

  it("continues connecting when Hermes config read fails during light-skin preparation (#6380)", async () => {
    vi.stubEnv("COLORFGBG", "0;15");
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });
    harness.readSandboxConfigSpy.mockImplementationOnce(() => {
      throw new Error(`read failed ${REDACTED_URL_CANARY}`);
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(skinWriteCalls(harness)).toHaveLength(0);
    expect(harness.writeSandboxConfigSpy).not.toHaveBeenCalled();
    expect(warningText(harness)).toContain("Could not read Hermes light terminal skin");
    expect(warningText(harness)).not.toContain("user:secret");
    expectConnectSucceeded(harness, exitSpy);
  });

  it("continues connecting when Hermes skin file write fails before config update (#6380)", async () => {
    vi.stubEnv("COLORFGBG", "0;15");
    const harness = createConnectHarness({
      agentName: "hermes",
      hermesConfig: { model: "test" },
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });
    harness.runOpenshellSpy.mockImplementation((args: unknown) =>
      Array.isArray(args) && args.slice(0, 6).join(" ") === "sandbox exec --name alpha -- sh"
        ? { status: 2, error: new Error(`write failed ${REDACTED_URL_CANARY}`) }
        : { status: 0 },
    );

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(skinWriteCalls(harness)).toHaveLength(1);
    expect(harness.writeSandboxConfigSpy).not.toHaveBeenCalled();
    expect(warningText(harness)).toContain("Could not write Hermes light terminal skin");
    expect(warningText(harness)).not.toContain("user:secret");
    expectConnectSucceeded(harness, exitSpy);
  });

  it("continues connecting when Hermes config update fails after skin write (#6380)", async () => {
    vi.stubEnv("COLORFGBG", "0;15");
    const harness = createConnectHarness({
      agentName: "hermes",
      hermesConfig: { model: "test" },
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });
    harness.writeSandboxConfigSpy.mockImplementationOnce(() => {
      throw new Error(`update failed ${REDACTED_URL_CANARY}`);
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(skinWriteCalls(harness)).toHaveLength(1);
    expect(skinRemoveCalls(harness)).toHaveLength(1);
    expect(harness.writeSandboxConfigSpy).toHaveBeenCalledOnce();
    expect(warningText(harness)).toContain("Could not update Hermes light terminal skin");
    expect(warningText(harness)).not.toContain("user:secret");
    expectConnectSucceeded(harness, exitSpy);
  });

  it("warns when rollback cleanup fails after Hermes config update failure (#6380)", async () => {
    vi.stubEnv("COLORFGBG", "0;15");
    const harness = createConnectHarness({
      agentName: "hermes",
      hermesConfig: { model: "test" },
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });
    harness.writeSandboxConfigSpy.mockImplementationOnce(() => {
      throw new Error(`update failed ${REDACTED_URL_CANARY}`);
    });
    harness.runOpenshellSpy.mockImplementation((_args: unknown, opts: unknown) => {
      const script = String((opts as { input?: string } | undefined)?.input ?? "");
      return script.includes('rm -f "$skin_dir/nemoclaw-light.yaml"')
        ? { status: 2, error: new Error(`remove failed ${REDACTED_URL_CANARY}`) }
        : { status: 0 };
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(skinWriteCalls(harness)).toHaveLength(1);
    expect(skinRemoveCalls(harness)).toHaveLength(1);
    expect(warningText(harness)).toContain("Could not update Hermes light terminal skin");
    expect(warningText(harness)).toContain("Could not remove Hermes light terminal skin");
    expect(warningText(harness)).not.toContain("user:secret");
    expectConnectSucceeded(harness, exitSpy);
  });

  it("writes the Hermes light skin over stdin so the multi-line script never rides argv (#6834)", async () => {
    vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
    vi.stubEnv("COLORFGBG", "0;15");
    const harness = createConnectHarness({
      agentName: "hermes",
      hermesConfig: { model: "test" },
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    const skinWriteCall = skinWriteCalls(harness)[0];
    expect(skinWriteCall?.[0]).toEqual(["sandbox", "exec", "--name", "alpha", "--", "sh", "-s"]);
    for (const part of (skinWriteCall?.[0] ?? []) as string[]) {
      expect(part).not.toMatch(/[\n\r]/);
    }
    const opts = skinWriteCall?.[1] as { input?: string; stdio?: unknown } | undefined;
    expect(opts?.input ?? "").toContain('mv -f "$tmp" "$skin_dir/nemoclaw-light.yaml"');
    expect(opts?.input ?? "").toContain("\n");
    expect(opts?.stdio).toEqual(["pipe", "ignore", "ignore"]);
    expectConnectSucceeded(harness, exitSpy);
  });
});
