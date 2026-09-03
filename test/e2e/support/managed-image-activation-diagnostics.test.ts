// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  captureManagedImageOnboardPairingDiagnostics,
  summarizeOnboardFailureStartupSignals,
} from "../live/managed-image-activation-e2e-helpers.ts";

describe("managed image activation failure diagnostics", () => {
  it("emits only fixed startup signals from arbitrary container output (#8543)", () => {
    const secret = "untrusted-prompt-and-credential";
    const summary = summarizeOnboardFailureStartupSignals(
      [
        secret,
        "Setting up NemoClaw (Hermes)...",
        "Hermes runtime config guard refuses mutation under a foreign PID 1",
      ].join("\n"),
    );

    expect(summary.setupStarted).toBe(true);
    expect(summary.foreignPidOneBoundary).toBe(true);
    expect(Object.values(summary).every((value) => typeof value === "boolean")).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("reports which Hermes startup refusal ended the container (#8543)", () => {
    const summary = summarizeOnboardFailureStartupSignals(
      [
        "Setting up NemoClaw (Hermes)...",
        "[SECURITY] Refusing Hermes startup because /run/nemoclaw must be root-owned with mode 0755",
      ].join("\n"),
    );

    expect(summary.hermesRuntimeDirRefused).toBe(true);
    expect(summary.hermesApiPortRejected).toBe(false);
    expect(summary.hermesRuntimeMarkerRefused).toBe(false);
  });

  it("captures bounded pairing stages only for OpenClaw onboarding failures (#9844)", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }));

    await captureManagedImageOnboardPairingDiagnostics(
      { exec } as never,
      "openclaw",
      "mi-act-openclaw",
      { PATH: "/usr/bin" },
    );
    await captureManagedImageOnboardPairingDiagnostics(
      { exec } as never,
      "hermes",
      "mi-act-hermes",
      { PATH: "/usr/bin" },
    );

    expect(exec).toHaveBeenCalledExactlyOnceWith(
      "mi-act-openclaw",
      ["node", "-e", expect.any(String), "/tmp/auto-pair.log", "/tmp/gateway.log"],
      expect.objectContaining({
        artifactName: "failure-openclaw-pairing-diagnostics",
        redactionValues: ["nemoclaw-managed-activation-e2e-key"],
      }),
    );
  });
});
