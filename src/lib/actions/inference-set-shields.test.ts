// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runInferenceSet } from "./inference-set";
import { createDeps, HERMES_TARGET } from "./inference-set.test-support";

describe("runInferenceSet shields state", () => {
  it("refuses a Hermes switch while shields are up before changing route or registry state", async () => {
    const deps = createDeps({
      config: { model: { default: "moonshotai/kimi-k2.6" } },
      entry: {
        name: "hermes",
        agent: "hermes",
        provider: "hermes-provider",
        model: "moonshotai/kimi-k2.6",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      shieldsMutable: false,
    });

    await expect(
      runInferenceSet(
        {
          provider: "hermes-provider",
          model: "openai/gpt-5.4-mini",
          sandboxName: "hermes",
        },
        deps,
      ),
    ).rejects.toThrow("shields are up");
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("refuses an OpenClaw switch while shields are up before changing route or registry state", async () => {
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/moonshotai/kimi-k2.6" } } },
      },
      shieldsMutable: false,
    });

    await expect(
      runInferenceSet(
        {
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          sandboxName: "alpha",
        },
        deps,
      ),
    ).rejects.toThrow(/OpenClaw inference changes.*shields are up/);
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });
});
