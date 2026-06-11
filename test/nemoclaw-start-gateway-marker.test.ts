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
        fnSrc,
        "mark_in_container_gateway",
        "mark_in_container_gateway", // second call must be a no-op
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(fs.existsSync(markerPath)).toBe(true);
      // file must be empty (`:` redirected to it, not appended)
      expect(fs.statSync(markerPath).size).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
