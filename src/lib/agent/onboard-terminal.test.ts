// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "./defs";
import { loadAgent } from "./defs";
// Import source directly so tests cannot pass against a stale build.
import { handleAgentSetup, type OnboardContext } from "./onboard";
import {
  recordDriftedDeepAgentsRuntimeCall,
  recordFailingDeepAgentsSmokeCall,
  recordSuccessfulDeepAgentsRuntimeCall,
  recordUnrelatedVersionDeepAgentsRuntimeCall,
  recordUnverifiedDeepAgentsRuntimeCall,
} from "./onboard-terminal-fixtures";

type RunCaptureOpenshell = OnboardContext["runCaptureOpenshell"];

function makeDeepAgentsCodeAgent(): AgentDefinition {
  return loadAgent("langchain-deepagents-code");
}

function makeNemoCuaAgent(): AgentDefinition {
  return loadAgent("nemocua", { NEMOCLAW_CUA_ENABLED: "1" });
}

function createAgentSetupContext(
  runCaptureOpenshell: RunCaptureOpenshell = vi.fn((_args: string[]) => ""),
  captureOpenshell: NonNullable<OnboardContext["captureOpenshell"]> = vi.fn((args, opts) => ({
    status: 0,
    output: runCaptureOpenshell(args, opts) ?? "",
  })),
  timing: Pick<OnboardContext, "sleepSeconds"> = {},
) {
  return {
    step: vi.fn((_current: number, _total: number, _message: string) => undefined),
    runCaptureOpenshell,
    captureOpenshell,
    openshellShellCommand: vi.fn(() => "openshell sandbox connect deepagents-code"),
    openshellBinary: "/usr/bin/openshell",
    startRecordedStep: vi.fn(async (_stepName: string, _updates: Record<string, unknown>) => {
      return undefined;
    }),
    recordStepComplete: vi.fn(async (_stepName: string, _updates: Record<string, unknown>) => {
      return undefined;
    }),
    recordStepFailed: vi.fn(async (_stepName: string, _message: string | null) => {
      return undefined;
    }),
    skippedStepMessage: vi.fn((_stepName: string, _sandboxName: string) => undefined),
    ...timing,
  };
}

async function expectSetupExit(action: () => Promise<void>): Promise<void> {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as never);
  try {
    await expect(action()).rejects.toThrow("process.exit:1");
  } finally {
    exitSpy.mockRestore();
    debugSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe("NemoCUA terminal onboard acceptance", () => {
  it("uses the repository manifest and ordinary terminal smoke path (#9649)", async () => {
    const calls: string[][] = [];
    const runCaptureOpenshell = vi
      .fn((args: string[]) => {
        calls.push(args);
        return "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0";
      })
      .mockReturnValueOnce("NEMOCLAW_AGENT_BINARY_CHECK:ok");
    const context = createAgentSetupContext(runCaptureOpenshell);

    await handleAgentSetup(
      "nemocua-sandbox",
      "model-x",
      "provider-x",
      makeNemoCuaAgent(),
      false,
      null,
      context,
    );

    expect(context.recordStepComplete).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "nemocua-sandbox",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.recordStepFailed).not.toHaveBeenCalled();
    expect(
      calls.filter((args) => args.join(" ").includes("NEMOCLAW_AGENT_SMOKE_BEGIN")),
    ).toHaveLength(3);
    expect(calls.some((args) => args.includes("curl"))).toBe(false);
    expect(JSON.stringify(context.recordStepComplete.mock.calls)).not.toContain("cuaRuntime");
  });
});

