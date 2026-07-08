// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractShellFunction,
  runHermesBashHarness as runBashHarness,
} from "./support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");
const SUPERVISOR_LIB = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "lib",
  "gateway-supervisor.sh",
);

function runHermesHealthyGatewayRecovery(integrityStatus: 0 | 1) {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  return runBashHarness([
    'trace() { printf "%s\\n" "$*"; }',
    "gateway_control_take_request() { GATEWAY_CONTROL_ACTION=recover; trace take-request; }",
    'gateway_control_pid_is_live() { trace "pid-live:$1"; return 0; }',
    "hermes_gateway_healthy() { trace gateway-healthy; return 0; }",
    "validate_running_hermes_boundary() { trace boundary-validation; return 0; }",
    `verify_hermes_config_integrity() { trace strict-integrity; return ${integrityStatus}; }`,
    "hermes_auxiliaries_need_recovery() { trace auxiliaries-needed; return 0; }",
    "seal_hermes_restart_inputs() { trace seal-inputs; return 0; }",
    "unseal_hermes_restart_inputs() { trace unseal-inputs; return 0; }",
    "ensure_hermes_supervised_auxiliaries() { trace auxiliaries; return 0; }",
    "refresh_hermes_supervised_child_pids() { trace refresh-child-pids; }",
    'gateway_control_complete() { trace "complete:$1:$2:$3"; }',
    'gateway_control_fail() { trace "fail:$1:$2"; }',
    'gateway_control_stop_tracked_pid() { trace "unexpected-stop:$1"; return 0; }',
    "mark_hermes_gateway_stopped() { trace unexpected-mark-stopped; }",
    extractShellFunction(source, "prepare_hermes_gateway_restart"),
    extractShellFunction(source, "handle_hermes_gateway_control_request"),
    "GATEWAY_PID=4242",
    "HERMES_RESTART_FAILURE_CODE=internal",
    'if handle_hermes_gateway_control_request; then trace "handler-rc:0"; else trace "handler-rc:$?"; fi',
  ]);
}

function runHermesGatewayProbe(opts: {
  prepareStatus: 0 | 1;
  healthStatus: 0 | 1;
  auxiliariesStatus: 0 | 1;
}) {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  return runBashHarness([
    'trace() { printf "%s\\n" "$*"; }',
    "gateway_control_take_request() { GATEWAY_CONTROL_ACTION=probe; trace take-request; }",
    `prepare_hermes_gateway_restart() { HERMES_RESTART_FAILURE_CODE=hash-mismatch; trace preflight; return ${opts.prepareStatus}; }`,
    'gateway_control_pid_is_live() { trace "pid-live:$1"; return 0; }',
    `hermes_gateway_healthy() { trace "gateway-healthy:$1"; return ${opts.healthStatus}; }`,
    `hermes_auxiliaries_need_recovery() { trace auxiliaries-check; return ${opts.auxiliariesStatus}; }`,
    'gateway_control_complete() { trace "complete:$1:$2:$3"; }',
    'gateway_control_fail() { trace "fail:$1:$2"; }',
    "seal_hermes_restart_inputs() { trace unexpected-seal; }",
    "unseal_hermes_restart_inputs() { trace unexpected-unseal; }",
    "ensure_hermes_supervised_auxiliaries() { trace unexpected-launch-auxiliaries; }",
    "stop_hermes_gateway_fail_closed() { trace unexpected-stop; }",
    "mark_hermes_gateway_stopped() { trace unexpected-mark-stopped; }",
    "kill() { trace unexpected-signal; }",
    extractShellFunction(source, "handle_hermes_gateway_control_request"),
    "GATEWAY_PID=4242",
    "HERMES_RESTART_FAILURE_CODE=internal",
    'if handle_hermes_gateway_control_request; then trace "handler-rc:0"; else trace "handler-rc:$?"; fi',
  ]);
}

function runHermesOrphanedSealCheck(opts: {
  sandboxMetadata: string;
  stateFileExists?: boolean;
  hashValid?: boolean;
}) {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  return runBashHarness(
    [
      'trace() { printf "%s\\n" "$*"; }',
      'stat() { if [ "${3:-}" = "/sandbox" ]; then printf "%s\\n" "$SANDBOX_METADATA"; return 0; fi; command stat "$@"; }',
      `verify_hermes_config_integrity() { trace verify-hash; return ${opts.hashValid === false ? 1 : 0}; }`,
      extractShellFunction(source, "hermes_restart_seal_orphaned"),
      'HERMES_RESTART_SEAL_STATE="$STATE_PATH"',
      "if hermes_restart_seal_orphaned; then trace orphaned; else trace normal; fi",
    ],
    (tmpDir) => {
      const statePath = path.join(tmpDir, "hermes-restart-seal.json");
      for (const _present of opts.stateFileExists ? [true] : []) {
        fs.writeFileSync(statePath, "fixture\n");
      }
      return { SANDBOX_METADATA: opts.sandboxMetadata, STATE_PATH: statePath };
    },
  );
}

function runHermesStartupReadiness(gatewayInitStatus: 0 | 1) {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  const start = source.indexOf("if ! gateway_control_init; then");
  const print = source.indexOf("print_dashboard_urls", start);
  const blockStart =
    start >= 0 && print >= 0
      ? start
      : (() => {
          throw new Error("Hermes root startup control block not found");
        })();
  const end = source.indexOf("\n", print);
  const block = source.slice(blockStart, end < 0 ? source.length : end);
  return runBashHarness([
    'trace() { printf "%s\\n" "$*"; }',
    `gateway_control_init() { trace gateway-control-init; return ${gatewayInitStatus}; }`,
    'HERMES_DIR="/sandbox/.hermes"',
    '_HERMES_PYTHON="hermes-python"',
    '_HERMES_RUNTIME_CONFIG_GUARD="runtime-guard"',
    'hermes-python() { printf "publish:%s\\n" "$*" >&2; return 0; }',
    "print_dashboard_urls() { trace dashboard-urls; }",
    block,
  ]);
}

