// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CuaRuntimeReadiness } from "../cua/contract";
import type { OnboardContext } from "./onboard";

const { requireQualifiedCuaRuntimeReadiness } = vi.hoisted(() => ({
  requireQualifiedCuaRuntimeReadiness: vi.fn(),
}));

vi.mock("../cua/runtime-readiness", () => ({ requireQualifiedCuaRuntimeReadiness }));

const { loadAgent } = await import("./defs");
const { handleAgentSetup } = await import("./onboard");

const readiness = {
  schemaVersion: "1.0.0",
  kind: "runtime-readiness",
  mode: "standalone",
  status: "available",
  components: {
    runtime: {
      name: "nemocua",
      version: "0.0.20-dev-v3",
      digest: `sha256:${"1".repeat(64)}`,
      owner: "NVIDIA NemoCUA",
    },
    sandboxImage: {
      name: "nemocua-runtime",
      version: "0.0.5",
      digest: `sha256:${"2".repeat(64)}`,
      owner: "NVIDIA NemoCUA",
    },
    policy: {
      name: "nemocua-policy",
      version: "1",
      digest: `sha256:${"3".repeat(64)}`,
      owner: "NVIDIA NemoClaw",
    },
    taskProtocol: {
      name: "nemoclaw-cua-lifecycle",
      version: "1.0.0",
      digest: `sha256:${"4".repeat(64)}`,
      owner: "NVIDIA NemoClaw",
    },
  },
  inference: { provider: "provider-x", model: "model-x" },
  commands: { interactive: true, headless: true, version: true, smoke: true },
  limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
  requiredCapabilities: ["browser", "computer", "terminal"],
  targetOperations: [
    "target.attach",
    "target.status",
    "target.health",
    "target.detach",
    "target.reset",
    "target.destroy",
  ],
  taskOperations: [
    "task.start",
    "task.status",
    "task.result",
    "task.events",
    "task.logs",
    "task.plans",
    "task.cancel",
    "task.pause",
    "task.guide",
    "task.respond",
  ],
} satisfies CuaRuntimeReadiness;

function createContext(runCaptureOpenshell: OnboardContext["runCaptureOpenshell"]) {
  return {
    step: vi.fn(),
    runCaptureOpenshell,
    openshellShellCommand: vi.fn(() => "openshell sandbox connect my-cua"),
    openshellBinary: "/usr/bin/openshell",
    startRecordedStep: vi.fn(async () => undefined),
    recordStepComplete: vi.fn(async () => undefined),
    recordStepFailed: vi.fn(async () => undefined),
    skippedStepMessage: vi.fn(),
    updateSandbox: vi.fn(() => true),
  } satisfies OnboardContext;
}

async function expectSetupExit(action: () => Promise<void>): Promise<void> {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as never);
  try {
    await expect(action()).rejects.toThrow("process.exit:1");
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe("NemoCUA terminal onboarding", () => {
  beforeEach(() => {
    requireQualifiedCuaRuntimeReadiness.mockReset();
    requireQualifiedCuaRuntimeReadiness.mockReturnValue(readiness);
  });

  it("records qualified runtime readiness when terminal setup resumes (#7755)", async () => {
    const responses: ReadonlyArray<readonly [RegExp, string]> = [
      [/NEMOCLAW_AGENT_BINARY_CHECK/, "NEMOCLAW_AGENT_BINARY_CHECK:ok"],
      [/^nemocua-runtime version$/, "nemocua-runtime 0.0.20-dev-v3"],
      [/^nemocua-runtime smoke$/, "NEMOCLAW_AGENT_SMOKE_EXIT:0"],
    ];
    const runCaptureOpenshell = vi.fn((args: string[]) => {
      const command = args.at(-1) ?? "";
      return responses.find(([pattern]) => pattern.test(command))?.[1] ?? "";
    });
    const context = createContext(runCaptureOpenshell);

    await handleAgentSetup(
      "my-cua",
      "model-x",
      "provider-x",
      loadAgent("nemocua"),
      true,
      null,
      context,
    );

    expect(context.updateSandbox).toHaveBeenCalledWith("my-cua", {
      cuaRuntimeReadiness: readiness,
    });
    expect(context.recordStepComplete).toHaveBeenCalledWith("agent_setup", {
      sandboxName: "my-cua",
      provider: "provider-x",
      model: "model-x",
    });
    expect(context.recordStepFailed).not.toHaveBeenCalled();
  });

  it("records a missing binary failure without treating updateSandbox as details (#7755)", async () => {
    const context = createContext(vi.fn(() => "NEMOCLAW_AGENT_BINARY_CHECK:not_found"));

    await expectSetupExit(() =>
      handleAgentSetup(
        "my-cua",
        "model-x",
        "provider-x",
        loadAgent("nemocua"),
        false,
        null,
        context,
      ),
    );

    expect(context.recordStepFailed).toHaveBeenCalledWith(
      "agent_setup",
      expect.stringContaining("NemoCUA binary 'nemocua-runtime' is missing"),
    );
    expect(context.updateSandbox).not.toHaveBeenCalled();
  });
});