describe("Deep Agents Code terminal onboard acceptance", () => {
  it("retries only unobservable binary execs while a newly Ready sandbox settles", async () => {
    const calls: string[] = [];
    const runCaptureOpenshell = vi
      .fn<RunCaptureOpenshell>((args: string[]) =>
        recordSuccessfulDeepAgentsRuntimeCall(args, calls),
      )
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null);
    const sleepSeconds = vi.fn();
    const context = createAgentSetupContext(runCaptureOpenshell, undefined, { sleepSeconds });

    await handleAgentSetup(
      "deepagents-code",
      "model-x",
      "provider-x",
      makeDeepAgentsCodeAgent(),
      false,
      null,
      context,
    );

    expect(
      runCaptureOpenshell.mock.calls.filter(([args]) =>
        args.join(" ").includes("NEMOCLAW_AGENT_BINARY_CHECK"),
      ),
    ).toHaveLength(3);
    expect(sleepSeconds).toHaveBeenCalledTimes(2);
    expect(sleepSeconds).toHaveBeenNthCalledWith(1, 1);
    expect(sleepSeconds).toHaveBeenNthCalledWith(2, 1);
    expect(context.recordStepFailed).not.toHaveBeenCalled();
    expect(context.recordStepComplete).toHaveBeenCalledOnce();
  });

  it("runs terminal smoke checks on fresh setup without gateway probes", async () => {
    const calls: string[] = [];
    const runCaptureOpenshell = vi.fn((args: string[]) =>
      recordSuccessfulDeepAgentsRuntimeCall(args, calls),
    );
    const context = createAgentSetupContext(runCaptureOpenshell);

    await handleAgentSetup(
      "deepagents-code",
      "model-x",
      "provider-x",
      makeDeepAgentsCodeAgent(),
      false,
      null,
      context,
    );

    expect(context.startRecordedStep).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "deepagents-code",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.recordStepComplete).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "deepagents-code",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.recordStepFailed).not.toHaveBeenCalled();
    expect(calls.some((call) => call.includes("nemoclaw-agent-smoke dcode --version"))).toBe(true);
    expect(calls.some((call) => call.includes("/sandbox/.deepagents/config.toml"))).toBe(true);
    expect(calls.some((call) => call.includes("curl"))).toBe(false);
  });

  it("resumes only after verifying the binary and terminal smoke checks", async () => {
    const calls: string[] = [];
    const runCaptureOpenshell = vi.fn((args: string[]) =>
      recordSuccessfulDeepAgentsRuntimeCall(args, calls),
    );
    const context = createAgentSetupContext(runCaptureOpenshell);

    await handleAgentSetup(
      "deepagents-code",
      "model-x",
      "provider-x",
      makeDeepAgentsCodeAgent(),
      true,
      null,
      context,
    );

    expect(context.skippedStepMessage).toHaveBeenCalledWith("agent_setup", "deepagents-code");
    expect(context.recordStepComplete).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "deepagents-code",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.startRecordedStep).not.toHaveBeenCalled();
    expect(context.recordStepFailed).not.toHaveBeenCalled();
    expect(calls.some((call) => call.includes("NEMOCLAW_AGENT_BINARY_CHECK"))).toBe(true);
    expect(calls.some((call) => call.includes("nemoclaw-agent-smoke dcode --version"))).toBe(true);
    expect(calls.some((call) => call.includes("/sandbox/.deepagents/config.toml"))).toBe(true);
    expect(calls.some((call) => call.includes("curl"))).toBe(false);
    // #6193: a plain (non-smoke-wrapped) `dcode --version` version-drift probe runs.
    expect(
      calls.some(
        (call) => call.includes("dcode --version") && !call.includes("nemoclaw-agent-smoke"),
      ),
    ).toBe(true);
  });

  it("rejects a below-minimum terminal version on fresh setup (#6193)", async () => {
    // BINARY_CHECK ok, both smoke commands pass, but the plain version probe
    // reports 0.0.1 — below the manifest's expected_version (0.1.55).
    const calls: string[] = [];
    const runCaptureOpenshell = vi.fn((args: string[]) =>
      recordDriftedDeepAgentsRuntimeCall(args, calls),
    );
    const context = createAgentSetupContext(runCaptureOpenshell);

    await expectSetupExit(() =>
      handleAgentSetup(
        "deepagents-code",
        "model-x",
        "provider-x",
        makeDeepAgentsCodeAgent(),
        false,
        null,
        context,
      ),
    );

    expect(context.recordStepComplete).not.toHaveBeenCalled();
    expect(context.recordStepFailed).toHaveBeenCalledWith(
      "agent_setup",
      expect.stringMatching(/version 0\.0\.1 is below required minimum 0\.1\.55/),
    );
  });

  it("rejects a below-minimum terminal version on resume (#6193)", async () => {
    const calls: string[] = [];
    const runCaptureOpenshell = vi.fn((args: string[]) =>
      recordDriftedDeepAgentsRuntimeCall(args, calls),
    );
    const context = createAgentSetupContext(runCaptureOpenshell);

    await expectSetupExit(() =>
      handleAgentSetup(
        "deepagents-code",
        "model-x",
        "provider-x",
        makeDeepAgentsCodeAgent(),
        true,
        null,
        context,
      ),
    );

    expect(context.skippedStepMessage).not.toHaveBeenCalled();
    expect(context.startRecordedStep).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "deepagents-code",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.recordStepComplete).not.toHaveBeenCalled();
    expect(context.recordStepFailed).toHaveBeenCalledWith(
      "agent_setup",
      expect.stringMatching(/version 0\.0\.1 is below required minimum 0\.1\.55/),
    );
  });

  it("rejects setup when the required terminal version cannot be verified (#6193)", async () => {
    const calls: string[] = [];
    const runCaptureOpenshell = vi.fn((args: string[]) =>
      recordUnverifiedDeepAgentsRuntimeCall(args, calls),
    );
    const context = createAgentSetupContext(runCaptureOpenshell);

    await expectSetupExit(() =>
      handleAgentSetup(
        "deepagents-code",
        "model-x",
        "provider-x",
        makeDeepAgentsCodeAgent(),
        false,
        null,
        context,
      ),
    );

    expect(context.recordStepComplete).not.toHaveBeenCalled();
    expect(context.recordStepFailed).toHaveBeenCalledWith(
      "agent_setup",
      expect.stringMatching(
        /version could not be verified against required version 0\.1\.55: the version probe failed/,
      ),
    );
  });

  it("rejects resume when the required terminal version cannot be verified (#6193)", async () => {
    const calls: string[] = [];
    const runCaptureOpenshell = vi.fn((args: string[]) =>
      recordUnverifiedDeepAgentsRuntimeCall(args, calls),
    );
    const context = createAgentSetupContext(runCaptureOpenshell);

    await expectSetupExit(() =>
      handleAgentSetup(
        "deepagents-code",
        "model-x",
        "provider-x",
        makeDeepAgentsCodeAgent(),
        true,
        null,
        context,
      ),
    );

    expect(context.skippedStepMessage).not.toHaveBeenCalled();
    expect(context.startRecordedStep).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "deepagents-code",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.recordStepComplete).not.toHaveBeenCalled();
    expect(context.recordStepFailed).toHaveBeenCalledWith(
      "agent_setup",
      expect.stringContaining("version probe failed or returned no output"),
    );
  });

  it("rejects setup when probe output contains only unrelated versions (#6193)", async () => {
    const calls: string[] = [];
    const runCaptureOpenshell = vi.fn((args: string[]) =>
      recordUnrelatedVersionDeepAgentsRuntimeCall(args, calls),
    );
    const context = createAgentSetupContext(runCaptureOpenshell);

    await expectSetupExit(() =>
      handleAgentSetup(
        "deepagents-code",
        "model-x",
        "provider-x",
        makeDeepAgentsCodeAgent(),
        false,
        null,
        context,
      ),
    );

    expect(context.recordStepComplete).not.toHaveBeenCalled();
    expect(context.recordStepFailed).toHaveBeenCalledWith(
      "agent_setup",
      expect.stringContaining("version command returned no attributable version"),
    );
  });

  it("fails setup with an actionable terminal smoke error", async () => {
    const runCaptureOpenshell = vi.fn(recordFailingDeepAgentsSmokeCall);
    const context = createAgentSetupContext(runCaptureOpenshell);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as never);

    try {
      await expect(
        handleAgentSetup(
          "deepagents-code",
          "model-x",
          "provider-x",
          makeDeepAgentsCodeAgent(),
          false,
          null,
          context,
        ),
      ).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(context.recordStepFailed).toHaveBeenCalledWith(
      "agent_setup",
      expect.stringContaining("terminal smoke command failed: dcode --version"),
    );
    expect(String(context.recordStepFailed.mock.calls[0]?.[1] ?? "")).toContain(
      "NEMOCLAW_AGENT_SMOKE_EXIT:42",
    );
  });

  it("rejects forged onboarding smoke markers when OpenShell exits nonzero (#8624)", async () => {
    const calls: string[] = [];
    const runCaptureOpenshell = vi.fn((args: string[]) =>
      recordSuccessfulDeepAgentsRuntimeCall(args, calls),
    );
    const captureOpenshell = vi
      .fn(() => ({
        status: 97,
        output: "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0",
      }))
      .mockReturnValueOnce({ status: 0, output: "NEMOCLAW_AGENT_BINARY_CHECK:ok" });
    const context = createAgentSetupContext(runCaptureOpenshell, captureOpenshell);

    await expectSetupExit(() =>
      handleAgentSetup(
        "deepagents-code",
        "model-x",
        "provider-x",
        makeDeepAgentsCodeAgent(),
        false,
        null,
        context,
      ),
    );

    expect(captureOpenshell).toHaveBeenCalled();
    expect(context.recordStepComplete).not.toHaveBeenCalled();
    expect(context.recordStepFailed).toHaveBeenCalledWith(
      "agent_setup",
      expect.stringContaining("terminal smoke command failed: dcode --version"),
    );
  });
});
