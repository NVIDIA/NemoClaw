// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");
const SUPERVISOR_LIB = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "lib",
  "gateway-supervisor.sh",
);

type AuthorizationOptions = {
  version?: string;
  payloadPid?: string;
  payloadStartIdentity?: string;
  payloadControllerPid?: string;
  payloadControllerStartIdentity?: string;
  extraField?: string;
  trailingData?: string;
  directoryMetadata?: string;
  markerMetadata?: string;
  symlink?: boolean;
  markerMissing?: boolean;
  controllerPresent?: boolean;
  controllerUid?: string;
  controllerState?: string;
  controllerCmdline?: string[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractShellFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`${escapeRegExp(name)}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  const resolved =
    match ??
    (() => {
      throw new Error(`Expected ${name} in agents/hermes/start.sh`);
    })();
  return `${name}() {${resolved[1]}\n}`;
}

function runBashHarness(lines: string[], configure?: (tmpDir: string) => Record<string, string>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-exit-auth-test-"));
  const script = path.join(tmpDir, "run.sh");
  fs.writeFileSync(script, ["#!/usr/bin/env bash", "set -uo pipefail", ...lines].join("\n"), {
    mode: 0o700,
  });
  try {
    return spawnSync("bash", [script], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, ...configure?.(tmpDir) },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runAuthorizationCheck(options: AuthorizationOptions = {}) {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  const supervisor = fs.readFileSync(SUPERVISOR_LIB, "utf-8");
  const pid = "4242";
  const startIdentity = "333";
  const controllerPid = "7331";
  const controllerStartIdentity = "888";
  return runBashHarness(
    [
      'stat() { case "$3" in "$HERMES_MANAGED_EXPECTED_EXIT_DIR") printf "%s\\n" "$DIRECTORY_METADATA" ;; *) printf "%s\\n" "$MARKER_METADATA" ;; esac; }',
      extractShellFunction(supervisor, "gateway_control_proc_root"),
      extractShellFunction(supervisor, "gateway_control_proc_root_is_explicit"),
      extractShellFunction(supervisor, "gateway_control_pid_start_identity"),
      extractShellFunction(supervisor, "gateway_control_pid_state"),
      extractShellFunction(source, "hermes_managed_controller_argv_is_expected"),
      extractShellFunction(source, "hermes_managed_controller_is_live"),
      extractShellFunction(source, "hermes_managed_gateway_exit_was_host_authorized"),
      '_HERMES_PROC_ROOT="$PROC_ROOT"',
      'HERMES_MANAGED_EXPECTED_EXIT_DIR="$LEASE_DIR"',
      'HERMES_MANAGED_EXPECTED_EXIT_MARKER="managed-gateway-expected-exit"',
      'HERMES_MANAGED_CONTROLLER_PATH="/usr/local/lib/nemoclaw/managed-gateway-control.py"',
      `if hermes_managed_gateway_exit_was_host_authorized ${pid} ${startIdentity}; then printf "authorized\\n"; else printf "counted\\n"; fi`,
    ],
    (tmpDir) => {
      const leaseDir = path.join(tmpDir, "run", "nemoclaw");
      fs.mkdirSync(leaseDir, { recursive: true, mode: 0o711 });
      const marker = path.join(leaseDir, "managed-gateway-expected-exit");
      const payload = `${options.version ?? "v1"} ${options.payloadPid ?? pid} ${options.payloadStartIdentity ?? startIdentity} ${options.payloadControllerPid ?? controllerPid} ${options.payloadControllerStartIdentity ?? controllerStartIdentity}${options.extraField ? ` ${options.extraField}` : ""}\n${options.trailingData ?? ""}`;
      const writeMarker = options.markerMissing
        ? () => undefined
        : options.symlink
          ? () => {
              const target = path.join(tmpDir, "attacker-marker");
              fs.writeFileSync(target, payload);
              fs.symlinkSync(target, marker);
            }
          : () => fs.writeFileSync(marker, payload, { mode: 0o444 });
      writeMarker();

      const procRoot = path.join(tmpDir, "proc");
      fs.mkdirSync(procRoot);
      const writeController =
        options.controllerPresent === false
          ? () => undefined
          : () => {
              const controllerRoot = path.join(procRoot, controllerPid);
              fs.mkdirSync(controllerRoot);
              const fields = [
                options.controllerState ?? "S",
                "1",
                ...Array(17).fill("0"),
                controllerStartIdentity,
              ];
              fs.writeFileSync(
                path.join(controllerRoot, "stat"),
                `${controllerPid} (python3) ${fields.join(" ")}\n`,
              );
              const uid = options.controllerUid ?? "0";
              fs.writeFileSync(
                path.join(controllerRoot, "status"),
                `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
              );
              fs.writeFileSync(
                path.join(controllerRoot, "cmdline"),
                Buffer.from(
                  `${(
                    options.controllerCmdline ?? [
                      "python3",
                      "-I",
                      "/usr/local/lib/nemoclaw/managed-gateway-control.py",
                      "restart",
                      "a".repeat(64),
                    ]
                  ).join("\0")}\0`,
                ),
              );
            };
      writeController();
      return {
        LEASE_DIR: leaseDir,
        PROC_ROOT: procRoot,
        DIRECTORY_METADATA: options.directoryMetadata ?? "0:0 711",
        MARKER_METADATA: options.markerMetadata ?? "0:0 444 1",
      };
    },
  );
}

