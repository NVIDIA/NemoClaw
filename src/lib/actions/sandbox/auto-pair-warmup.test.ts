// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  RESTORED_CLONE_WARMUP_SCRIPT,
  sandboxWarmupExecArgs,
  WARMUP_PROBE_TIMEOUT_S,
  WARMUP_SCRIPT,
  WARMUP_TIMEOUT_MS,
} from "./auto-pair-warmup";
import { buildTrustedProxyEnvSourceShell } from "./trusted-proxy-env";
import { WARMUP_SESSION_ID_PREFIX } from "./warmup-session";

const shAvailable = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf-8" }).status === 0;
const itWithSh = shAvailable ? it : it.skip;

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
// the OpenShell-exec wrapping the leaf depends on — and the finalization tests
// pin the producer→observation→approval wiring.

describe("scope-upgrade warm-up timeout bound v2 (#4504)", () => {
  it("uses a fixed 30s outer cap so a wedged warm-up can never block onboard", () => {
    // The direct call performs no inference work. Thirty seconds covers gateway
    // connection, the scope-upgrade request, and shell startup while still
    // bounding a hung sandbox.
    expect(WARMUP_TIMEOUT_MS).toBe(30_000);
    expect(typeof WARMUP_TIMEOUT_MS).toBe("number");
    expect(WARMUP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(WARMUP_PROBE_TIMEOUT_S).toBe(5);
  });

  it("stays within the bounds the contract budgeted for finalization latency", () => {
    // The architect budgeted worst-case added finalization latency at the
    // warm-up cap (<=30s) plus the existing 15s approval pass. Guard that the
    // warm-up cap has not crept past its 30s ceiling — anything larger would
    // blow the budget the contract signed off on for a one-time onboard.
    expect(WARMUP_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("warm-up payload uses native multiline OpenShell exec in v2 (#4504)", () => {
  it("keeps the real warm-up as one multiline command on the owning gateway (#10014)", () => {
    expect(WARMUP_SCRIPT).toContain("\n");
    expect(WARMUP_SCRIPT).toContain("command -v openclaw");
    expect(WARMUP_SCRIPT).not.toContain("base64 -d");
    expect(WARMUP_SCRIPT).not.toContain("mktemp");
    expect(sandboxWarmupExecArgs("alpha", "nemoclaw-19000", WARMUP_SCRIPT)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "nemoclaw-19000",
      "--",
      "sh",
      "-c",
      WARMUP_SCRIPT,
    ]);
  });

  itWithSh("runs a multiline warm-up-shaped payload and preserves its exit-0 status", () => {
    // Mirror the real warm-up: the direct probe normally returns the pending
    // scope error, but its ignored status plus trailing exit 0 keep that expected
    // response from surfacing as an onboard command failure.
    const inner = ["false || true", "exit 0", ""].join("\n");
    const result = spawnSync("sh", ["-c", inner], { encoding: "utf-8", timeout: 10_000 });
    expect(result.status).toBe(0);
  });
});

describe("warm-up tags its throwaway session for user-facing filters (#5511)", () => {
  it("tags the provoke session with the shared warm-up prefix", () => {
    expect(WARMUP_SESSION_ID_PREFIX).toBe("nemoclaw-onboard-warmup-");
    expect(WARMUP_SCRIPT).toContain(
      `session_key="agent:main:${WARMUP_SESSION_ID_PREFIX}$$-$(date +%s)"`,
    );
  });

  it("uses a direct write-scope gateway call for restored clones (#7834)", () => {
    expect(RESTORED_CLONE_WARMUP_SCRIPT).toContain(
      'openclaw gateway call sessions.create --params "$params" --json',
    );
    expect(RESTORED_CLONE_WARMUP_SCRIPT).toContain(
      `session_key="agent:main:${WARMUP_SESSION_ID_PREFIX}$$-$(date +%s)"`,
    );
    expect(RESTORED_CLONE_WARMUP_SCRIPT).toContain("NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1");
    expect(RESTORED_CLONE_WARMUP_SCRIPT).toContain(
      "NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING || exit 0",
    );
    expect(RESTORED_CLONE_WARMUP_SCRIPT).not.toContain("openclaw agent");
  });

  itWithSh("keeps the restored-clone warm-up valid POSIX shell (#7834)", () => {
    const result = spawnSync("sh", ["-n"], {
      encoding: "utf-8",
      input: RESTORED_CLONE_WARMUP_SCRIPT,
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  itWithSh("uses clone device auth after sourcing restored-clone routing (#7834)", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-clone-warmup-"));
    const binDir = path.join(fixtureRoot, "bin");
    const proxyEnv = path.join(fixtureRoot, "proxy-env.sh");
    const callLog = path.join(fixtureRoot, "call.log");
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      proxyEnv,
      [
        "export OPENCLAW_GATEWAY_TOKEN=shared-token",
        "export OPENCLAW_GATEWAY_PASSWORD=shared-password",
        "export OPENCLAW_GATEWAY_PORT=18789",
        "",
      ].join("\n"),
      { mode: 0o444 },
    );
    fs.writeFileSync(
      path.join(binDir, "openclaw"),
      [
        "#!/bin/sh",
        "{",
        "  printf 'token=%s\\n' \"${OPENCLAW_GATEWAY_TOKEN-unset}\"",
        "  printf 'password=%s\\n' \"${OPENCLAW_GATEWAY_PASSWORD-unset}\"",
        "  printf 'port=%s\\n' \"${OPENCLAW_GATEWAY_PORT-unset}\"",
        "  printf 'force=%s\\n' \"${NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING-unset}\"",
        "  printf 'restored=%s\\n' \"${NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING-unset}\"",
        "  printf 'argv=%s\\n' \"$*\"",
        '} > "$NEMOCLAW_TEST_CALL_LOG"',
        "exit 23",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      expect(RESTORED_CLONE_WARMUP_SCRIPT).toContain(buildTrustedProxyEnvSourceShell());
      const script = RESTORED_CLONE_WARMUP_SCRIPT.replace(
        buildTrustedProxyEnvSourceShell(),
        buildTrustedProxyEnvSourceShell(proxyEnv),
      );
      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING: "1",
          NEMOCLAW_TEST_CALL_LOG: callLog,
          PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        },
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(callLog, "utf8")).toMatch(
        /^token=unset\npassword=unset\nport=18789\nforce=1\nrestored=unset\nargv=gateway call sessions\.create --params \{"key":"agent:main:nemoclaw-onboard-warmup-\d+-\d+","agentId":"main"\} --json\n$/,
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("scopes forced device pairing to the request producer on OpenClaw 2026.7.1", () => {
    expect(WARMUP_SCRIPT.match(/NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1/g)).toHaveLength(1);
    expect(WARMUP_SCRIPT).not.toContain("export NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING");
  });

  itWithSh(
    "bounds a hung direct request without polling pairing state (#10014)",
    () => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-warmup-timeout-"));
      const binDir = path.join(fixtureRoot, "bin");
      const callLog = path.join(fixtureRoot, "call.log");
      fs.mkdirSync(binDir);
      fs.writeFileSync(
        path.join(binDir, "openclaw"),
        [
          "#!/bin/sh",
          'printf \'%s\\n\' "$*" >> "$NEMOCLAW_TEST_CALL_LOG"',
          'if [ "${1:-}" = "gateway" ]; then',
          "  exec sleep 60",
          "fi",
          "exit 64",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );

      try {
        const result = spawnSync("sh", ["-c", WARMUP_SCRIPT], {
          encoding: "utf-8",
          env: {
            ...process.env,
            NEMOCLAW_TEST_CALL_LOG: callLog,
            PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          },
          timeout: 12_000,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(callLog, "utf8")).toMatch(
          /^gateway call sessions\.create --params \{"key":"agent:main:nemoclaw-onboard-warmup-\d+-\d+","agentId":"main"\} --json\n$/,
        );
        expect(fs.readFileSync(callLog, "utf8")).not.toContain("devices list");
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    20_000,
  );

  itWithSh("uses device auth after consuming the trusted proxy environment (#10014)", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-warmup-producer-"));
    const binDir = path.join(fixtureRoot, "bin");
    const proxyEnv = path.join(fixtureRoot, "proxy-env.sh");
    const sourceLog = path.join(fixtureRoot, "source.log");
    const callLog = path.join(fixtureRoot, "call.log");
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      proxyEnv,
      [
        "export OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789",
        "export OPENCLAW_GATEWAY_PORT=18789",
        "export OPENCLAW_GATEWAY_TOKEN=shared-token",
        "export OPENCLAW_GATEWAY_PASSWORD=shared-password",
        "export NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=ambient-force-marker",
        "export NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING=ambient-clone-marker",
        "export NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT=ambient-settlement-marker",
        'printf \'consumed\\n\' > "$NEMOCLAW_TEST_PROXY_SOURCE_LOG"',
        "",
      ].join("\n"),
      { mode: 0o444 },
    );
    fs.writeFileSync(
      path.join(binDir, "openclaw"),
        [
          "#!/bin/sh",
          "{",
          "  printf 'url=%s\\n' \"${OPENCLAW_GATEWAY_URL-unset}\"",
          "  printf 'port=%s\\n' \"${OPENCLAW_GATEWAY_PORT-unset}\"",
          "  printf 'token=%s\\n' \"${OPENCLAW_GATEWAY_TOKEN-unset}\"",
          "  printf 'password=%s\\n' \"${OPENCLAW_GATEWAY_PASSWORD-unset}\"",
          "  printf 'force=%s\\n' \"${NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING-unset}\"",
          "  printf 'restored=%s\\n' \"${NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING-unset}\"",
          "  printf 'settlement=%s\\n' \"${NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT-unset}\"",
          "  printf 'argv=%s\\n' \"$*\"",
          '} > "$NEMOCLAW_TEST_CALL_LOG"',
          "exit 1",
          "",
        ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const script = WARMUP_SCRIPT.replace(
        buildTrustedProxyEnvSourceShell(),
        buildTrustedProxyEnvSourceShell(proxyEnv),
      );
      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          NEMOCLAW_TEST_CALL_LOG: callLog,
          NEMOCLAW_TEST_PROXY_SOURCE_LOG: sourceLog,
          PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        },
        timeout: 10_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(sourceLog, "utf8")).toBe("consumed\n");
      expect(fs.readFileSync(callLog, "utf8")).toMatch(
        /^url=unset\nport=unset\ntoken=unset\npassword=unset\nforce=1\nrestored=unset\nsettlement=unset\nargv=gateway call sessions\.create --params \{"key":"agent:main:nemoclaw-onboard-warmup-\d+-\d+","agentId":"main"\} --json\n$/,
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsafe proxy source paths before a warm-up child can read credentials (#10014)", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-warmup-unsafe-proxy-"));
    const unsafeProxy = path.join(fixtureRoot, "proxy-env.sh");
    const evaluated = path.join(fixtureRoot, "evaluated");
    fs.writeFileSync(unsafeProxy, `printf evaluated > ${evaluated}\n`, { mode: 0o666 });

    try {
      const result = spawnSync(
        "sh",
        [
          "-c",
          WARMUP_SCRIPT.replace(
            buildTrustedProxyEnvSourceShell(),
            buildTrustedProxyEnvSourceShell(unsafeProxy),
          ),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: "inherited-secret" },
          timeout: 10_000,
        },
      );
      expect(result.status).toBe(126);
      expect(fs.existsSync(evaluated)).toBe(false);
      expect(result.stderr).not.toContain("inherited-secret");
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("uses a direct write-scope probe without an embedded inference fallback (#9844)", () => {
    expect(WARMUP_SCRIPT).not.toContain("openclaw agent");
    expect(WARMUP_SCRIPT).not.toContain("devices list");
    expect(WARMUP_SCRIPT).not.toContain("setsid");
    expect(WARMUP_SCRIPT).not.toContain("WARMUP_AGENT_PID");
    expect(WARMUP_SCRIPT).not.toContain("warmup_cleanup_attempt");
  });
});
