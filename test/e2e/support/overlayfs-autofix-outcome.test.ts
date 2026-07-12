// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { negativeOverlayOutcome } from "../live/overlayfs-autofix-outcome.ts";

function shellProbeResult(overrides: Partial<ShellProbeResult>): ShellProbeResult {
  return {
    command: ["timeout", "300", "bash", "install.sh", "--non-interactive"],
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
    ...overrides,
  };
}

describe("overlayfs autofix negative outcome classifier", () => {
  it("treats nested-overlay evidence as a reproduced failure", () => {
    expect(
      negativeOverlayOutcome(
        shellProbeResult({ exitCode: 1 }),
        "k3s failed: overlayfs snapshotter cannot be enabled",
      ),
    ).toBe("reproduced");
  });

  it("treats only the inner GNU timeout exit 124 as timeout non-reproduction", () => {
    expect(negativeOverlayOutcome(shellProbeResult({ exitCode: 124 }), "no signature")).toBe(
      "timeout",
    );
  });

  it("does not classify outer ShellProbe supervisor timeout as timeout non-reproduction", () => {
    expect(
      negativeOverlayOutcome(
        shellProbeResult({ exitCode: null, signal: "SIGKILL", timedOut: true }),
        "no signature",
      ),
    ).toBe("unrelated");
  });
});