describe("Hermes PID 1 supervisor recovery", () => {
  it("publishes startup readiness through isolated Python when gateway-control init fails", () => {
    const result = runHermesStartupReadiness(1);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["gateway-control-init", "dashboard-urls"]);
    expect(result.stderr).toContain(
      "publish:-I runtime-guard publish-startup-ready --hermes-dir /sandbox/.hermes --startup-owner",
    );
    expect(result.stderr).toContain("privileged gateway control unavailable");
  });

  it("validates the strict trust anchor before healthy-recover auxiliaries", () => {
    const result = runHermesHealthyGatewayRecovery(0);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "take-request",
      "pid-live:4242",
      "gateway-healthy",
      "boundary-validation",
      "strict-integrity",
      "auxiliaries-needed",
      "seal-inputs",
      "boundary-validation",
      "strict-integrity",
      "auxiliaries",
      "unseal-inputs",
      "refresh-child-pids",
      "complete:already-running:4242:4242",
      "handler-rc:0",
    ]);
  });

  it("does not start healthy-recover auxiliaries when strict validation fails", () => {
    const result = runHermesHealthyGatewayRecovery(1);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "take-request",
      "pid-live:4242",
      "gateway-healthy",
      "boundary-validation",
      "strict-integrity",
      "fail:hash-mismatch:4242",
      "handler-rc:1",
    ]);
    expect(result.stdout).not.toContain("auxiliaries");
  });

  it.each([
    {
      label: "reports the existing gateway and auxiliaries healthy",
      prepareStatus: 0 as const,
      healthStatus: 0 as const,
      auxiliariesStatus: 1 as const,
      expected: [
        "take-request",
        "preflight",
        "pid-live:4242",
        "gateway-healthy:4242",
        "auxiliaries-check",
        "complete:already-running:4242:4242",
        "handler-rc:0",
      ],
    },
    {
      label: "rejects failed preflight before checking processes",
      prepareStatus: 1 as const,
      healthStatus: 0 as const,
      auxiliariesStatus: 1 as const,
      expected: ["take-request", "preflight", "fail:hash-mismatch:4242", "handler-rc:1"],
    },
    {
      label: "reports an unhealthy gateway",
      prepareStatus: 0 as const,
      healthStatus: 1 as const,
      auxiliariesStatus: 1 as const,
      expected: [
        "take-request",
        "preflight",
        "pid-live:4242",
        "gateway-healthy:4242",
        "fail:health-timeout:4242",
        "handler-rc:1",
      ],
    },
    {
      label: "reports auxiliaries that need recovery",
      prepareStatus: 0 as const,
      healthStatus: 0 as const,
      auxiliariesStatus: 0 as const,
      expected: [
        "take-request",
        "preflight",
        "pid-live:4242",
        "gateway-healthy:4242",
        "auxiliaries-check",
        "fail:health-timeout:4242",
        "handler-rc:1",
      ],
    },
  ])("keeps the authenticated probe read-only when it $label", ({
    prepareStatus,
    healthStatus,
    auxiliariesStatus,
    expected,
  }) => {
    const result = runHermesGatewayProbe({ prepareStatus, healthStatus, auxiliariesStatus });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(expected);
    expect(result.stdout).not.toContain("unexpected-");
  });

  it("stops a healthy replacement gateway when the pending MCP applied-state commit fails", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "gateway_control_take_request() { GATEWAY_CONTROL_ACTION=restart; trace take-request; }",
      'prepare_hermes_gateway_restart() { prepare_calls=$((prepare_calls + 1)); trace "prepare:$prepare_calls"; return 0; }',
      "seal_hermes_restart_inputs() { trace seal-inputs; return 0; }",
      'hermes_stop_tracked_role() { trace "stop-old:$2"; return 0; }',
      "mark_hermes_gateway_stopped() { trace mark-stopped; GATEWAY_PID=0; }",
      "cleanup_sealed_hermes_gateway_runtime() { trace cleanup-runtime; return 0; }",
      'launch_hermes_gateway() { GATEWAY_PID=5252; trace "launch:$GATEWAY_PID"; return 0; }',
      'wait_for_hermes_gateway_internal() { trace "health:$1"; return 0; }',
      "ensure_hermes_supervised_auxiliaries() { trace auxiliaries; return 0; }",
      "unseal_hermes_restart_inputs() { trace unseal-inputs; return 0; }",
      "commit_hermes_mcp_applied_if_pending() { trace commit-applied; return 1; }",
      'stop_hermes_gateway_fail_closed() { trace "stop-fail-closed:$GATEWAY_PID"; GATEWAY_PID=0; }',
      'gateway_control_fail() { trace "fail:$1:$2"; }',
      'gateway_control_complete() { trace "unexpected-complete:$1:$2:$3"; }',
      "refresh_hermes_supervised_child_pids() { trace unexpected-refresh; }",
      extractShellFunction(source, "handle_hermes_gateway_control_request"),
      "INTERNAL_PORT=18642",
      "GATEWAY_PID=4242",
      "HERMES_RESTART_FAILURE_CODE=internal",
      "prepare_calls=0",
      'if handle_hermes_gateway_control_request; then trace "handler-rc:0"; else trace "handler-rc:$?"; fi',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "take-request",
      "prepare:1",
      "seal-inputs",
      "prepare:2",
      "stop-old:4242",
      "mark-stopped",
      "cleanup-runtime",
      "launch:5252",
      "health:5252",
      "auxiliaries",
      "unseal-inputs",
      "commit-applied",
      "stop-fail-closed:5252",
      "fail:mcp-integrity:4242",
      "handler-rc:1",
    ]);
    expect(result.stdout).not.toContain("unexpected-complete");
    expect(result.stdout).not.toContain("unexpected-refresh");
  });

  it("routes a secret-boundary refusal through whole-container gateway revocation", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "gateway_control_take_request() { GATEWAY_CONTROL_ACTION=restart; trace take-request; }",
      "prepare_hermes_gateway_restart() { HERMES_RESTART_FAILURE_CODE=secret-boundary-refusal; trace boundary-refusal; return 1; }",
      "stop_hermes_gateway_fail_closed() { trace fail-closed-stop; }",
      'gateway_control_fail() { trace "fail:$1:$2"; }',
      "mark_hermes_gateway_stopped() { trace unexpected-direct-mark; }",
      extractShellFunction(source, "hermes_restart_failure_revokes_gateway"),
      extractShellFunction(source, "handle_hermes_gateway_control_request"),
      "GATEWAY_PID=4242",
      "HERMES_RESTART_FAILURE_CODE=internal",
      'if handle_hermes_gateway_control_request; then trace "handler-rc:0"; else trace "handler-rc:$?"; fi',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "take-request",
      "boundary-refusal",
      "fail-closed-stop",
      "fail:secret-boundary-refusal:4242",
      "handler-rc:1",
    ]);
    expect(result.stdout).not.toContain("unexpected-direct-mark");
  });

  it("does not unseal or stop the gateway when a foreign config transaction owns restart state", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness(
      [
        'trace() { printf "%s\\n" "$*"; }',
        "install_hermes_restart_seal_traps() { trace install-traps; }",
        "restore_hermes_runtime_traps() { trace restore-traps; }",
        "unseal_hermes_restart_inputs() { trace unexpected-unseal; return 0; }",
        "stop_hermes_gateway_fail_closed() { trace unexpected-stop; }",
        extractShellFunction(source, "seal_hermes_restart_inputs"),
        '_HERMES_PYTHON="$FAKE_PYTHON"',
        '_HERMES_RUNTIME_CONFIG_GUARD="/trusted/runtime-config-guard.py"',
        'HERMES_DIR="/sandbox/.hermes"',
        'HERMES_HASH_FILE="/etc/nemoclaw/hermes.config-hash"',
        'HERMES_RESTART_SEAL_STATE="/run/nemoclaw/hermes-restart-seal.json"',
        'GATEWAY_CONTROL_NONCE="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        "HERMES_RESTART_FAILURE_CODE=internal",
        "HERMES_RESTART_SEALED=0",
        'if seal_hermes_restart_inputs; then trace unexpected-success; else trace "seal-failed:$HERMES_RESTART_SEALED"; fi',
        'if [ "$HERMES_RESTART_SEALED" -eq 1 ]; then stop_hermes_gateway_fail_closed; fi',
      ],
      (tmpDir) => {
        const fakePython = path.join(tmpDir, "python");
        fs.writeFileSync(
          fakePython,
          `#!/usr/bin/env bash
[ "$1" = "-I" ] || { echo "runtime guard did not use isolated Python" >&2; exit 98; }
[ "$2" = "/trusted/runtime-config-guard.py" ] || { echo "unexpected guard path: $2" >&2; exit 98; }
case "$3" in
  seal-restart) echo "Hermes config mutation is already in progress" >&2; exit 1 ;;
  inspect-mutation-owner) echo "state=1 lock=1 owner_active=1 token_match=0 original_locked=0 recovery_safe=1" ;;
  *) exit 99 ;;
esac
`,
          { mode: 0o700 },
        );
        return { FAKE_PYTHON: fakePython };
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "install-traps",
      "restore-traps",
      "seal-failed:0",
    ]);
    expect(result.stdout).not.toContain("unexpected-unseal");
    expect(result.stdout).not.toContain("unexpected-stop");
  });
});

