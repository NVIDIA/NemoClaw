// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { wrapSandboxShellScript } from "./auto-pair-approval";
import { WARMUP_SCRIPT, WARMUP_TIMEOUT_MS } from "./auto-pair-warmup";
import { WARMUP_SESSION_ID_PREFIX } from "./warmup-session";

// NOTE on coverage shape (#4504-v2): `runSandboxScopeWarmupRun` is not exercised
// in-process here. Like its sibling `runSandboxAutoPairApprovalPass`, the leaf
// lazily does a raw `require("../../adapters/openshell/runtime")` — a native
// CJS require of a relative `.ts` path that Vitest's module-mock registry does
// not intercept (mocking `node:child_process` to inspect the spawn args makes
// the source resolve that require through native Node, which then fails with
// "Cannot find module"). The same constraint is why
// `auto-pair-approval.test.ts` only unit-tests the pure exports and leaves the
// spawn/wiring path to the `test/sandbox-connect-inference/` integration
// harness (real compiled CLI + fake openshell on PATH). These cases therefore
// pin the contract surface that IS testable in-process — the timeout bound and
// the OpenShell-exec wrapping the leaf depends on — and the
// finalization.test.ts ordering tests pin the provoke→approve wiring.

describe("scope-upgrade warm-up timeout bound v2 (#4504)", () => {
  it("uses a fixed 30s outer cap so a wedged warm-up can never block onboard", () => {
    // The `-m "ping"` one-shot returns fast even when it falls back to embedded
    // mode; 30s covers gateway-connect + the scope-upgrade request plus
    // shell/agent startup while still bounding a hung sandbox. The constant is a
    // dependency-free export so this assertion stays in-process.
    expect(WARMUP_TIMEOUT_MS).toBe(30_000);
    expect(typeof WARMUP_TIMEOUT_MS).toBe("number");
    expect(WARMUP_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("stays within the bounds the contract budgeted for finalization latency", () => {
    // The architect budgeted worst-case added finalization latency at the
    // warm-up cap (<=30s) plus the existing 15s approval pass. Guard that the
    // warm-up cap has not crept past its 30s ceiling — anything larger would
    // blow the budget the contract signed off on for a one-time onboard.
    expect(WARMUP_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("warm-up payload survives OpenShell exec in v2 (#4504)", () => {
  // The leaf wraps its in-sandbox script with the shared `wrapSandboxShellScript`
  // (OpenShell exec rejects newline-bearing args). These cases pin that wrapper
  // contract — the exact mechanism the warm-up exec relies on — without needing
  // the un-mockable lazy require.
  it("encodes a multi-line warm-up-shaped payload onto a single newline-free line", () => {
    const warmupShaped = [
      "command -v openclaw >/dev/null 2>&1 || exit 0",
      'openclaw agent --agent main -m "ping" \\',
      `  --session-id "${WARMUP_SESSION_ID_PREFIX}$$-$(date +%s)" >/dev/null 2>&1 || true`,
      "exit 0",
      "",
    ].join("\n");
    const wrapped = wrapSandboxShellScript(warmupShaped);
    expect(wrapped).not.toMatch(/[\n\r]/);
    expect(wrapped).toContain("base64 -d");
    expect(wrapped).toContain("mktemp");
  });

  const shAvailable = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf-8" }).status === 0;
  const itWithSh = shAvailable ? it : it.skip;

  itWithSh("round-trips a warm-up-shaped payload and preserves its exit-0 status when run", () => {
    // Mirror the real warm-up: the provoke command itself may "fail" (the agent
    // falls back to embedded mode), but `|| true` + trailing `exit 0` mean the
    // wrapped script always exits 0 — so a failed provoke never surfaces as a
    // nonzero status to the onboard path. Use `false` to stand in for the failing
    // openclaw run.
    const inner = ["false || true", "exit 0", ""].join("\n");
    const wrapped = wrapSandboxShellScript(inner);
    const result = spawnSync("sh", ["-c", wrapped], { encoding: "utf-8", timeout: 10_000 });
    expect(result.status).toBe(0);
  });
});

describe("warm-up tags its throwaway session for user-facing filters (#5511)", () => {
  it("tags the provoke session with the shared warm-up prefix", () => {
    expect(WARMUP_SESSION_ID_PREFIX).toBe("nemoclaw-onboard-warmup-");
    expect(WARMUP_SCRIPT).toContain(`--session-id "${WARMUP_SESSION_ID_PREFIX}$$-$(date +%s)"`);
  });

  it("keeps the v2 provoke run foreground and within the original budget (#4504)", () => {
    expect(WARMUP_SCRIPT).toContain('openclaw agent --agent main -m "ping" \\');
    expect(WARMUP_SCRIPT).toContain(">/dev/null 2>&1 || true");
    expect(WARMUP_SCRIPT).not.toContain("setsid");
    expect(WARMUP_SCRIPT).not.toContain("WARMUP_AGENT_PID");
    expect(WARMUP_SCRIPT).not.toContain("warmup_cleanup_attempt");
  });
});
