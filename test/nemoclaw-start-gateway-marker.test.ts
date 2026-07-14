// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

// Extracts a shell function body (including heredocs) from the start script so
// the real helper can be exercised in isolation.
function extractShellFunctionFromSource(src, name) {
  const header = `${name}() {`;
  const start = src.indexOf(header);
  if (start === -1) {
    throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
  }
  const bodyStart = start + header.length;
  const lines = src.slice(bodyStart).split(/(?<=\n)/);
  let offset = 0;
  let heredocEnd;
  for (const line of lines) {
    const bareLine = line.replace(/\r?\n$/, "");
    if (heredocEnd) {
      offset += line.length;
      if (bareLine === heredocEnd) {
        heredocEnd = undefined;
      }
      continue;
    }
    const heredoc = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (heredoc) {
      heredocEnd = heredoc[1];
    }
    if (bareLine === "}") {
      return `${name}() {${src.slice(bodyStart, bodyStart + offset)}\n}`;
    }
    offset += line.length;
  }
  throw new Error(`Expected closing brace for ${name} in scripts/nemoclaw-start.sh`);
}

function safeTmpHelpers(src: string): string {
  const start = src.indexOf("_nemoclaw_safe_replace_tmp_file() {");
  const end = src.indexOf("_START_LOG=", start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Expected safe temp helpers in scripts/nemoclaw-start.sh");
  }
  return src.slice(start, end);
}

