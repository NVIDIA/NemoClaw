// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxRepairMain } from "../bin/nemoclaw.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sandbox repair-main command", () => {
  it("repairs runtime main wiring and verifies main by default", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runSandboxScript = vi.fn().mockReturnValue({ status: 0, stdout: "" });

    const result = sandboxRepairMain("the-crucible", [], {
      ensureLiveSandboxForAction: vi.fn().mockReturnValue(true),
      runSandboxScript,
      exit: () => {},
    });

    expect(result).toBe(true);
    expect(runSandboxScript).toHaveBeenCalledTimes(2);
    expect(runSandboxScript.mock.calls[0][1]).toContain(
      "OPENCLAW_CONFIG_PATH=/tmp/nemoclaw/openclaw.json",
    );
    expect(runSandboxScript.mock.calls[0][1]).toContain("'id': 'main'");
    expect(runSandboxScript.mock.calls[1][1]).toContain("openclaw agent --agent main --local");

    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Repairing main agent wiring");
    expect(printed).toContain("Repaired main agent wiring");
  });

  it("supports --skip-verify and --model", () => {
    const runSandboxScript = vi.fn().mockReturnValue({ status: 0, stdout: "" });

    const result = sandboxRepairMain(
      "the-crucible",
      ["--model", "qwen3.5:9b-64k", "--skip-verify"],
      {
        ensureLiveSandboxForAction: vi.fn().mockReturnValue(true),
        runSandboxScript,
        exit: () => {},
      },
    );

    expect(result).toBe(true);
    expect(runSandboxScript).toHaveBeenCalledTimes(1);
    expect(runSandboxScript.mock.calls[0][1]).toContain('model_override = "qwen3.5:9b-64k"');
  });

  it("exits with failure on stale sandbox", () => {
    const exitSpy = vi.fn();

    const result = sandboxRepairMain("the-crucible", [], {
      ensureLiveSandboxForAction: vi.fn().mockReturnValue(false),
      exit: exitSpy,
    });

    expect(result).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
