// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  parseLegacyImageReasoning,
  parseLegacyReasoningContainerId,
  probeReasoningPropagation,
  reasoningPropagationSource,
} from "../fixtures/reasoning-propagation.ts";

function probeResult(stdout: string): ShellProbeResult {
  return {
    artifacts: { result: "", stderr: "", stdout: "" },
    command: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout,
    timedOut: false,
  };
}

describe("cloud onboarding reasoning propagation source", () => {
  it("uses the managed startup environment for managed images", () => {
    expect(reasoningPropagationSource("managed-image")).toEqual({
      kind: "managed-runtime-environment",
      path: "/run/nemoclaw/managed-startup-runtime.env",
    });
  });

  it("uses the image environment for the legacy Dockerfile fallback", () => {
    expect(reasoningPropagationSource("legacy-dockerfile")).toEqual({
      environmentName: "NEMOCLAW_REASONING",
      kind: "legacy-image-environment",
    });
  });

  it("runs the managed runtime-file and model assertion inside the sandbox", async () => {
    const hostCommand = vi.fn();
    const sandboxExec = vi
      .fn()
      .mockResolvedValue(probeResult('{"runtimeReasoning":"true","modelReasoning":true}\n'));

    await expect(
      probeReasoningPropagation({
        expectedModel: "nvidia/test-model",
        host: { command: hostCommand },
        sandbox: { exec: sandboxExec },
        sandboxName: "reasoning-managed",
        workloadKind: "managed-image",
      }),
    ).resolves.toEqual({ modelReasoning: true, runtimeReasoning: "true" });
    expect(hostCommand).not.toHaveBeenCalled();
    expect(sandboxExec).toHaveBeenCalledOnce();
    expect(sandboxExec.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["/run/nemoclaw/managed-startup-runtime.env"]),
    );
  });

  it("runs the legacy image-environment assertion before the sandbox model assertion", async () => {
    const hostCommand = vi
      .fn()
      .mockResolvedValueOnce(probeResult("123456789abc\n"))
      .mockResolvedValueOnce(probeResult("PATH=/usr/bin\nNEMOCLAW_REASONING=true\n"));
    const sandboxExec = vi.fn().mockResolvedValue(probeResult('{"modelReasoning":true}\n'));

    await expect(
      probeReasoningPropagation({
        expectedModel: "nvidia/test-model",
        host: { command: hostCommand },
        sandbox: { exec: sandboxExec },
        sandboxName: "reasoning-legacy",
        workloadKind: "legacy-dockerfile",
      }),
    ).resolves.toEqual({ imageReasoning: "true", modelReasoning: true });
    expect(hostCommand).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["ps", "--filter", "label=openshell.ai/sandbox-name=reasoning-legacy", "--format", "{{.ID}}"],
      expect.objectContaining({
        artifactName: "phase-2-compatible-endpoint-reasoning-container",
      }),
    );
    expect(hostCommand).toHaveBeenNthCalledWith(
      2,
      "docker",
      [
        "inspect",
        "--type",
        "container",
        "--format",
        "{{range .Config.Env}}{{println .}}{{end}}",
        "123456789abc",
      ],
      expect.objectContaining({
        artifactName: "phase-2-compatible-endpoint-reasoning-image-environment",
      }),
    );
    expect(sandboxExec).toHaveBeenCalledOnce();
  });

  it("rejects missing, ambiguous, and malformed legacy container identities", () => {
    expect(() => parseLegacyReasoningContainerId("\n")).toThrow(/exactly one valid/u);
    expect(() => parseLegacyReasoningContainerId("123456789abc\nabcdef123456\n")).toThrow(
      /exactly one valid/u,
    );
    expect(() => parseLegacyReasoningContainerId("not-a-container\n")).toThrow(
      /exactly one valid/u,
    );
  });

  it("requires one Boolean reasoning value from the legacy image environment", () => {
    expect(parseLegacyImageReasoning("PATH=/usr/bin\nNEMOCLAW_REASONING=false\n")).toBe("false");
    expect(() => parseLegacyImageReasoning("PATH=/usr/bin\n")).toThrow(/exactly once/u);
    expect(() =>
      parseLegacyImageReasoning("NEMOCLAW_REASONING=true\nNEMOCLAW_REASONING=false\n"),
    ).toThrow(/exactly once/u);
    expect(() => parseLegacyImageReasoning("NEMOCLAW_REASONING=enabled\n")).toThrow(/invalid/u);
  });
});
