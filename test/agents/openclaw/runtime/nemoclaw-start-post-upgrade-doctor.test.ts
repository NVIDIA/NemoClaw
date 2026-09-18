// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");

function doctorFunction(
  source: string,
  configDir: string,
  readyPath: string,
  rootMode = false,
): string {
  return [
    'normalize_mutable_config_perms() { printf \'normalize\\n\' >>"$NORMALIZE_CALLS"; return "${NORMALIZE_EXIT_CODE:-0}"; }',
    'STEP_DOWN_PREFIX_SANDBOX=("$STEP_DOWN")',
    extractShellFunctionFromSource(source, "_nemoclaw_safe_replace_tmp_file"),
    extractShellFunctionFromSource(source, "run_requested_openclaw_post_upgrade_doctor")
      .replaceAll("/sandbox/.openclaw", configDir)
      .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", readyPath)
      .replace('[ "$(id -u)" -eq 0 ]', rootMode ? '[ "0" -eq 0 ]' : '[ "1000" -eq 0 ]'),
  ].join("\n");
}

function backupQuiesceFunction(source: string, configDir: string, readyPath: string): string {
  return [
    extractShellFunctionFromSource(source, "_nemoclaw_safe_replace_tmp_file"),
    extractShellFunctionFromSource(source, "run_requested_openclaw_backup_quiesce")
      .replaceAll("/sandbox/.openclaw", configDir)
      .replaceAll("/tmp/nemoclaw-post-upgrade-doctor-ready", readyPath),
  ].join("\n");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-doctor-"));
  const configDir = path.join(root, "openclaw");
  const marker = path.join(configDir, ".nemoclaw-post-upgrade-doctor");
  const ready = path.join(root, "doctor-ready");
  const calls = path.join(root, "calls");
  const normalizeCalls = path.join(root, "normalize-calls");
  const openclaw = path.join(root, "openclaw-cli");
  const fakeBin = path.join(root, "bin");
  const stepDown = path.join(root, "step-down");
  const stepDownCalls = path.join(root, "step-down-calls");
  fs.mkdirSync(configDir);
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    openclaw,
    `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(calls)}\nexit "\${DOCTOR_EXIT_CODE:-0}"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "stat"),
    `#!/bin/sh\npython3 - "$2" "$3" <<'PY'\nimport os, stat, sys\ns = os.stat(sys.argv[2], follow_symlinks=False)\nvalues = {"%u": str(s.st_uid), "%u %a %h": f"{s.st_uid} {stat.S_IMODE(s.st_mode):o} {s.st_nlink}"}\nprint(values[sys.argv[1]])\nPY\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    stepDown,
    `#!/bin/sh\nprintf 'HOME=%s\\nPATH=%s\\n' "$HOME" "$PATH" >${JSON.stringify(stepDownCalls)}\nprintf 'ARG=%s\\n' "$@" >>${JSON.stringify(stepDownCalls)}\nexec "$@"\n`,
    { mode: 0o755 },
  );
  return {
    calls,
    configDir,
    fakeBin,
    marker,
    normalizeCalls,
    openclaw,
    ready,
    root,
    stepDown,
    stepDownCalls,
  };
}

function fixtureEnv(
  f: ReturnType<typeof fixture>,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    OPENCLAW: f.openclaw,
    NORMALIZE_CALLS: f.normalizeCalls,
    PATH: `${f.fakeBin}:${process.env.PATH ?? ""}`,
    STEP_DOWN: f.stepDown,
  };
}

function releaseAfterReady(f: ReturnType<typeof fixture>): string {
  const staged = `${f.marker}.release`;
  return [
    `(while [ ! -f ${JSON.stringify(f.ready)} ]; do sleep 0.01; done`,
    `printf '%s\\n' nemoclaw-openclaw-post-upgrade-doctor-release-v1 >${JSON.stringify(staged)}`,
    `chmod 600 ${JSON.stringify(staged)}`,
    `mv -f -- ${JSON.stringify(staged)} ${JSON.stringify(f.marker)}) &`,
  ].join("; ");
}

function promoteAfterReady(f: ReturnType<typeof fixture>): string {
  const staged = `${f.marker}.promote`;
  return [
    `(while [ ! -f ${JSON.stringify(f.ready)} ]; do sleep 0.01; done`,
    `printf '%s\n' nemoclaw-openclaw-backup-quiesce-promote-doctor-v1 >${JSON.stringify(staged)}`,
    `chmod 600 ${JSON.stringify(staged)}`,
    `mv -f -- ${JSON.stringify(staged)} ${JSON.stringify(f.marker)}) &`,
  ].join("; ");
}

