// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import {
  completeInteractiveSessionSetup,
  completeReadinessQualifiedInteractiveSessionSetup,
} from "./connect";

function entry(agent: string): SandboxEntry {
  return {
    name: "alpha",
    agent,
    gatewayName: "nemoclaw-8080",
    gatewayPort: 8080,
    provider: null,
    model: null,
    gpuEnabled: false,
    policies: [],
  } as SandboxEntry;
}

describe("readiness-qualified interactive session setup", () => {
  it("delegates complete OpenClaw fallback to the existing pairing path once (#9023)", () => {
    const runApprovalPass = vi.fn();

    completeInteractiveSessionSetup("alpha", entry("openclaw"), runApprovalPass);

    expect(runApprovalPass).toHaveBeenCalledOnce();
    expect(runApprovalPass).toHaveBeenCalledWith("alpha", "nemoclaw");
  });

  it("does not run the complete pairing path for qualified OpenClaw state (#9023)", () => {
    const runApprovalPass = vi.fn();

    completeReadinessQualifiedInteractiveSessionSetup("alpha", entry("openclaw"), runApprovalPass);

    expect(runApprovalPass).not.toHaveBeenCalled();
  });

  it.each(["hermes", "langchain-deepagents-code", "unknown-agent"])(
    "keeps the complete session path for %s (#9023)",
    (agent) => {
      const runApprovalPass = vi.fn();

      completeReadinessQualifiedInteractiveSessionSetup("alpha", entry(agent), runApprovalPass);

      expect(runApprovalPass).toHaveBeenCalledOnce();
      expect(runApprovalPass).toHaveBeenCalledWith("alpha", "nemoclaw");
    },
  );
});
