// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  applyVllmInstallResumeDefaults,
  readVllmInstallResumeModel,
  type VllmInstallResumeDeps,
  vllmInstallRecoveryOptions,
} from "../provider-recovery";

describe("managed vLLM install resume", () => {
  it("keeps an explicit provider authoritative over an unfinished install", () => {
    const access = {
      loadSession: () => ({ vllmInstallModel: "example/model" }),
    };
    const deps: VllmInstallResumeDeps = applyVllmInstallResumeDefaults(
      { getNonInteractiveProvider: () => "build" },
      access,
    );

    expect(deps.getNonInteractiveProvider()).toBe("build");
    expect(deps.getVllmInstallResumeModel?.()).toBe("example/model");
    expect(readVllmInstallResumeModel(access)).toBe("example/model");
  });

  it("re-arms managed vLLM with the recorded model and checkpoint writer", () => {
    const checkpointVllmInstallModel = vi.fn();
    const access = {
      loadSession: () => ({
        vllmInstallModel: "example/model",
        steps: { provider_selection: { status: "in_progress" } },
      }),
      checkpointVllmInstallModel,
    };
    const deps: VllmInstallResumeDeps = applyVllmInstallResumeDefaults(
      { getNonInteractiveProvider: () => null },
      access,
    );

    expect(deps.getNonInteractiveProvider()).toBe("install-vllm");
    const options = vllmInstallRecoveryOptions(deps, access);
    expect(options.modelIntent).toBe("example/model");
    options.checkpointInstallIntent?.("example/model");
    expect(checkpointVllmInstallModel).toHaveBeenCalledWith("example/model");
  });

  it("does not expose a session writer outside an active provider step", () => {
    const checkpointVllmInstallModel = vi.fn();
    const access = {
      loadSession: () => ({
        vllmInstallModel: null,
        steps: { provider_selection: { status: "pending" } },
      }),
      checkpointVllmInstallModel,
    };

    expect(vllmInstallRecoveryOptions({}, access)).toEqual({});
    expect(checkpointVllmInstallModel).not.toHaveBeenCalled();
  });
});