describe("nemoclaw-start post-upgrade doctor", () => {
  it("holds backup state before startup mutation without invoking doctor", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-backup-quiesce-v1\n", { mode: 0o600 });
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${backupQuiesceFunction(source, f.configDir, f.ready)}\n${releaseAfterReady(f)}\nrun_requested_openclaw_backup_quiesce`,
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
      expect(fs.existsSync(f.calls)).toBe(false);
      expect(fs.existsSync(f.normalizeCalls)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("runs doctor only after a quiesced restore is promoted", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-backup-quiesce-v1\n", { mode: 0o600 });
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            backupQuiesceFunction(source, f.configDir, f.ready),
            doctorFunction(source, f.configDir, f.ready),
            promoteAfterReady(f),
            "run_requested_openclaw_backup_quiesce || exit $?",
            `printf 'restored-before-doctor\\n' >${JSON.stringify(f.calls)}`,
            releaseAfterReady(f),
            "run_requested_openclaw_post_upgrade_doctor",
          ].join("\n"),
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(f.calls, "utf8")).toBe(
        "restored-before-doctor\ndoctor --fix --yes --non-interactive\n",
      );
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    { doctorExitCode: "0", expectedStatus: 0, markerRetained: false },
    { doctorExitCode: "7", expectedStatus: 1, markerRetained: true },
  ])(
    "uses the sandbox identity and environment in root mode (doctor exit $doctorExitCode)",
    ({ doctorExitCode, expectedStatus, markerRetained }) => {
      const source = fs.readFileSync(START_SCRIPT, "utf8");
      const f = fixture();
      try {
        fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", {
          mode: 0o600,
        });
        const release = doctorExitCode === "0" ? `${releaseAfterReady(f)}\n` : "";
        const result = spawnSync(
          "bash",
          [
            "-c",
            `${doctorFunction(source, f.configDir, f.ready, true)}\n${release}run_requested_openclaw_post_upgrade_doctor`,
          ],
          {
            encoding: "utf8",
            env: fixtureEnv(f, { DOCTOR_EXIT_CODE: doctorExitCode }),
          },
        );

        expect(result.status, result.stderr).toBe(expectedStatus);
        expect(fs.existsSync(f.marker)).toBe(markerRetained);
        const stepDown = fs.readFileSync(f.stepDownCalls, "utf8");
        expect(stepDown).toContain("HOME=/sandbox\n");
        expect(stepDown).toContain(`ARG=PATH=`);
        expect(stepDown).toContain(f.fakeBin);
        expect(stepDown).toContain("/sandbox/.local/bin\n");
        expect(stepDown).toContain(`ARG=${f.openclaw}\n`);
        expect(stepDown).toContain("ARG=doctor\nARG=--fix\nARG=--yes\nARG=--non-interactive\n");
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it("consumes an exact trusted marker only after doctor succeeds", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", { mode: 0o600 });
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\n${releaseAfterReady(f)}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.readFileSync(f.calls, "utf8")).toBe("doctor --fix --yes --non-interactive\n");
      expect(fs.readFileSync(f.normalizeCalls, "utf8")).toBe("normalize\n");
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("consumes an abort transition before running doctor and remains stopped", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-abort-v1\n", {
        mode: 0o600,
      });
      fs.writeFileSync(f.ready, "nemoclaw-openclaw-post-upgrade-doctor-ready-v1\n", {
        mode: 0o600,
      });
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status).toBe(1);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
      expect(fs.existsSync(f.calls)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("consumes an abort transition while the offline gate is armed", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", { mode: 0o600 });
      const staged = `${f.marker}.abort`;
      const abortAfterReady = [
        `(while [ ! -f ${JSON.stringify(f.ready)} ]; do sleep 0.01; done`,
        `printf '%s\\n' nemoclaw-openclaw-post-upgrade-doctor-abort-v1 >${JSON.stringify(staged)}`,
        `chmod 600 ${JSON.stringify(staged)}`,
        `mv -f -- ${JSON.stringify(staged)} ${JSON.stringify(f.marker)}) &`,
      ].join("; ");
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\n${abortAfterReady}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status).toBe(1);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
      expect(fs.readFileSync(f.calls, "utf8")).toBe("doctor --fix --yes --non-interactive\n");
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("cleans an abandoned gate on timeout so a future start cannot repeat it", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", { mode: 0o600 });
      const boundedFunction = doctorFunction(source, f.configDir, f.ready).replace(
        '[ "$gate_attempt" -lt 600 ]',
        '[ "$gate_attempt" -lt 2 ]',
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${boundedFunction}\nsleep() { return 0; }\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status).toBe(1);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.existsSync(f.ready)).toBe(false);
      expect(result.stderr).toContain("Timed out waiting for post-upgrade offline restore release");
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("retains the marker when doctor fails so recovery can retry", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", { mode: 0o600 });
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
        {
          encoding: "utf8",
          env: fixtureEnv(f, { DOCTOR_EXIT_CODE: "7" }),
        },
      );

      expect(result.status).toBe(1);
      expect(fs.readFileSync(f.marker, "utf8")).toBe("nemoclaw-openclaw-post-upgrade-doctor-v2\n");
      expect(fs.existsSync(f.normalizeCalls)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("retains the marker when mutable permissions cannot be restored", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v2\n", { mode: 0o600 });
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
        {
          encoding: "utf8",
          env: fixtureEnv(f, { NORMALIZE_EXIT_CODE: "8" }),
        },
      );

      expect(result.status).toBe(1);
      expect(fs.readFileSync(f.calls, "utf8")).toBe("doctor --fix --yes --non-interactive\n");
      expect(fs.readFileSync(f.marker, "utf8")).toBe("nemoclaw-openclaw-post-upgrade-doctor-v2\n");
      expect(fs.readFileSync(f.normalizeCalls, "utf8")).toBe("normalize\n");
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each(["wrong mode", "wrong content"])("rejects a marker with %s", (label) => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      const wrongMode = label === "wrong mode";
      fs.writeFileSync(
        f.marker,
        wrongMode ? "nemoclaw-openclaw-post-upgrade-doctor-v2\n" : "unexpected\n",
        { mode: wrongMode ? 0o644 : 0o600 },
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir, f.ready)}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status).toBe(1);
      expect(fs.existsSync(f.calls)).toBe(false);
      expect(fs.existsSync(f.marker)).toBe(true);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
});
