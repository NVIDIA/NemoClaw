// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");

function doctorFunction(source: string, configDir: string): string {
  return [
    'normalize_mutable_config_perms() { printf \'normalize\\n\' >>"$NORMALIZE_CALLS"; return "${NORMALIZE_EXIT_CODE:-0}"; }',
    extractShellFunctionFromSource(source, "run_requested_openclaw_post_upgrade_doctor")
      .replaceAll("/sandbox/.openclaw", configDir)
      .replace('[ "$(id -u)" -eq 0 ]', '[ "1000" -eq 0 ]'),
  ].join("\n");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-doctor-"));
  const configDir = path.join(root, "openclaw");
  const marker = path.join(configDir, ".nemoclaw-post-upgrade-doctor");
  const calls = path.join(root, "calls");
  const normalizeCalls = path.join(root, "normalize-calls");
  const openclaw = path.join(root, "openclaw-cli");
  const fakeBin = path.join(root, "bin");
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
  return { calls, configDir, fakeBin, marker, normalizeCalls, openclaw, root };
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
  };
}

describe("nemoclaw-start post-upgrade doctor", () => {
  it("consumes an exact trusted marker only after doctor succeeds", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v1\n", { mode: 0o600 });
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir)}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
        { encoding: "utf8", env: fixtureEnv(f) },
      );

      expect(result.status).toBe(0);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.readFileSync(f.calls, "utf8")).toBe("doctor --fix --yes --non-interactive\n");
      expect(fs.readFileSync(f.normalizeCalls, "utf8")).toBe("normalize\n");
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("retains the marker when doctor fails so recovery can retry", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v1\n", { mode: 0o600 });
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir)}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
        {
          encoding: "utf8",
          env: fixtureEnv(f, { DOCTOR_EXIT_CODE: "7" }),
        },
      );

      expect(result.status).toBe(1);
      expect(fs.readFileSync(f.marker, "utf8")).toBe("nemoclaw-openclaw-post-upgrade-doctor-v1\n");
      expect(fs.existsSync(f.normalizeCalls)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("retains the marker when mutable permissions cannot be restored", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const f = fixture();
    try {
      fs.writeFileSync(f.marker, "nemoclaw-openclaw-post-upgrade-doctor-v1\n", { mode: 0o600 });
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir)}\nrun_requested_openclaw_post_upgrade_doctor`,
        ],
        {
          encoding: "utf8",
          env: fixtureEnv(f, { NORMALIZE_EXIT_CODE: "8" }),
        },
      );

      expect(result.status).toBe(1);
      expect(fs.readFileSync(f.calls, "utf8")).toBe("doctor --fix --yes --non-interactive\n");
      expect(fs.readFileSync(f.marker, "utf8")).toBe("nemoclaw-openclaw-post-upgrade-doctor-v1\n");
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
        wrongMode ? "nemoclaw-openclaw-post-upgrade-doctor-v1\n" : "unexpected\n",
        { mode: wrongMode ? 0o644 : 0o600 },
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${doctorFunction(source, f.configDir)}\nrun_requested_openclaw_post_upgrade_doctor`,
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