describe("Hermes managed gateway exit authorization", () => {
  it("accepts an exact authorization while its root controller identity is live", () => {
    const result = runAuthorizationCheck();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("authorized");
  });

  it.each([
    ["wrong version", { version: "v2" }],
    ["wrong PID", { payloadPid: "4243" }],
    ["wrong start identity", { payloadStartIdentity: "334" }],
    ["nonnumeric controller PID", { payloadControllerPid: "root" }],
    ["wrong controller PID", { payloadControllerPid: "7332" }],
    ["nonnumeric controller start identity", { payloadControllerStartIdentity: "future" }],
    ["wrong controller start identity", { payloadControllerStartIdentity: "889" }],
    ["missing controller", { controllerPresent: false }],
    ["dead controller", { controllerState: "Z" }],
    ["non-root controller", { controllerUid: "1000" }],
    ["unexpected controller argv", { controllerCmdline: ["python3", "/tmp/attacker.py"] }],
    ["extra payload field", { extraField: "unexpected" }],
    ["trailing payload line", { trailingData: "unexpected\n" }],
    ["missing marker", { markerMissing: true }],
    ["writable runtime directory", { directoryMetadata: "0:0 733" }],
    ["non-root marker", { markerMetadata: "1000:1000 444 1" }],
    ["writable marker", { markerMetadata: "0:0 644 1" }],
    ["hard-linked marker", { markerMetadata: "0:0 444 2" }],
    ["symlink marker", { symlink: true }],
  ])("counts an exit when authorization has %s", (_label, options) => {
    const result = runAuthorizationCheck(options);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("counted");
  });

  it("does not charge authenticated host-authorized exits against crash quarantine", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const result = runBashHarness([
      'trace() { printf "%s\\n" "$*"; }',
      'hermes_tracked_role_is_current() { [ "$2" = "5006" ] && { trace "supervised:$2:crashes=$HERMES_MANAGED_GATEWAY_EXIT_COUNT"; exit 0; }; return 1; }',
      'wait() { trace "wait:$1"; return 143; }',
      "mark_hermes_gateway_stopped() { GATEWAY_PID=0; GATEWAY_PID_START_IDENTITY=; }",
      'hermes_managed_gateway_exit_was_host_authorized() { trace "host-exit:$1:$2"; return 0; }',
      'date() { trace unexpected-crash-record; printf "100\\n"; }',
      'sleep() { [ "$1" = "60" ] && { trace unexpected-quarantine; exit 0; }; }',
      'recover_hermes_gateway_current_user() { recover_calls=$((recover_calls + 1)); GATEWAY_PID=$((5000 + recover_calls)); GATEWAY_PID_START_IDENTITY=$((7000 + recover_calls)); trace "recover:$GATEWAY_PID"; }',
      "recover_calls=0",
      extractShellFunction(source, "quarantine_hermes_managed_gateway_relaunch"),
      extractShellFunction(source, "record_hermes_managed_gateway_exit"),
      extractShellFunction(source, "supervise_hermes_gateway_current_user"),
      "INTERNAL_PORT=18642",
      "HERMES_MANAGED_GATEWAY_EXIT_TIMES=(90 95)",
      "HERMES_MANAGED_GATEWAY_EXIT_COUNT=2",
      "GATEWAY_PID=4242",
      "GATEWAY_PID_START_IDENTITY=333",
      "supervise_hermes_gateway_current_user",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/^host-exit:/gm)).toHaveLength(6);
    expect(result.stdout.match(/^recover:/gm)).toHaveLength(6);
    expect(result.stdout).toContain("host-exit:4242:333");
    expect(result.stdout).toContain("host-exit:5005:7005");
    expect(result.stdout).toContain("supervised:5006:crashes=2");
    expect(result.stdout).not.toContain("unexpected-crash-record");
    expect(result.stdout).not.toContain("unexpected-quarantine");
    expect(result.stderr.match(/without charging crash quarantine/g)).toHaveLength(6);
  });
});