describe("Hermes orphaned restart seal detection", () => {
  it("detects a frozen root-owned parent even when child sealing was only partial", () => {
    // Ownership changes before the final 0755 mode. A crash between those
    // syscalls leaves the original mutable mode but is still an orphaned seal.
    const result = runHermesOrphanedSealCheck({ sandboxMetadata: "0:0 770" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["verify-hash", "orphaned"]);
  });

  it("keeps the orphan classification when partial child state also fails hash validation", () => {
    const result = runHermesOrphanedSealCheck({
      sandboxMetadata: "0:0 755",
      hashValid: false,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["verify-hash", "orphaned"]);
    expect(result.stderr).toContain("Orphaned Hermes restart seal also failed strict hash");
  });

  it("does not infer an orphan when a recovery token exists or the parent is sandbox-owned", () => {
    const tokenPresent = runHermesOrphanedSealCheck({
      sandboxMetadata: "0:0 755",
      stateFileExists: true,
    });
    const mutableParent = runHermesOrphanedSealCheck({ sandboxMetadata: "1000:1000 770" });

    expect(tokenPresent.status, tokenPresent.stderr).toBe(0);
    expect(tokenPresent.stdout.trim()).toBe("normal");
    expect(mutableParent.status, mutableParent.stderr).toBe(0);
    expect(mutableParent.stdout.trim()).toBe("normal");
  });
});

describe("Hermes startup mutation ownership", () => {
  it("cold-resumes a pending 0500 shields clamp through recursive verification", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness(
      [
        'trace() { printf "%s\\n" "$*"; }',
        "install_hermes_restart_seal_traps() { trace unexpected-install-traps; }",
        "unseal_hermes_restart_inputs() { trace unexpected-unseal; return 0; }",
        extractShellFunction(source, "resume_startup_hermes_shields_lock"),
        extractShellFunction(source, "recover_startup_hermes_mutation"),
        '_HERMES_PYTHON="$FAKE_PYTHON"',
        '_HERMES_RUNTIME_CONFIG_GUARD="/trusted/runtime-config-guard.py"',
        "_HERMES_GUARD_TIMEOUT=()",
        'HERMES_DIR="/sandbox/.hermes"',
        'HERMES_HASH_FILE="/etc/nemoclaw/hermes.config-hash"',
        'HERMES_CONFIG_MUTATION_LOCK="$LOCK_PATH"',
        'HERMES_RESTART_SEAL_STATE="$STATE_PATH"',
        "if recover_startup_hermes_mutation; then trace recovered; else trace failed; fi",
        'cat "$TRACE_FILE"',
      ],
      (tmpDir) => {
        const statePath = path.join(tmpDir, "state.json");
        const lockPath = path.join(tmpDir, "lock");
        const traceFile = path.join(tmpDir, "trace");
        fs.writeFileSync(statePath, "state\n");
        fs.writeFileSync(lockPath, "lock\n");
        const fakePython = path.join(tmpDir, "python");
        fs.writeFileSync(
          fakePython,
          `#!/usr/bin/env bash
[ "$1" = "-I" ] || { echo "runtime guard did not use isolated Python" >&2; exit 98; }
[ "$2" = "/trusted/runtime-config-guard.py" ] || { echo "unexpected guard path: $2" >&2; exit 98; }
case "$3" in
  inspect-mutation-owner)
    echo inspect >>"$TRACE_FILE"
    echo "state=1 lock=1 owner_active=1 token_match=0 original_locked=0 recovery_safe=0 resumable_lock=1"
    ;;
  begin-shields-transition)
    echo begin >>"$TRACE_FILE"
    echo "lock_token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa original_locked=0"
    ;;
  run-state-dir-transition) echo state-lock >>"$TRACE_FILE" ;;
  apply-shields-transition) echo apply >>"$TRACE_FILE" ;;
  finish-shields-transition)
    echo finish >>"$TRACE_FILE"
    rm -f "$STATE_PATH" "$LOCK_PATH"
    ;;
  *) echo "unexpected action: $3" >&2; exit 99 ;;
esac
`,
          { mode: 0o700 },
        );
        return {
          FAKE_PYTHON: fakePython,
          STATE_PATH: statePath,
          LOCK_PATH: lockPath,
          TRACE_FILE: traceFile,
        };
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "recovered",
      "inspect",
      "begin",
      "state-lock",
      "apply",
      "finish",
    ]);
    expect(result.stderr).toContain("Resumed interrupted Hermes shields lock");
  });

  it("waits for a live host transaction to finish instead of consuming its state", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness(
      [
        'trace() { printf "%s\\n" "$*"; }',
        "install_hermes_restart_seal_traps() { trace unexpected-install-traps; }",
        "unseal_hermes_restart_inputs() { trace unexpected-unseal; return 0; }",
        extractShellFunction(source, "recover_startup_hermes_mutation"),
        '_HERMES_PYTHON="$FAKE_PYTHON"',
        '_HERMES_RUNTIME_CONFIG_GUARD="/trusted/runtime-config-guard.py"',
        'HERMES_DIR="/sandbox/.hermes"',
        'HERMES_CONFIG_MUTATION_LOCK="$LOCK_PATH"',
        'HERMES_RESTART_SEAL_STATE="$STATE_PATH"',
        "if recover_startup_hermes_mutation; then trace recovered; else trace failed; fi",
      ],
      (tmpDir) => {
        const statePath = path.join(tmpDir, "state.json");
        const lockPath = path.join(tmpDir, "lock");
        fs.writeFileSync(statePath, "state\n");
        fs.writeFileSync(lockPath, "lock\n");
        const fakePython = path.join(tmpDir, "python");
        fs.writeFileSync(
          fakePython,
          `#!/usr/bin/env bash
rm -f "$STATE_PATH" "$LOCK_PATH"
echo "state=1 lock=1 owner_active=1 token_match=0 original_locked=0 recovery_safe=1"
`,
          { mode: 0o700 },
        );
        return { FAKE_PYTHON: fakePython, STATE_PATH: statePath, LOCK_PATH: lockPath };
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("recovered");
    expect(result.stdout).not.toContain("unexpected-unseal");
  });

  it("fails closed instead of guessing how to recover an interrupted shields transition", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness(
      [
        'trace() { printf "%s\\n" "$*"; }',
        "install_hermes_restart_seal_traps() { trace unexpected-install-traps; }",
        "unseal_hermes_restart_inputs() { trace unexpected-unseal; return 0; }",
        extractShellFunction(source, "recover_startup_hermes_mutation"),
        '_HERMES_PYTHON="$FAKE_PYTHON"',
        '_HERMES_RUNTIME_CONFIG_GUARD="/trusted/runtime-config-guard.py"',
        'HERMES_DIR="/sandbox/.hermes"',
        'HERMES_CONFIG_MUTATION_LOCK="$LOCK_PATH"',
        'HERMES_RESTART_SEAL_STATE="$STATE_PATH"',
        "if recover_startup_hermes_mutation; then trace unexpected-success; else trace failed-closed; fi",
      ],
      (tmpDir) => {
        const statePath = path.join(tmpDir, "state.json");
        const lockPath = path.join(tmpDir, "lock");
        fs.writeFileSync(statePath, "state\n");
        fs.writeFileSync(lockPath, "lock\n");
        const fakePython = path.join(tmpDir, "python");
        fs.writeFileSync(
          fakePython,
          '#!/usr/bin/env bash\necho "state=1 lock=1 owner_active=0 token_match=0 original_locked=1 recovery_safe=0"\n',
          { mode: 0o700 },
        );
        return { FAKE_PYTHON: fakePython, STATE_PATH: statePath, LOCK_PATH: lockPath };
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("failed-closed");
    expect(result.stdout).not.toContain("unexpected-unseal");
    expect(result.stderr).toContain("HERMES_CONFIG_MUTATION_ORPHANED");
  });
});

describe("Hermes supervised auxiliary recovery", () => {
  it("rejects public health from a relay that loses its tracked identity during the probe", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "CHECKS=0",
      'hermes_socat_bridge_healthy() { CHECKS=$((CHECKS + 1)); trace "identity-check:$CHECKS"; [ "$CHECKS" -eq 1 ]; }',
      'curl() { printf "200"; }',
      extractShellFunction(source, "hermes_api_socat_bridge_healthy"),
      "if hermes_api_socat_bridge_healthy 101 8642; then trace unsafe-success; else trace refused; fi",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "identity-check:1",
      "identity-check:2",
      "refused",
    ]);
  });

  it("re-prepares runtime inputs and retries a refused non-root gateway respawn", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      'hermes_tracked_role_is_current() { case "$2" in 5252) tracked_5252=$((tracked_5252 + 1)); [ "$tracked_5252" -le 2 ] ;; 6262) tracked_6262=$((tracked_6262 + 1)); [ "$tracked_6262" -le 2 ] || { trace "supervised:$2"; exit 0; } ;; *) return 1 ;; esac; }',
      'wait() { trace "wait:$1"; return 143; }',
      "mark_hermes_gateway_stopped() { trace mark-stopped; GATEWAY_PID=0; }",
      "hermes_managed_gateway_exit_was_host_authorized() { return 1; }",
      'date() { printf "100\\n"; }',
      "sleep() { :; }",
      "prepare_calls=0",
      "launch_calls=0",
      'prepare_hermes_nonroot_runtime() { prepare_calls=$((prepare_calls + 1)); trace "prepare:$prepare_calls"; [ "$prepare_calls" -ne 2 ]; }',
      'launch_hermes_gateway_current_user() { launch_calls=$((launch_calls + 1)); [ "$launch_calls" -eq 1 ] && GATEWAY_PID=5252 || GATEWAY_PID=6262; trace "launch:$GATEWAY_PID"; }',
      'wait_for_hermes_gateway_internal() { trace "health:$1"; }',
      "ensure_hermes_supervised_auxiliaries() { trace auxiliaries; }",
      "commit_hermes_mcp_applied_if_pending() { return 0; }",
      'refresh_hermes_supervised_child_pids() { trace "refresh:$GATEWAY_PID"; }',
      "hermes_gateway_healthy() { return 0; }",
      'hermes_stop_tracked_role() { trace "unexpected-stop:$2"; return 1; }',
      extractShellFunction(source, "quarantine_hermes_managed_gateway_relaunch"),
      extractShellFunction(source, "record_hermes_managed_gateway_exit"),
      extractShellFunction(source, "recover_hermes_gateway_current_user"),
      extractShellFunction(source, "supervise_hermes_gateway_current_user"),
      "INTERNAL_PORT=18642",
      "HERMES_MANAGED_GATEWAY_EXIT_TIMES=()",
      "HERMES_MANAGED_GATEWAY_EXIT_COUNT=0",
      "tracked_5252=0",
      "tracked_6262=0",
      "GATEWAY_PID=4242",
      "supervise_hermes_gateway_current_user",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "wait:4242",
      "mark-stopped",
      "prepare:1",
      "launch:5252",
      "health:5252",
      "auxiliaries",
      "refresh:5252",
      "wait:5252",
      "mark-stopped",
      "prepare:2",
      "prepare:3",
      "launch:6262",
      "health:6262",
      "auxiliaries",
      "refresh:6262",
      "supervised:6262",
    ]);
    expect(result.stderr).toContain("Hermes gateway respawned (pid 5252)");
  });

  it("quarantines after five gateway exits in one minute without a sixth launch", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "hermes_tracked_role_is_current() { return 1; }",
      'wait() { trace "wait:$1"; return 137; }',
      "mark_hermes_gateway_stopped() { GATEWAY_PID=0; }",
      "hermes_managed_gateway_exit_was_host_authorized() { return 1; }",
      'date() { printf "100\\n"; }',
      'sleep() { [ "$1" = "60" ] && { trace quarantine; exit 0; }; }',
      'recover_hermes_gateway_current_user() { recover_calls=$((recover_calls + 1)); GATEWAY_PID=$((5000 + recover_calls)); trace "recover:$GATEWAY_PID"; }',
      "recover_calls=0",
      extractShellFunction(source, "quarantine_hermes_managed_gateway_relaunch"),
      extractShellFunction(source, "record_hermes_managed_gateway_exit"),
      extractShellFunction(source, "supervise_hermes_gateway_current_user"),
      "INTERNAL_PORT=18642",
      "HERMES_MANAGED_GATEWAY_EXIT_TIMES=()",
      "HERMES_MANAGED_GATEWAY_EXIT_COUNT=0",
      "GATEWAY_PID=4242",
      "supervise_hermes_gateway_current_user",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/^recover:/gm)).toHaveLength(4);
    expect(result.stdout).toContain("recover:5004");
    expect(result.stdout).not.toContain("recover:5005");
    expect(result.stdout).toContain("quarantine");
    expect(result.stderr).toContain("relaunch is quarantined until sandbox recreation");
  });

  it("counts repeated gateway health failures and never launches a sixth candidate", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "prepare_hermes_nonroot_runtime() { return 0; }",
      'launch_hermes_gateway_current_user() { launch_calls=$((launch_calls + 1)); GATEWAY_PID=$((6000 + launch_calls)); trace "launch:$GATEWAY_PID"; }',
      "wait_for_hermes_gateway_internal() { return 1; }",
      "ensure_hermes_supervised_auxiliaries() { trace unexpected-auxiliary; return 0; }",
      'hermes_stop_tracked_role() { trace "stop:$2"; return 0; }',
      "mark_hermes_gateway_stopped() { GATEWAY_PID=0; }",
      "refresh_hermes_supervised_child_pids() { :; }",
      'date() { printf "100\\n"; }',
      'sleep() { [ "$1" = "60" ] && { trace quarantine; exit 0; }; }',
      extractShellFunction(source, "quarantine_hermes_managed_gateway_relaunch"),
      extractShellFunction(source, "record_hermes_managed_gateway_exit"),
      extractShellFunction(source, "recover_hermes_gateway_current_user"),
      "INTERNAL_PORT=18642",
      "HERMES_MANAGED_GATEWAY_EXIT_TIMES=()",
      "HERMES_MANAGED_GATEWAY_EXIT_COUNT=0",
      "launch_calls=0",
      "recover_hermes_gateway_current_user",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/^launch:/gm)).toHaveLength(5);
    expect(result.stdout).toContain("launch:6005");
    expect(result.stdout).not.toContain("launch:6006");
    expect(result.stdout.match(/^stop:/gm)).toHaveLength(5);
    expect(result.stdout).toContain("quarantine");
    expect(result.stderr).toContain("5 exits in 60s window");
    expect(result.stdout).not.toContain("unexpected-auxiliary");
  });

  it("does not count preparation refusals or launch before preparation succeeds", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      'prepare_hermes_nonroot_runtime() { prepare_calls=$((prepare_calls + 1)); trace "prepare:$prepare_calls"; [ "$prepare_calls" -ge 3 ]; }',
      'launch_hermes_gateway_current_user() { launch_calls=$((launch_calls + 1)); GATEWAY_PID=7001; trace "launch:$GATEWAY_PID"; }',
      "wait_for_hermes_gateway_internal() { return 0; }",
      "hermes_tracked_role_is_current() { return 0; }",
      "hermes_gateway_healthy() { return 0; }",
      "ensure_hermes_supervised_auxiliaries() { return 0; }",
      "commit_hermes_mcp_applied_if_pending() { return 0; }",
      "refresh_hermes_supervised_child_pids() { trace refresh; }",
      'date() { trace unexpected-exit-record; printf "100\\n"; }',
      'sleep() { trace "sleep:$1"; }',
      extractShellFunction(source, "quarantine_hermes_managed_gateway_relaunch"),
      extractShellFunction(source, "record_hermes_managed_gateway_exit"),
      extractShellFunction(source, "recover_hermes_gateway_current_user"),
      "INTERNAL_PORT=18642",
      "HERMES_MANAGED_GATEWAY_EXIT_TIMES=()",
      "HERMES_MANAGED_GATEWAY_EXIT_COUNT=0",
      "prepare_calls=0",
      "launch_calls=0",
      "recover_hermes_gateway_current_user",
      'trace "launch-count:$launch_calls"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "prepare:1",
      "sleep:5",
      "prepare:2",
      "sleep:5",
      "prepare:3",
      "launch:7001",
      "refresh",
      "launch-count:1",
    ]);
    expect(result.stdout).not.toContain("unexpected-exit-record");
  });

  it("keeps the initial non-root supervisor alive and recovers a failed first child", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      'launch_hermes_gateway_current_user() { GATEWAY_PID=4100; trace "launch:$GATEWAY_PID"; }',
      "start_gateway_log_stream() { trace log-stream; }",
      'refresh_hermes_supervised_child_pids() { trace "refresh:$GATEWAY_PID"; }',
      "wait_for_hermes_gateway_internal() { trace initial-health-failed; return 1; }",
      "ensure_hermes_supervised_auxiliaries() { trace unexpected-auxiliaries; return 0; }",
      'hermes_stop_tracked_role() { trace "stop:$2"; return 0; }',
      "mark_hermes_gateway_stopped() { trace mark-stopped; GATEWAY_PID=0; }",
      'recover_hermes_gateway_current_user() { GATEWAY_PID=4200; trace "recover:$GATEWAY_PID"; }',
      'date() { printf "100\\n"; }',
      'sleep() { trace "sleep:$1"; }',
      extractShellFunction(source, "quarantine_hermes_managed_gateway_relaunch"),
      extractShellFunction(source, "record_hermes_managed_gateway_exit"),
      extractShellFunction(source, "bootstrap_hermes_gateway_current_user"),
      "INTERNAL_PORT=18642",
      "HERMES_MANAGED_GATEWAY_EXIT_TIMES=()",
      "HERMES_MANAGED_GATEWAY_EXIT_COUNT=0",
      "bootstrap_hermes_gateway_current_user",
      'trace "final:$GATEWAY_PID"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "launch:4100",
      "log-stream",
      "refresh:4100",
      "initial-health-failed",
      "stop:4100",
      "mark-stopped",
      "sleep:2",
      "recover:4200",
      "refresh:4200",
      "final:4200",
    ]);
    expect(result.stdout).not.toContain("unexpected-auxiliaries");
    expect(result.stderr).toContain("stopping the exact child for supervised recovery");
  });

  it("quarantines instead of orphaning an unhealthy child whose exact stop fails", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "hermes_tracked_role_is_current() { return 0; }",
      'hermes_gateway_healthy() { health_calls=$((health_calls + 1)); trace "unhealthy:$health_calls"; return 1; }',
      "ensure_hermes_supervised_auxiliaries() { trace unexpected-auxiliaries; }",
      "refresh_hermes_supervised_child_pids() { :; }",
      'hermes_stop_tracked_role() { trace "stop-refused:$2"; return 1; }',
      'sleep() { [ "$1" = "60" ] && { trace quarantine; exit 0; }; }',
      'wait() { trace "unexpected-wait:$1"; }',
      "recover_hermes_gateway_current_user() { trace unexpected-recover; }",
      extractShellFunction(source, "quarantine_hermes_managed_gateway_relaunch"),
      extractShellFunction(source, "supervise_hermes_gateway_current_user"),
      "INTERNAL_PORT=18642",
      "GATEWAY_PID=4242",
      "health_calls=0",
      "supervise_hermes_gateway_current_user",
      "trace unexpected-return",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "unhealthy:1",
      "unhealthy:2",
      "unhealthy:3",
      "unhealthy:4",
      "stop-refused:4242",
      "quarantine",
    ]);
    expect(result.stderr).toContain("managed supervisor is quarantined without another launch");
    expect(result.stdout).not.toContain("unexpected-wait");
    expect(result.stdout).not.toContain("unexpected-recover");
    expect(result.stdout).not.toContain("unexpected-return");
  });

  it("refreshes exact role identities and clears a stale gateway wait PID before cleanup", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "refresh_hermes_supervised_child_pids() { trace refresh-identities; SANDBOX_CHILD_PIDS=(202); }",
      "hermes_tracked_role_is_current() { trace gateway-identity-mismatch; return 1; }",
      'cleanup_on_signal() { trace "cleanup:wait=${SANDBOX_WAIT_PID:-}:children=${SANDBOX_CHILD_PIDS[*]:-}"; }',
      'id() { [ "${1:-}" = "-u" ] && printf "0\\n"; }',
      extractShellFunction(source, "hermes_cleanup_on_signal"),
      "GATEWAY_PID=4242",
      "INTERNAL_PORT=18642",
      "SANDBOX_WAIT_PID=4242",
      "SANDBOX_CHILD_PIDS=(4242 202)",
      "hermes_cleanup_on_signal",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "refresh-identities",
      "gateway-identity-mismatch",
      "cleanup:wait=:children=202",
    ]);
  });

  it("binds a tracked role to the startup supervisor parent, effective uid, cmdline, and start time", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness(
      [
        'trace() { printf "%s\\n" "$*"; }',
        "gateway_control_pid_is_live() { return 0; }",
        'hermes_expected_service_uid() { printf "1000"; }',
        extractShellFunction(source, "hermes_process_start_identity"),
        extractShellFunction(source, "hermes_process_role_identity"),
        '_HERMES_PROC_ROOT="$PROC_ROOT"',
        "HERMES_STARTUP_SUPERVISOR_PID=77",
        'identity="$(hermes_process_role_identity dashboard 4242 sandbox 19119)"',
        'trace "valid:$identity"',
        'cp "$BAD_STAT" "$PROC_ROOT/4242/stat"',
        "if hermes_process_role_identity dashboard 4242 sandbox 19119 >/dev/null; then trace unexpected-ppid; else trace rejected-ppid; fi",
        'cp "$GOOD_STAT" "$PROC_ROOT/4242/stat"',
        'printf "socat\\0TCP-LISTEN:19119,bind=0.0.0.0\\0" >"$PROC_ROOT/4242/cmdline"',
        "if hermes_process_role_identity dashboard 4242 sandbox 19119 >/dev/null; then trace unexpected-role; else trace rejected-role; fi",
      ],
      (tmpDir) => {
        const procRoot = path.join(tmpDir, "proc");
        const pidRoot = path.join(procRoot, "4242");
        fs.mkdirSync(pidRoot, { recursive: true });
        const makeStat = (ppid: number) =>
          `4242 (hermes dashboard) ${["S", String(ppid), ...Array(17).fill("0"), "777"].join(" ")}\n`;
        const goodStat = path.join(tmpDir, "good.stat");
        const badStat = path.join(tmpDir, "bad.stat");
        fs.writeFileSync(goodStat, makeStat(77));
        fs.writeFileSync(badStat, makeStat(1));
        fs.copyFileSync(goodStat, path.join(pidRoot, "stat"));
        fs.writeFileSync(path.join(pidRoot, "status"), "Uid:\t1000\t1000\t1000\t1000\n");
        fs.writeFileSync(
          path.join(pidRoot, "cmdline"),
          Buffer.from(["/usr/local/bin/hermes", "dashboard", "--port", "19119", ""].join("\0")),
        );
        return { PROC_ROOT: procRoot, GOOD_STAT: goodStat, BAD_STAT: badStat };
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "valid:777",
      "rejected-ppid",
      "rejected-role",
    ]);
  });

  it("refuses to forget or signal a live PID whose start identity was reused", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "hermes_tracked_role_is_current() { trace identity-mismatch; return 1; }",
      'hermes_process_start_identity() { printf "new-start-time"; }',
      'gateway_control_stop_tracked_pid() { trace "unexpected-signal:$1"; return 0; }',
      'wait() { trace "unexpected-wait:$1"; return 0; }',
      extractShellFunction(source, "hermes_role_identity_value"),
      extractShellFunction(source, "hermes_set_role_identity"),
      extractShellFunction(source, "hermes_stop_tracked_role"),
      'GATEWAY_PID_START_IDENTITY="old-start-time"',
      "rc=0; hermes_stop_tracked_role gateway 4242 gateway 18642 || rc=$?",
      'trace "rc:$rc"',
      'trace "identity:${GATEWAY_PID_START_IDENTITY:-cleared}"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "identity-mismatch",
      "rc:1",
      "identity:old-start-time",
    ]);
    expect(result.stderr).toContain("was reused");
    expect(result.stdout).not.toContain("unexpected-signal");
    expect(result.stdout).not.toContain("unexpected-wait");
  });

  it("forgets a tracked child only after proving the numeric PID is gone", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "hermes_tracked_role_is_current() { trace role-gone; return 1; }",
      "hermes_process_start_identity() { return 1; }",
      'kill() { [ "$1" = "-0" ] && return 1; trace "unexpected-signal:$*"; }',
      'gateway_control_stop_tracked_pid() { trace "unexpected-stop:$1"; return 0; }',
      extractShellFunction(source, "hermes_role_identity_value"),
      extractShellFunction(source, "hermes_set_role_identity"),
      extractShellFunction(source, "hermes_stop_tracked_role"),
      'GATEWAY_PID_START_IDENTITY="old-start-time"',
      "hermes_stop_tracked_role gateway 4242 gateway 18642",
      'trace "identity:${GATEWAY_PID_START_IDENTITY:-cleared}"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["role-gone", "identity:cleared"]);
    expect(result.stdout).not.toContain("unexpected-signal");
    expect(result.stdout).not.toContain("unexpected-stop");
  });

  it("passes the captured start identity through every tracked stop", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      'hermes_role_identity_value() { printf "777"; }',
      "hermes_tracked_role_is_current() { return 0; }",
      'gateway_control_stop_tracked_pid() { trace "stop:$1:$2"; }',
      'kill() { [ "$1" = "-0" ] && return 1; trace "unexpected-signal:$*"; }',
      'hermes_set_role_identity() { trace "clear:$1:$2"; }',
      extractShellFunction(source, "hermes_stop_tracked_role"),
      "hermes_stop_tracked_role gateway 4242 gateway 18642",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("stop:4242:777\nclear:gateway:\n");
    expect(result.stdout).not.toContain("unexpected-signal");
  });

  it("does not accept a tracked-stop success while the numeric PID remains live", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      'hermes_role_identity_value() { printf "777"; }',
      "hermes_tracked_role_is_current() { return 0; }",
      'gateway_control_stop_tracked_pid() { trace "stop:$1:$2"; return 0; }',
      'kill() { [ "$1" = "-0" ] && return 0; trace "unexpected-signal:$*"; }',
      'hermes_set_role_identity() { trace "unexpected-clear:$1:$2"; }',
      extractShellFunction(source, "hermes_stop_tracked_role"),
      "rc=0; hermes_stop_tracked_role gateway 4242 gateway 18642 || rc=$?",
      'trace "rc:$rc"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["stop:4242:777", "rc:1"]);
    expect(result.stderr).toContain("remains live after tracked stop");
    expect(result.stdout).not.toContain("unexpected-clear");
    expect(result.stdout).not.toContain("unexpected-signal");
  });

  it("does not signal a launched child whose role identity was never proven", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "tail() { :; }",
      "sed() { :; }",
      "hermes_capture_tracked_role() { return 1; }",
      'gateway_control_stop_tracked_pid() { trace "unexpected-signal:$1"; }',
      extractShellFunction(source, "hermes_fatal_unproven_child"),
      extractShellFunction(source, "start_gateway_log_stream"),
      "HERMES_STARTUP_SUPERVISOR_PID=1",
      "start_gateway_log_stream",
      "trace unexpected-return",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed exact role identity capture");
    expect(result.stderr).toContain("exiting PID 1");
    expect(result.stdout).not.toContain("unexpected-signal");
    expect(result.stdout).not.toContain("unexpected-return");
  });

  it("quarantines a managed supervisor until an unproven direct child is reaped", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      'wait() { trace "wait:$1"; return 143; }',
      'sleep() { trace "quarantine-sleep:$1"; exit 0; }',
      'kill() { trace "unexpected-signal:$*"; return 1; }',
      extractShellFunction(source, "hermes_fatal_unproven_child"),
      "HERMES_STARTUP_SUPERVISOR_PID=77",
      "hermes_fatal_unproven_child gateway 4242",
      "trace unexpected-return",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["wait:4242", "quarantine-sleep:60"]);
    expect(result.stderr).toContain("quarantining the managed startup supervisor");
    expect(result.stderr).toContain("remains quarantined until sandbox recreation");
    expect(result.stdout).not.toContain("unexpected-signal");
    expect(result.stdout).not.toContain("unexpected-return");
  });

  it("refuses to reap a live recycled gateway PID", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "GATEWAY_PID=4242",
      'GATEWAY_PID_START_IDENTITY="777"',
      'hermes_process_start_identity() { printf "888"; }',
      "gateway_control_pid_is_live() { return 0; }",
      'wait() { trace "unexpected-wait:$1"; }',
      "mark_hermes_gateway_stopped() { trace unexpected-mark; }",
      extractShellFunction(source, "hermes_reap_exited_gateway"),
      "rc=0; hermes_reap_exited_gateway || rc=$?",
      'trace "rc:$rc"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("rc:2\n");
    expect(result.stderr).toContain("refusing to poll or reap it");
    expect(result.stdout).not.toContain("unexpected-wait");
    expect(result.stdout).not.toContain("unexpected-mark");
  });

  it("refuses to wait on a live gateway when role proof becomes unavailable", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "GATEWAY_PID=4242",
      'GATEWAY_PID_START_IDENTITY="777"',
      'hermes_process_start_identity() { printf "777"; }',
      'kill() { [ "$1" = "-0" ] && return 0; trace "unexpected-signal:$*"; }',
      'gateway_control_pid_state() { printf "S"; }',
      'wait() { trace "unexpected-wait:$1"; }',
      "mark_hermes_gateway_stopped() { trace unexpected-mark; }",
      "GATEWAY_CONTROL_SIGNAL_PENDING=0",
      extractShellFunction(source, "hermes_reap_exited_gateway"),
      "rc=0; hermes_reap_exited_gateway || rc=$?",
      'trace "rc:$rc"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("rc:2\n");
    expect(result.stderr).toContain("cannot be proven exited");
    expect(result.stdout).not.toContain("unexpected-wait");
    expect(result.stdout).not.toContain("unexpected-mark");
  });

  it("reaps only an exact matching zombie gateway", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "GATEWAY_PID=4242",
      'GATEWAY_PID_START_IDENTITY="777"',
      'hermes_process_start_identity() { printf "777"; }',
      'kill() { [ "$1" = "-0" ] && return 0; trace "unexpected-signal:$*"; }',
      'gateway_control_pid_state() { printf "Z"; }',
      'wait() { trace "wait:$1"; return 7; }',
      "mark_hermes_gateway_stopped() { trace mark-stopped; }",
      "GATEWAY_CONTROL_SIGNAL_PENDING=0",
      extractShellFunction(source, "hermes_reap_exited_gateway"),
      "rc=0; hermes_reap_exited_gateway || rc=$?",
      'trace "rc:$rc"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["wait:4242", "mark-stopped", "rc:0"]);
    expect(result.stderr).toContain("exited (rc=7)");
    expect(result.stdout).not.toContain("unexpected-signal");
  });

  it("defers reaping a still-proven gateway to a pending authenticated request", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "GATEWAY_PID=4242",
      'GATEWAY_PID_START_IDENTITY="777"',
      'hermes_process_start_identity() { printf "777"; }',
      'kill() { [ "$1" = "-0" ] && return 0; trace "unexpected-signal:$*"; }',
      'gateway_control_pid_state() { printf "S"; }',
      "hermes_tracked_role_is_current() { return 0; }",
      'wait() { trace "unexpected-wait:$1"; }',
      "mark_hermes_gateway_stopped() { trace unexpected-mark; }",
      "GATEWAY_CONTROL_SIGNAL_PENDING=1",
      'INTERNAL_PORT="18642"',
      extractShellFunction(source, "hermes_reap_exited_gateway"),
      "rc=0; hermes_reap_exited_gateway || rc=$?",
      'trace "rc:$rc"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("rc:3\n");
    expect(result.stdout).not.toContain("unexpected-wait");
    expect(result.stdout).not.toContain("unexpected-mark");
  });

  it("exits PID 1 instead of marking an unproven gateway stopped", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      "hermes_stop_tracked_role() { trace stop-refused; return 1; }",
      "mark_hermes_gateway_stopped() { trace unexpected-mark; }",
      extractShellFunction(source, "stop_hermes_gateway_fail_closed"),
      "GATEWAY_PID=4242",
      'INTERNAL_PORT="18642"',
      "stop_hermes_gateway_fail_closed",
      "trace unexpected-return",
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("stop-refused\n");
    expect(result.stderr).toContain("exiting PID 1 for whole-container cleanup");
    expect(result.stdout).not.toContain("unexpected-mark");
    expect(result.stdout).not.toContain("unexpected-return");
  });

  it("replaces a live but listener-less reused dashboard PID and its stale bridge", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      'id() { [ "${1:-}" = "-u" ] && printf "0\\n"; }',
      'gateway_control_pid_is_live() { trace "live:$1"; return 0; }',
      'hermes_tracked_role_is_current() { gateway_control_pid_is_live "$2"; }',
      'gateway_control_pid_owns_tcp_listener() { trace "listener:$1:$2"; [ "$1:$2" = "101:8642" ] || [ "$1:$2" = "303:18789" ]; }',
      'hermes_tracked_service_owns_listener() { trace "service-listener:$1:$2:$3"; return 1; }',
      'curl() { printf "200"; }',
      'hermes_stop_tracked_role() { trace "stop:$2"; return 0; }',
      "start_hermes_dashboard_sandbox_user() { trace start-dashboard; DASHBOARD_PID=404; DASHBOARD_SOCAT_PID=505; }",
      'start_socat_forwarder() { trace "start-forward:$*"; return 0; }',
      "ensure_gateway_log_stream() { trace gateway-log; }",
      extractShellFunction(source, "hermes_socat_bridge_healthy"),
      extractShellFunction(source, "hermes_api_socat_bridge_healthy"),
      extractShellFunction(source, "hermes_dashboard_healthy"),
      extractShellFunction(source, "ensure_hermes_supervised_auxiliaries"),
      "PUBLIC_PORT=8642",
      "INTERNAL_PORT=18642",
      "DASHBOARD_PUBLIC_PORT=18789",
      "DASHBOARD_INTERNAL_PORT=19119",
      "SOCAT_PID=101",
      "DASHBOARD_PID=202",
      "DASHBOARD_SOCAT_PID=303",
      "GATEWAY_PID=4242",
      'if ensure_hermes_supervised_auxiliaries; then trace success; else trace "failure:$?"; fi',
      'trace "final-dashboard:$DASHBOARD_PID"',
      'trace "final-bridge:$DASHBOARD_SOCAT_PID"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "live:101",
      "listener:101:8642",
      "live:101",
      "listener:101:8642",
      "live:101",
      "listener:101:8642",
      "live:202",
      "service-listener:202:19119:sandbox",
      "stop:303",
      "stop:202",
      "start-dashboard",
      "gateway-log",
      "success",
      "final-dashboard:404",
      "final-bridge:505",
    ]);
  });

  it("replaces a live API bridge PID that owns no public listener", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      'id() { [ "${1:-}" = "-u" ] && printf "0\\n"; }',
      'gateway_control_pid_is_live() { trace "live:$1"; return 0; }',
      'hermes_tracked_role_is_current() { gateway_control_pid_is_live "$2"; }',
      'gateway_control_pid_owns_tcp_listener() { trace "listener:$1:$2"; [ "$1:$2" != "101:8642" ]; }',
      "hermes_tracked_service_owns_listener() { return 0; }",
      'curl() { printf "200"; }',
      'hermes_stop_tracked_role() { trace "stop:$2"; return 0; }',
      'start_socat_forwarder() { trace "start-forward:$*"; printf -v "$4" 111; return 0; }',
      "start_hermes_dashboard_sandbox_user() { trace unexpected-dashboard-start; return 1; }",
      "ensure_gateway_log_stream() { trace gateway-log; }",
      extractShellFunction(source, "hermes_socat_bridge_healthy"),
      extractShellFunction(source, "hermes_api_socat_bridge_healthy"),
      extractShellFunction(source, "hermes_dashboard_healthy"),
      extractShellFunction(source, "ensure_hermes_supervised_auxiliaries"),
      "PUBLIC_PORT=8642",
      "INTERNAL_PORT=18642",
      "DASHBOARD_PUBLIC_PORT=18789",
      "DASHBOARD_INTERNAL_PORT=19119",
      "SOCAT_PID=101",
      "DASHBOARD_PID=202",
      "DASHBOARD_SOCAT_PID=303",
      "GATEWAY_PID=4242",
      'if ensure_hermes_supervised_auxiliaries; then trace success; else trace "failure:$?"; fi',
      'trace "final-api-bridge:$SOCAT_PID"',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "live:101",
      "listener:101:8642",
      "stop:101",
      "start-forward:8642 18642 API SOCAT_PID 4242 gateway",
      "live:111",
      "listener:111:8642",
      "live:111",
      "listener:111:8642",
      "live:202",
      "live:303",
      "listener:303:18789",
      "gateway-log",
      "success",
      "final-api-bridge:111",
    ]);
  });

  it("restarts a dashboard that owns its listener but fails HTTP health", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      'id() { [ "${1:-}" = "-u" ] && printf "0\\n"; }',
      'gateway_control_pid_is_live() { trace "live:$1"; return 0; }',
      'hermes_tracked_role_is_current() { gateway_control_pid_is_live "$2"; }',
      'gateway_control_pid_owns_tcp_listener() { trace "listener:$1:$2"; return 0; }',
      'hermes_tracked_service_owns_listener() { trace "service-listener:$1:$2:$3"; return 0; }',
      'curl() { case "$*" in *:8642/health*) printf "200" ;; *) trace dashboard-http; printf "500" ;; esac; }',
      'hermes_stop_tracked_role() { trace "stop:$2"; return 0; }',
      "start_hermes_dashboard_sandbox_user() { trace start-dashboard; DASHBOARD_PID=404; DASHBOARD_SOCAT_PID=505; }",
      'start_socat_forwarder() { trace "unexpected-forward:$*"; return 1; }',
      "ensure_gateway_log_stream() { trace gateway-log; }",
      extractShellFunction(source, "hermes_socat_bridge_healthy"),
      extractShellFunction(source, "hermes_api_socat_bridge_healthy"),
      extractShellFunction(source, "hermes_dashboard_healthy"),
      extractShellFunction(source, "ensure_hermes_supervised_auxiliaries"),
      "PUBLIC_PORT=8642",
      "INTERNAL_PORT=18642",
      "DASHBOARD_PUBLIC_PORT=18789",
      "DASHBOARD_INTERNAL_PORT=19119",
      "SOCAT_PID=101",
      "DASHBOARD_PID=202",
      "DASHBOARD_SOCAT_PID=303",
      "GATEWAY_PID=4242",
      'if ensure_hermes_supervised_auxiliaries; then trace success; else trace "failure:$?"; fi',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "live:101",
      "listener:101:8642",
      "live:101",
      "listener:101:8642",
      "live:101",
      "listener:101:8642",
      "live:202",
      "service-listener:202:19119:sandbox",
      "stop:303",
      "stop:202",
      "start-dashboard",
      "gateway-log",
      "success",
    ]);
  });

  it("propagates API bridge startup failure without touching the dashboard", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      'id() { [ "${1:-}" = "-u" ] && printf "0\\n"; }',
      'gateway_control_pid_is_live() { trace "live:$1"; return 1; }',
      'hermes_tracked_role_is_current() { gateway_control_pid_is_live "$2"; }',
      "gateway_control_pid_owns_tcp_listener() { return 1; }",
      'start_socat_forwarder() { trace "start-forward:$*"; return 1; }',
      "start_hermes_dashboard_sandbox_user() { trace unexpected-dashboard-start; return 0; }",
      'hermes_stop_tracked_role() { trace "stop:$2"; return 0; }',
      "ensure_gateway_log_stream() { trace unexpected-gateway-log; }",
      extractShellFunction(source, "hermes_socat_bridge_healthy"),
      extractShellFunction(source, "hermes_api_socat_bridge_healthy"),
      extractShellFunction(source, "ensure_hermes_supervised_auxiliaries"),
      "PUBLIC_PORT=8642",
      "INTERNAL_PORT=18642",
      "DASHBOARD_PUBLIC_PORT=18789",
      "DASHBOARD_INTERNAL_PORT=19119",
      "SOCAT_PID=101",
      "DASHBOARD_PID=202",
      "DASHBOARD_SOCAT_PID=303",
      "GATEWAY_PID=4242",
      'if ensure_hermes_supervised_auxiliaries; then trace success; else trace "failure:$?"; fi',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "live:101",
      "stop:101",
      "start-forward:8642 18642 API SOCAT_PID 4242 gateway",
      "failure:1",
    ]);
  });
});

