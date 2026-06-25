// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression guard for #5449: `nemoclaw <name> destroy` must wipe the
// sandbox's persistent state (the agent-manifest state dirs/files such as
// `workspace/USER.md`) while the sandbox is still live, BEFORE
// `openshell sandbox delete`. Otherwise the per-sandbox PVC survives the
// delete and re-onboarding with the same name resurrects the old workspace
// files (USER.md, SOUL.md, ...). Same bug class as #3114 (stale shields
// state surviving destroy -> re-onboard).

import { describe, expect, it, vi } from "vitest";

import * as destroy from "../dist/lib/actions/sandbox/destroy.js";

type OpenshellResult = { status: number | null };

function buildDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const runOpenshell = vi.fn(
    (_args: string[], _opts?: Record<string, unknown>): OpenshellResult => ({
      status: 0,
    }),
  );
  const deps = {
    getSandbox: vi.fn(() => ({ agent: "openclaw" }) as never),
    loadAgent: vi.fn(() => ({
      configPaths: { dir: "/sandbox/.openclaw" },
      stateDirs: ["agents", "extensions", "workspace", "skills", "hooks", "identity"],
      stateFiles: [],
    })),
    runOpenshell,
    ...overrides,
  };
  return { deps, runOpenshell };
}

function execCommand(runOpenshell: ReturnType<typeof vi.fn>): { argv: string[]; script: string } {
  const call = runOpenshell.mock.calls.find(
    (args) => Array.isArray(args[0]) && args[0][0] === "sandbox" && args[0][1] === "exec",
  );
  expect(call, "no `openshell sandbox exec` call was issued").toBeDefined();
  const argv = call[0] as string[];
  // The remote command is the final argument after the `sh -c` marker.
  const script = argv[argv.length - 1];
  return { argv, script };
}

describe("wipeSandboxState (#5449)", () => {
  it("wipes the workspace dir (where USER.md lives) via a live exec", () => {
    const { deps, runOpenshell } = buildDeps();

    destroy.wipeSandboxState("test-sb", deps as never);

    const { argv, script } = execCommand(runOpenshell);
    // Targets the named sandbox while it is still live.
    expect(argv.slice(0, 4)).toEqual(["sandbox", "exec", "--name", "test-sb"]);
    // Removes the manifest state set under the agent config dir, including
    // `workspace/` which holds USER.md / SOUL.md.
    expect(script).toContain("/sandbox/.openclaw");
    expect(script).toContain("workspace");
    expect(script).toMatch(/rm\s+-rf/);
  });

  it("also removes multi-agent workspace-* dirs (#1260)", () => {
    const { deps, runOpenshell } = buildDeps();

    destroy.wipeSandboxState("test-sb", deps as never);

    const { script } = execCommand(runOpenshell);
    expect(script).toContain("workspace-*");
  });

  it("passes ignoreError so a wipe failure never aborts destroy", () => {
    const { deps, runOpenshell } = buildDeps();

    destroy.wipeSandboxState("test-sb", deps as never);

    const call = runOpenshell.mock.calls.find((args) => (args[0] as string[])[1] === "exec");
    expect((call?.[1] as { ignoreError?: boolean })?.ignoreError).toBe(true);
  });

  it("is best-effort: a non-zero exec (e.g. sandbox not live) warns but does not throw", () => {
    const { deps } = buildDeps({
      runOpenshell: vi.fn(() => ({ status: 1 })),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(() => destroy.wipeSandboxState("test-sb", deps as never)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not wipe workspace state"));
    } finally {
      warn.mockRestore();
    }
  });
});
