// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { runInferenceSet } from "./inference-set";
import {
  baseSession,
  createCompatibleProviderCapture,
  createDeps,
} from "./inference-set.test-support";

describe("runInferenceSet status-zero route ambiguity", () => {
  it.each([
    ["authentication", "Error: unauthorized token=secret"],
    ["gateway identity", "handshake verification failed token=secret"],
  ])(
    "does not roll back a created direct provider after status-zero %s output",
    async (_, routeOutput) => {
      const providerCapture = createCompatibleProviderCapture({
        name: "compatible-endpoint",
        type: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
        configKey: "OPENAI_BASE_URL",
        initiallyPresent: false,
      });
      const captureOpenshell = vi.fn((args: string[]) =>
        args[0] === "inference" && args[1] === "set"
          ? { status: 0, output: routeOutput, stdout: routeOutput, stderr: "" }
          : providerCapture(args),
      );
      const deps = createDeps({
        config: { agents: { defaults: { model: { primary: "inference/old-model" } } } },
        entry: {
          name: "alpha",
          agent: "openclaw",
          provider: "nvidia-prod",
          model: "old-model",
        },
        session: baseSession({ provider: "nvidia-prod", model: "old-model" }),
        captureOpenshell,
      });

      await expect(
        runInferenceSet(
          {
            provider: "compatible-endpoint",
            model: "mock-model",
            noVerify: true,
            endpointUrl: "http://host.openshell.internal:18767/v1",
            credentialEnv: "COMPATIBLE_API_KEY",
            inferenceApi: "openai-completions",
          },
          deps,
        ),
      ).rejects.toThrow(/Inspect gateway 'nemoclaw'.*rerun the same/u);

      const routeCalls = captureOpenshell.mock.calls.filter(
        ([args]) => args[0] === "inference" && args[1] === "set",
      );
      expect(routeCalls).toHaveLength(1);
      expect(
        captureOpenshell.mock.calls.some(
          ([args]) => args[0] === "provider" && args[1] === "create",
        ),
      ).toBe(true);
      expect(
        captureOpenshell.mock.calls.some(
          ([args]) => args[0] === "provider" && args[1] === "delete",
        ),
      ).toBe(false);
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
      expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
      expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
    },
  );
});
