// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { printNonReadySandboxPhaseGuidance } from "./status-lookup-rendering";

function captureConsoleLog(): { lines: () => string; restore: () => void } {
  const out: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map((a) => String(a)).join(" "));
  });
  return { lines: () => out.join("\n"), restore: () => spy.mockRestore() };
}

describe("printNonReadySandboxPhaseGuidance (#7222)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("steers a crashed sandbox to `start` (workspace-preserving), not `rebuild --yes`", () => {
    const cap = captureConsoleLog();
    // Error phase, container present but not paused → the crashed-container path.
    printNonReadySandboxPhaseGuidance({
      sandboxName: "beta",
      phase: "Error",
      dockerRuntime: {
        health: "none",
        paused: false,
        containerName: "openshell-beta-abc",
      },
    });
    const text = cap.lines();
    cap.restore();

    // The recovery hint now leads with `start`, which recovers without data loss.
    expect(text).toContain("nemoclaw beta start");
    expect(text).toContain("workspace state preserved");
    // `rebuild --yes` is only mentioned as the recreate alternative, and must no
    // longer be the promised recovery command (its pre-rebuild backup aborts on a
    // stopped container — the reported bug).
    expect(text).not.toContain("Run `nemoclaw beta rebuild --yes` to recreate");
    expect(text).not.toContain("workspace state will be preserved");
    // The `rebuild --yes` mention explains why `start` must come first.
    expect(text).toContain("cannot snapshot a stopped container");
  });

  it("keeps the unpause hint for a paused container and never suggests start/rebuild (#4495)", () => {
    const cap = captureConsoleLog();
    printNonReadySandboxPhaseGuidance({
      sandboxName: "beta",
      phase: "Error",
      dockerRuntime: {
        health: "none",
        paused: true,
        containerName: "openshell-beta-abc",
      },
    });
    const text = cap.lines();
    cap.restore();

    expect(text).toContain("docker unpause openshell-beta-abc");
    expect(text).not.toContain("rebuild --yes");
    expect(text).not.toContain("beta start");
  });

  it.each([
    { phase: "Failed", containerName: "openshell-beta-abc" },
    { phase: "Error", containerName: null },
  ])("keeps rebuild guidance for $phase when start cannot recover the container", ({
    phase,
    containerName,
  }) => {
    const cap = captureConsoleLog();
    printNonReadySandboxPhaseGuidance({
      sandboxName: "beta",
      phase,
      dockerRuntime: { health: "none", paused: false, containerName },
    });
    const text = cap.lines();
    cap.restore();

    expect(text).toContain("nemoclaw beta rebuild --yes");
    expect(text).not.toContain("nemoclaw beta start");
  });

  it("prints no guidance for a Ready sandbox", () => {
    const cap = captureConsoleLog();
    printNonReadySandboxPhaseGuidance({ sandboxName: "beta", phase: "Ready", dockerRuntime: null });
    const text = cap.lines();
    cap.restore();
    expect(text).toBe("");
  });
});