describe("nemoclaw-start in-container gateway healthcheck marker (#4503, #4710)", () => {
  // #4503/#4710: the Docker HEALTHCHECK reports healthy on curl-exit-7 only
  // when the /tmp/nemoclaw-gateway-local marker is ABSENT (gateway delivered
  // out of this container's namespace — OpenShell docker-driver runs it on the
  // host). The marker must be true-by-construction: present at the moment this
  // container launches the gateway, NOT gated on env hints at startup. OpenShell
  // 0.0.44 does not export OPENSHELL_DRIVERS into the sandbox container env, so
  // an early env-gated write never fires for docker-driver sandboxes (#4710 root
  // cause; #4748 fix attempt was a no-op for that reason).
  //
  // We verify this behaviorally rather than asserting on the script's source
  // shape: when a `gateway run` actually fires, the marker file already exists.
  // A fake `openclaw` records marker presence at the instant `gateway run` is
  // invoked, for each command form the script uses (non-root direct, root
  // step-down-prefixed). If the marker were dropped at startup instead of the
  // launch site, or skipped on a launch path, the probe would observe its
  // absence here.
  it("has the in-container gateway marker present when the gateway launches, in both modes (#4503, #4710)", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const markFn = extractShellFunctionFromSource(src, "mark_in_container_gateway");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-launch-"));
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");
    const fakeBin = path.join(tmpDir, "bin");

    try {
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        path.join(fakeBin, "openclaw"),
        [
          "#!/usr/bin/env bash",
          'if [ "${1:-}" = "gateway" ] && [ "${2:-}" = "run" ]; then',
          `  if [ -f ${JSON.stringify(markerPath)} ]; then`,
          "    echo MARKER_PRESENT_AT_LAUNCH",
          "  else",
          "    echo MARKER_ABSENT_AT_LAUNCH",
          "  fi",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      // Reproduce the launch sequence with the real marker helper: drop the
      // marker, then invoke `gateway run`. `nohup` is reduced to a synchronous
      // pass-through so the probe runs deterministically.
      function runLaunch(launchCmd: string) {
        const script = [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          safeTmpHelpers(src),
          markFn.replaceAll("/tmp/nemoclaw-gateway-local", markerPath),
          'nohup() { "$@"; }',
          // macOS runners still use Bash 3.2; keep the simulated prefix
          // non-empty so nounset never treats empty-array expansion as unbound.
          "STEP_DOWN_PREFIX_GATEWAY=(env)",
          'OPENCLAW="$(command -v openclaw)"',
          "_DASHBOARD_PORT=18789",
          `rm -f ${JSON.stringify(markerPath)}`,
          "mark_in_container_gateway",
          launchCmd,
        ].join("\n");
        return spawnSync("bash", ["-c", script], {
          encoding: "utf-8",
          timeout: 5000,
          env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ""}` },
        });
      }

      const nonRoot = runLaunch('nohup "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}"');
      expect(nonRoot.status).toBe(0);
      expect(nonRoot.stdout).toContain("MARKER_PRESENT_AT_LAUNCH");
      expect(nonRoot.stdout).not.toContain("MARKER_ABSENT_AT_LAUNCH");

      const root = runLaunch(
        'nohup "${STEP_DOWN_PREFIX_GATEWAY[@]}" "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}"',
      );
      expect(root.status).toBe(0);
      expect(root.stdout).toContain("MARKER_PRESENT_AT_LAUNCH");
      expect(root.stdout).not.toContain("MARKER_ABSENT_AT_LAUNCH");

      // The marker is left in place after a launch (idempotent for restart loops).
      expect(fs.existsSync(markerPath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "explicit docker driver",
      {
        OPENSHELL_DRIVERS: "docker",
        OPENSHELL_ENDPOINT: "http://127.0.0.1:8080",
        OPENSHELL_SANDBOX_COMMAND: "sleep infinity",
        OPENSHELL_SANDBOX_ID: "sandbox-id",
      },
    ],
    [
      "missing driver with OpenShell sleep command and identity",
      {
        OPENSHELL_DRIVERS: "",
        OPENSHELL_ENDPOINT: "http://127.0.0.1:8080",
        OPENSHELL_SANDBOX_COMMAND: "sleep infinity",
        OPENSHELL_SANDBOX_ID: "sandbox-id",
      },
    ],
    ["vm driver", { OPENSHELL_DRIVERS: "vm" }],
    ["kubernetes driver", { OPENSHELL_DRIVERS: "kubernetes" }],
    ["k3s driver", { OPENSHELL_DRIVERS: "k3s" }],
    [
      "missing endpoint",
      { OPENSHELL_SANDBOX_COMMAND: "sleep infinity", OPENSHELL_SANDBOX_ID: "sandbox-id" },
    ],
    [
      "missing sandbox id",
      {
        OPENSHELL_ENDPOINT: "http://127.0.0.1:8080",
        OPENSHELL_SANDBOX_COMMAND: "sleep infinity",
      },
    ],
    [
      "non-sleep command",
      {
        OPENSHELL_ENDPOINT: "http://127.0.0.1:8080",
        OPENSHELL_SANDBOX_COMMAND: "env CHAT_UI_URL=http://127.0.0.1:8642 nemoclaw-start",
        OPENSHELL_SANDBOX_ID: "sandbox-id",
      },
    ],
  ])("does not let %s env suppress a reached local gateway launch (#4710)", (_label, env) => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const markFn = extractShellFunctionFromSource(src, "mark_in_container_gateway");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-env-contract-"));
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");
    const openclawLog = path.join(tmpDir, "openclaw.log");
    const fakeBin = path.join(tmpDir, "bin");

    try {
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        path.join(fakeBin, "openclaw"),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(openclawLog)}\n`,
        { mode: 0o755 },
      );

      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        safeTmpHelpers(src),
        markFn.replaceAll("/tmp/nemoclaw-gateway-local", markerPath),
        'nohup() { "$@"; }',
        'OPENCLAW="$(command -v openclaw)"',
        "_DASHBOARD_PORT=18789",
        "mark_in_container_gateway",
        'nohup "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}"',
        `[ -f ${JSON.stringify(markerPath)} ] && echo MARKER_PRESENT`,
      ].join("\n");

      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf-8",
        timeout: 5000,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          ...env,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("MARKER_PRESENT");
      expect(fs.readFileSync(openclawLog, "utf-8")).toContain("gateway run --port 18789");
      expect(fs.existsSync(markerPath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Behavioral test of the marker function: confirms the helper itself writes
  // an empty file at the target path and is a no-op when the path is already
  // present (idempotent restart-loop semantics).
  it("mark_in_container_gateway writes the marker file idempotently (#4710)", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-marker-"));
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");
    const fnSrc = extractShellFunctionFromSource(src, "mark_in_container_gateway").replaceAll(
      "/tmp/nemoclaw-gateway-local",
      markerPath,
    );

    try {
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        safeTmpHelpers(src),
        fnSrc,
        "mark_in_container_gateway",
        "mark_in_container_gateway", // second call must be a no-op
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(fs.existsSync(markerPath)).toBe(true);
      // file must be empty, not appended to across idempotent calls
      expect(fs.statSync(markerPath).size).toBe(0);
      expect((fs.statSync(markerPath).mode & 0o777).toString(8)).toBe("600");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // #4952: the HEALTHCHECK's pidfile fallback trusts /tmp/nemoclaw-gateway.pid,
  // which only this supervisor refreshes. On docker-driver sandboxes the script
  // is not PID 1 (OpenShell's `sleep infinity` keeps the container alive), so
  // the supervisor can exit while the container lives on. If the marker
  // survived that exit, the healthcheck would trust a stale PID forever and
  // report a working sandbox as permanently unhealthy. The fix drops the marker
  // on every supervisor exit via a `trap clear_in_container_gateway_marker
  // EXIT`, so the healthcheck then takes the marker-absent -> healthy branch
  // (#4503). The marker is re-dropped at each launch, so the respawn loop (which
  // never exits the script) keeps it in place.

  it("clear_in_container_gateway_marker removes the marker and is a no-op when absent (#4952)", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-clear-"));
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");
    const clearFn = extractShellFunctionFromSource(
      src,
      "clear_in_container_gateway_marker",
    ).replaceAll("/tmp/nemoclaw-gateway-local", markerPath);

    try {
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        clearFn,
        // No-op when the marker is absent: must succeed, not error.
        "clear_in_container_gateway_marker",
        `[ -e ${JSON.stringify(markerPath)} ] && echo UNEXPECTED_PRESENT || echo ABSENT_OK`,
        // Now create it and confirm the helper removes it.
        `: > ${JSON.stringify(markerPath)}`,
        "clear_in_container_gateway_marker",
        `[ -e ${JSON.stringify(markerPath)} ] && echo STILL_PRESENT || echo REMOVED`,
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ABSENT_OK");
      expect(result.stdout).toContain("REMOVED");
      expect(result.stdout).not.toContain("UNEXPECTED_PRESENT");
      expect(result.stdout).not.toContain("STILL_PRESENT");
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "root launch helper", launchFunction: "launch_openclaw_gateway" },
    { label: "non-root launch helper", launchFunction: "launch_openclaw_gateway_non_root" },
  ])("clears the marker when $label exits before recording PID identity (#4952)", ({
    launchFunction,
  }) => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-early-exit-"));
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");

    try {
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        safeTmpHelpers(src),
        extractShellFunctionFromSource(src, "mark_in_container_gateway").replaceAll(
          "/tmp/nemoclaw-gateway-local",
          markerPath,
        ),
        extractShellFunctionFromSource(src, "clear_in_container_gateway_marker").replaceAll(
          "/tmp/nemoclaw-gateway-local",
          markerPath,
        ),
        extractShellFunctionFromSource(src, "arm_openclaw_gateway_supervisor_cleanup"),
        extractShellFunctionFromSource(src, launchFunction),
        "cleanup_openclaw_on_signal() { exit 143; }",
        "STEP_DOWN_PREFIX_GATEWAY=(env)",
        "OPENCLAW=/bin/true",
        "_DASHBOARD_PORT=18789",
        "GATEWAY_PID=0",
        "GATEWAY_PID_START_IDENTITY=",
        "GATEWAY_PID_FILE=",
        "capture_openclaw_pid_start_identity() { return 1; }",
        "record_gateway_pid() { :; }",
        "clear_gateway_pid_record() { :; }",
        launchFunction,
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(result.status).toBe(1);
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "non-root", signal: "TERM", exitCode: 143 },
    { label: "non-root", signal: "INT", exitCode: 130 },
    { label: "root", signal: "TERM", exitCode: 143 },
    { label: "root", signal: "INT", exitCode: 130 },
  ])("arms $signal cleanup before the $label marker write (#4952)", ({
    label,
    signal,
    exitCode,
  }) => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-early-signal-"));
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");
    const clearFn = extractShellFunctionFromSource(
      src,
      "clear_in_container_gateway_marker",
    ).replaceAll("/tmp/nemoclaw-gateway-local", markerPath);
    const launchFunction =
      label === "root" ? "launch_openclaw_gateway" : "launch_openclaw_gateway_non_root";

    try {
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        clearFn,
        extractShellFunctionFromSource(src, "arm_openclaw_gateway_supervisor_cleanup"),
        extractShellFunctionFromSource(src, launchFunction),
        `cleanup_openclaw_on_signal() { exit ${exitCode}; }`,
        `mark_in_container_gateway() { : > ${JSON.stringify(markerPath)}; kill -${signal} $$; }`,
        "STEP_DOWN_PREFIX_GATEWAY=(env)",
        "OPENCLAW=/bin/true",
        "_DASHBOARD_PORT=18789",
        launchFunction,
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr).toBe(exitCode);
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Exercises the real exit-trap wiring, not just the helper: registers the
  // same `trap clear_in_container_gateway_marker EXIT` the supervisor installs,
  // drops the marker via mark_in_container_gateway, then lets the shell reach a
  // clean `exit 0`. The marker must be gone once the process exits, which is
  // exactly the state that flips the healthcheck back to the marker-absent
  // healthy branch.
  it("drops the marker when the supervisor reaches a clean exit (#4952)", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-exit-"));
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");
    const markFn = extractShellFunctionFromSource(src, "mark_in_container_gateway").replaceAll(
      "/tmp/nemoclaw-gateway-local",
      markerPath,
    );
    const clearFn = extractShellFunctionFromSource(
      src,
      "clear_in_container_gateway_marker",
    ).replaceAll("/tmp/nemoclaw-gateway-local", markerPath);
    const armCleanup = extractShellFunctionFromSource(
      src,
      "arm_openclaw_gateway_supervisor_cleanup",
    );

    try {
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        safeTmpHelpers(src),
        markFn,
        clearFn,
        armCleanup,
        "cleanup_openclaw_on_signal() { :; }",
        "arm_openclaw_gateway_supervisor_cleanup",
        "mark_in_container_gateway",
        `[ -e ${JSON.stringify(markerPath)} ] && echo MARKER_PRESENT_BEFORE_EXIT`,
        "exit 0",
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      // The marker existed while the supervisor was running...
      expect(result.stdout).toContain("MARKER_PRESENT_BEFORE_EXIT");
      // ...and is gone the moment it exits.
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("drops the marker when the supervisor exits through errexit (#4952)", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-errexit-"));
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");
    const markFn = extractShellFunctionFromSource(src, "mark_in_container_gateway").replaceAll(
      "/tmp/nemoclaw-gateway-local",
      markerPath,
    );
    const clearFn = extractShellFunctionFromSource(
      src,
      "clear_in_container_gateway_marker",
    ).replaceAll("/tmp/nemoclaw-gateway-local", markerPath);
    const armCleanup = extractShellFunctionFromSource(
      src,
      "arm_openclaw_gateway_supervisor_cleanup",
    );

    try {
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        safeTmpHelpers(src),
        markFn,
        clearFn,
        armCleanup,
        "cleanup_openclaw_on_signal() { :; }",
        "arm_openclaw_gateway_supervisor_cleanup",
        "mark_in_container_gateway",
        `[ -e ${JSON.stringify(markerPath)} ] && echo MARKER_PRESENT_BEFORE_ERREXIT`,
        "false",
        "echo UNREACHABLE",
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain("MARKER_PRESENT_BEFORE_ERREXIT");
      expect(result.stdout).not.toContain("UNREACHABLE");
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Signal path: cleanup_openclaw_on_signal delegates to cleanup_on_signal
  // (shared from sandbox-init.sh), which ends in `exit`, so the EXIT trap fires
  // for SIGTERM/SIGINT teardown too. The marker must be cleared on a forwarded
  // signal, not only on a clean gateway exit.
  // Run synchronously: a backgrounded coroutine delivers SIGTERM to the script
  // itself while it blocks in `wait`, mirroring the supervise loop being
  // signalled. This avoids cross-process timing races.
  it("drops the marker when the supervisor is terminated by a signal (#4952)", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-signal-"));
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");
    const markFn = extractShellFunctionFromSource(src, "mark_in_container_gateway").replaceAll(
      "/tmp/nemoclaw-gateway-local",
      markerPath,
    );
    const clearFn = extractShellFunctionFromSource(
      src,
      "clear_in_container_gateway_marker",
    ).replaceAll("/tmp/nemoclaw-gateway-local", markerPath);
    const armCleanup = extractShellFunctionFromSource(
      src,
      "arm_openclaw_gateway_supervisor_cleanup",
    );

    try {
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        safeTmpHelpers(src),
        markFn,
        clearFn,
        // Minimal stand-ins for the production signal path: the OpenClaw wrapper
        // delegates to the shared cleanup helper, which ends in `exit` and
        // triggers the EXIT trap where marker cleanup lives.
        "cleanup_on_signal() { exit 143; }",
        "cleanup_openclaw_on_signal() { cleanup_on_signal; }",
        armCleanup,
        "arm_openclaw_gateway_supervisor_cleanup",
        "mark_in_container_gateway",
        `[ -e ${JSON.stringify(markerPath)} ] && echo MARKER_PRESENT_BEFORE_SIGNAL`,
        // Deliver SIGTERM to ourselves while we block in `wait`, the same shape
        // as the supervise loop being signalled mid-wait. Background stdio is
        // redirected so spawnSync isn't held open by an inherited pipe after we
        // exit.
        "( sleep 0.2; kill -TERM $$ ) >/dev/null 2>&1 &",
        "sleep 5 >/dev/null 2>&1 &",
        "BLOCK_PID=$!",
        "wait $BLOCK_PID",
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 8000 });
      // The script exits via the SIGTERM trap -> cleanup_openclaw_on_signal ->
      // cleanup_on_signal -> exit 143.
      expect(result.status).toBe(143);
      expect(result.stdout).toContain("MARKER_PRESENT_BEFORE_SIGNAL");
      // The EXIT trap fired on the signal teardown and cleared the marker.
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15000);

  // Restart semantics: while the supervisor is alive and respawning the gateway
  // (the script never exits), the marker must stay in place so the #4952
  // pidfile fallback keeps probing the live gateway. Only a supervisor *exit*
  // clears it. Here the EXIT trap is armed but the script keeps running, and a
  // re-launch re-drops the marker idempotently — the marker is present
  // throughout.
  it("keeps the marker in place across respawns while the supervisor runs (#4952)", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-respawn-"));
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");
    const markFn = extractShellFunctionFromSource(src, "mark_in_container_gateway").replaceAll(
      "/tmp/nemoclaw-gateway-local",
      markerPath,
    );
    const clearFn = extractShellFunctionFromSource(
      src,
      "clear_in_container_gateway_marker",
    ).replaceAll("/tmp/nemoclaw-gateway-local", markerPath);
    const armCleanup = extractShellFunctionFromSource(
      src,
      "arm_openclaw_gateway_supervisor_cleanup",
    );

    try {
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        safeTmpHelpers(src),
        markFn,
        clearFn,
        armCleanup,
        "cleanup_openclaw_on_signal() { :; }",
        "arm_openclaw_gateway_supervisor_cleanup",
        // Initial launch.
        "mark_in_container_gateway",
        `[ -e ${JSON.stringify(markerPath)} ] && echo AFTER_LAUNCH`,
        // Simulate a respawn iteration: the loop body re-marks before relaunch
        // and the script does NOT exit between iterations.
        "mark_in_container_gateway",
        `[ -e ${JSON.stringify(markerPath)} ] && echo AFTER_RESPAWN`,
        // The script is still running here — the EXIT trap has not fired.
        "exit 0",
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("AFTER_LAUNCH");
      expect(result.stdout).toContain("AFTER_RESPAWN");
      // Once the script finally exits, the trap clears it.
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
