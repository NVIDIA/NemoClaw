// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { printSandboxGatewayLookupStatus } from "./status-lookup-rendering";

function captureConsoleLog(): { lines: () => string; restore: () => void } {
  const out: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map((a) => String(a)).join(" "));
  });
  return { lines: () => out.join("\n"), restore: () => spy.mockRestore() };
}

async function printGuidance({
  phase,
  dockerRuntime,
}: {
  phase: string;
  dockerRuntime: {
    health: "none";
    paused: boolean;
    running: boolean;
    containerName: string | null;
  } | null;
}): Promise<void> {
  await printSandboxGatewayLookupStatus({
    sandboxName: "beta",
    registered: true,
    lookup: { state: "present", output: `Sandbox:\n  Name: beta\n  Phase: ${phase}` },
    phase,
    dockerRuntime,
    effectivePreflight: {
      failure: null,
      failureLayer: null,
      suppressInferenceProbe: false,
      exitCode: 0,
    },
  });
}

describe("printNonReadySandboxPhaseGuidance (#7222)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("steers a crashed sandbox to `start` (workspace-preserving), not `rebuild --yes`", async () => {
    const cap = captureConsoleLog();
    // Error phase, container present but not paused → the crashed-container path.
    await printGuidance({
      phase: "Error",
      dockerRuntime: {
        health: "none",
        paused: false,
        running: true,
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

  it("reports an owned stopped container without crash guidance (#8695)", async () => {
    const cap = captureConsoleLog();
    await printGuidance({
      phase: "Provisioning",
      dockerRuntime: {
        health: "none",
        paused: false,
        running: false,
        containerName: "openshell-beta-abc",
      },
    });
    const text = cap.lines();
    cap.restore();

    expect(text).toContain("Sandbox 'beta' is stopped.");
    expect(text).toContain("Workspace state is preserved.");
    expect(text).toContain("nemoclaw beta start");
    expect(text).not.toContain("process crash");
    expect(text).not.toContain("is stuck");
    expect(text).not.toContain("rebuild --yes");
  });

  it("renders Phase: Stopped and clean stopped guidance when phase is Stopped (#11025)", async () => {
    const cap = captureConsoleLog();
    await printGuidance({
      phase: "Stopped",
      dockerRuntime: null,
    });
    const text = cap.lines();
    cap.restore();

    expect(text).toContain("Phase: Stopped");
    expect(text).toContain("Sandbox 'beta' is stopped.");
    expect(text).toContain("Workspace state is preserved.");
    expect(text).toContain("nemoclaw beta start");
    expect(text).not.toContain("is stuck");
    expect(text).not.toContain("rebuild --yes");
  });

  it("renders a missing provider-confirmed intentional stop as cleanly stopped (#11025)", async () => {
    const cap = captureConsoleLog();
    await printSandboxGatewayLookupStatus({
      sandboxName: "beta",
      registered: true,
      lookup: { state: "missing", output: "sandbox beta not found" },
      phase: "Stopped",
      dockerRuntime: null,
      effectivePreflight: {
        failure: null,
        failureLayer: null,
        intentionalStopConfirmed: true,
        suppressInferenceProbe: true,
        exitCode: 0,
      },
    });
    const text = cap.lines();
    cap.restore();

    expect(text).toContain("Phase: Stopped");
    expect(text).toContain("Sandbox 'beta' is stopped.");
    expect(text).toContain("Workspace state is preserved.");
    expect(text).toContain("nemoclaw beta start");
    expect(text).not.toContain("not present in the live OpenShell gateway");
  });

  it("does not render a gateway schema mismatch as an intentional stop (#11025)", async () => {
    const cap = captureConsoleLog();
    await expect(
      printSandboxGatewayLookupStatus({
        sandboxName: "beta",
        registered: true,
        lookup: { state: "gateway_schema_mismatch", output: "gateway schema mismatch" },
        phase: "Stopped",
        dockerRuntime: null,
        effectivePreflight: {
          failure: null,
          failureLayer: null,
          intentionalStopConfirmed: true,
          suppressInferenceProbe: true,
          exitCode: 0,
        },
      }),
    ).rejects.toMatchObject({ exitCode: 1 });
    const text = cap.lines();
    cap.restore();

    expect(text).toContain("gateway schema mismatch");
    expect(text).not.toContain("Phase: Stopped");
    expect(text).not.toContain("Workspace state is preserved");
  });

  it("reports a stale stop-record write failure without agent recovery guidance (#11025)", async () => {
    const cap = captureConsoleLog();
    await expect(
      printSandboxGatewayLookupStatus({
        sandboxName: "beta",
        registered: true,
        lookup: {
          state: "stop_intent_update_failed",
          output:
            "  Sandbox 'beta' is running, but NemoClaw could not clear its stale intentional-stop record.",
        },
        phase: "Running",
        dockerRuntime: null,
        effectivePreflight: {
          failure: null,
          failureLayer: null,
          intentionalStopConfirmed: false,
          suppressInferenceProbe: false,
          exitCode: 0,
        },
      }),
    ).rejects.toMatchObject({ exitCode: 1 });
    const text = cap.lines();
    cap.restore();

    expect(text).toContain("could not clear its stale intentional-stop record");
    expect(text).toContain("Repair access to NemoClaw's local state");
    expect(text).toContain("nemoclaw beta status");
    expect(text).not.toContain("agent delivery chain");
    expect(text).not.toContain("nemoclaw beta recover");
  });

  it("keeps the unpause hint for a paused container and never suggests start/rebuild (#4495)", async () => {
    const cap = captureConsoleLog();
    await printGuidance({
      phase: "Error",
      dockerRuntime: {
        health: "none",
        paused: true,
        running: true,
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
  ])(
    "keeps rebuild guidance for $phase when start cannot recover the container",
    async ({ phase, containerName }) => {
      const cap = captureConsoleLog();
      await printGuidance({
        phase,
        dockerRuntime: { health: "none", paused: false, running: true, containerName },
      });
      const text = cap.lines();
      cap.restore();

      expect(text).toContain("nemoclaw beta rebuild --yes");
      expect(text).not.toContain("nemoclaw beta start");
    },
  );

  it("prints no guidance for a Ready sandbox", async () => {
    const cap = captureConsoleLog();
    await printGuidance({ phase: "Ready", dockerRuntime: null });
    const text = cap.lines();
    cap.restore();
    expect(text).toContain("Phase: Ready");
    expect(text).not.toContain("is stuck");
    expect(text).not.toContain("nemoclaw beta start");
    expect(text).not.toContain("nemoclaw beta rebuild");
  });
});