describe("Hermes socat bridge startup", () => {
  it("fails promptly when the exact service owner exits during readiness", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness(
      [
        "INTERNAL_PORT=18642",
        "DASHBOARD_INTERNAL_PORT=19119",
        'trace() { printf "%s\\n" "$*"; }',
        'sleep() { trace "unexpected-sleep:$1"; }',
        'hermes_tracked_role_is_current() { trace "owner-check:$1:$2:$3:$4"; return 1; }',
        'hermes_tracked_service_owns_listener() { trace "unexpected-listener-check"; return 1; }',
        "hermes_capture_tracked_role() { return 0; }",
        extractShellFunction(source, "start_socat_forwarder"),
        'SOCAT_PID=""',
        "if start_socat_forwarder 8642 18642 API SOCAT_PID 4242 current; then rc=0; else rc=$?; fi",
        'printf "RC=%s PID=%s\\n" "$rc" "$SOCAT_PID"',
      ],
      (tmpDir) => {
        const binDir = path.join(tmpDir, "bin");
        fs.mkdirSync(binDir);
        fs.writeFileSync(path.join(binDir, "socat"), "#!/usr/bin/env bash\nexit 0\n", {
          mode: 0o700,
        });
        return { PATH: `${binDir}:${process.env.PATH ?? ""}` };
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "owner-check:gateway:4242:current:18642",
      "RC=1 PID=",
    ]);
    expect(result.stdout).not.toContain("unexpected-sleep");
    expect(result.stdout).not.toContain("unexpected-listener-check");
    expect(result.stderr).toContain(
      "API service owner pid 4242 exited before binding 127.0.0.1:18642",
    );
  });

  it("refuses to publish a forward when the internal service never binds", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness(
      [
        "INTERNAL_PORT=18642",
        "DASHBOARD_INTERNAL_PORT=19119",
        "ss() { return 0; }",
        'sleep() { [ "${1:-}" = "0.1" ] && /bin/sleep 0.2 || :; }',
        "hermes_capture_tracked_role() { return 0; }",
        extractShellFunction(source, "start_socat_forwarder"),
        'SOCAT_PID=""',
        "if start_socat_forwarder 8642 18642 API SOCAT_PID; then rc=0; else rc=$?; fi",
        'printf "RC=%s PID=%s\\n" "$rc" "$SOCAT_PID"',
      ],
      (tmpDir) => {
        const binDir = path.join(tmpDir, "bin");
        fs.mkdirSync(binDir);
        fs.writeFileSync(path.join(binDir, "socat"), "#!/usr/bin/env bash\nexit 0\n", {
          mode: 0o700,
        });
        return { PATH: `${binDir}:${process.env.PATH ?? ""}` };
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("RC=1 PID=\n");
    expect(result.stderr).toContain(
      "API service did not bind 127.0.0.1:18642; refusing to publish an empty forward",
    );
  });

  it("rejects a socat listener that exits immediately", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const supervisor = fs.readFileSync(SUPERVISOR_LIB, "utf-8");
    const result = runBashHarness(
      [
        "INTERNAL_PORT=18642",
        "DASHBOARD_INTERNAL_PORT=19119",
        'ss() { printf "LISTEN 0 128 127.0.0.1:18642 0.0.0.0:*\\n"; }',
        "sleep() { :; }",
        "kill() { return 0; }",
        'ps() { printf "Z\\n"; }',
        "hermes_capture_tracked_role() { return 0; }",
        extractShellFunction(supervisor, "gateway_control_pid_is_live"),
        extractShellFunction(source, "start_socat_forwarder"),
        'SOCAT_PID=""',
        "if start_socat_forwarder 8642 18642 API SOCAT_PID; then rc=0; else rc=$?; fi",
        'printf "RC=%s PID=%s\\n" "$rc" "$SOCAT_PID"',
      ],
      (tmpDir) => {
        const binDir = path.join(tmpDir, "bin");
        fs.mkdirSync(binDir);
        fs.writeFileSync(path.join(binDir, "socat"), "#!/usr/bin/env bash\nexit 23\n", {
          mode: 0o700,
        });
        return { PATH: `${binDir}:${process.env.PATH ?? ""}` };
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("RC=1 PID=\n");
    expect(result.stderr).toContain("API socat forwarder failed to stay running on 0.0.0.0:8642");
  });
});
