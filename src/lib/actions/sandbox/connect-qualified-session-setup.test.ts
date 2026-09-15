// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import {
  completeInteractiveSessionSetup,
  completeReadinessQualifiedInteractiveSessionSetup,
} from "./connect";

function entry(agent: string | null): SandboxEntry {
  return {
    name: "alpha",
    agent,
    gatewayName: "nemoclaw-8080",
    gatewayPort: 8080,
    provider: null,
    model: null,
    gpuEnabled: false,
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

    completeReadinessQualifiedInteractiveSessionSetup(
      "alpha",
      loadAgent("openclaw"),
      entry("openclaw"),
      runApprovalPass,
    );

    expect(runApprovalPass).not.toHaveBeenCalled();
  });

  it("uses the qualified OpenClaw identity for a legacy registry entry (#9023)", () => {
    const runApprovalPass = vi.fn();

    completeReadinessQualifiedInteractiveSessionSetup(
      "alpha",
      loadAgent("openclaw"),
      entry(null),
      runApprovalPass,
    );

    expect(runApprovalPass).not.toHaveBeenCalled();
  });

  it.each(["hermes", "langchain-deepagents-code"])(
    "keeps the complete session path for %s (#9023)",
    (agent) => {
      const runApprovalPass = vi.fn();

      completeReadinessQualifiedInteractiveSessionSetup(
        "alpha",
        loadAgent(agent),
        entry(agent),
        runApprovalPass,
      );

      expect(runApprovalPass).toHaveBeenCalledOnce();
      expect(runApprovalPass).toHaveBeenCalledWith("alpha", "nemoclaw");
    },
  );

  it("keeps the complete session path when sandbox state is unavailable (#9023)", () => {
    const runApprovalPass = vi.fn();

    completeReadinessQualifiedInteractiveSessionSetup(
      "alpha",
      loadAgent("openclaw"),
      null,
      runApprovalPass,
      () => "nemoclaw",
    );

    expect(runApprovalPass).toHaveBeenCalledOnce();
    expect(runApprovalPass).toHaveBeenCalledWith("alpha", "nemoclaw");
  });
});
