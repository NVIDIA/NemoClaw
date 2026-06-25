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
  // `expect(call).toBeDefined()` is a runtime guard; tsc does not narrow the
  // type through it, so assert non-null here so the assertion above is the
  // single source of failure for a missing exec call.
  const argv = (call as NonNullable<typeof call>)[0] as string[];
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

  // PRA-6 #5455: a manifest declaring a relative escape (e.g. `../etc`) or an
  // absolute path (e.g. `/etc/passwd`) in state_dirs/state_files would be
  // shell-quoted but fed straight into `rm -rf -- ...` inside `cd ${dir}`,
  // where the relative form would traverse outside the agent config dir.
  // Validate paths against the resolved config dir and skip with a warning.
  it("skips a state_dir whose resolved path escapes the agent config dir (#5455 PRA-6)", () => {
    const { deps, runOpenshell } = buildDeps({
      loadAgent: vi.fn(() => ({
        configPaths: { dir: "/sandbox/.openclaw" },
        stateDirs: ["workspace", "../etc", "/etc/passwd"],
        stateFiles: [],
      })),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      destroy.wipeSandboxState("test-sb", deps as never);
      const { script } = execCommand(runOpenshell);
      // Legitimate target survives.
      expect(script).toContain("workspace");
      // Path escapes are NOT in the script.
      expect(script).not.toContain("../etc");
      expect(script).not.toContain("/etc/passwd");
      // Warns about each rejected path. The defense-in-depth validator
      // rejects `..` segments and absolute paths up front (before resolve),
      // so the warning quotes the manifest contract ("must be relative and
      // contain no '..' segments"), not the post-resolve "resolves outside"
      // boundary check.
      const warningCalls = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(warningCalls).toContain("../etc");
      expect(warningCalls).toContain("/etc/passwd");
      expect(warningCalls).toMatch(/must be relative|resolves outside/);
    } finally {
      warn.mockRestore();
    }
  });

  it("skips a state_file whose resolved path escapes the agent config dir (#5455 PRA-6)", () => {
    const { deps, runOpenshell } = buildDeps({
      loadAgent: vi.fn(() => ({
        configPaths: { dir: "/sandbox/.openclaw" },
        stateDirs: [],
        stateFiles: [
          { path: "agents.json" },
          { path: "../../../etc/shadow" },
          { path: "/root/.ssh/authorized_keys" },
        ],
      })),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      destroy.wipeSandboxState("test-sb", deps as never);
      const { script } = execCommand(runOpenshell);
      expect(script).toContain("agents.json");
      expect(script).not.toContain("../../../etc/shadow");
      expect(script).not.toContain("/root/.ssh/authorized_keys");
    } finally {
      warn.mockRestore();
    }
  });

  // PRA-7 #5455: regression coverage should prove the destroy/re-onboard
  // contract, not just helper-command construction. After a destroy, the
  // re-onboard must NOT inherit USER.md from the prior sandbox. The proof
  // here is that the wipe script targets workspace/ under the agent config
  // dir AND contains no path escape that could rm -rf outside it.
  it("targets workspace/ under the agent config dir and never contains a `..` escape (#5455 PRA-7)", () => {
    const { deps, runOpenshell } = buildDeps();

    destroy.wipeSandboxState("test-sb", deps as never);

    const { script } = execCommand(runOpenshell);
    // cd into the agent config dir before any rm -rf.
    expect(script).toMatch(/cd '[^']*\/sandbox\/\.openclaw'/);
    // The rm -rf phase must reach `workspace` (where USER.md lives).
    expect(script).toMatch(/rm\s+-rf\s+--[^\n]*workspace/);
    // Pull just the rm phase to assert on its targets in isolation; the
    // preceding `cd '<abs-path>'` legitimately contains the config dir.
    const rmPhase = script.split(/rm\s+-rf\s+--/)[1] ?? "";
    // No `..` segment in any path argument — would let rm -rf escape the cd.
    expect(rmPhase).not.toMatch(/\.\.\//);
    // No quoted absolute path argument either (would also escape the cd).
    expect(rmPhase).not.toMatch(/'\//);
  });
});
