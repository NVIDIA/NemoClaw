// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertStationExpressInstallerResumeMatches } from "../src/lib/onboard/station-express-resume";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STATION_REVISION = "a".repeat(40);
const STATION_GENERATION = "0123456789abcdef0123456789abcdef";

function writeStationExpressInstallerResume(mode: "express" | "provider") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-resume-contract-"));
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `
source "$INSTALLER_UNDER_TEST" >/dev/null
NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
NEMOCLAW_DASHBOARD_PORT='18790'
NEMOCLAW_VLLM_PORT='18000'
_STATION_INSTALL_MODE='${mode}'
station_installer_revision() { printf '${STATION_REVISION}'; }
station_express_resume_generation() { printf '${STATION_GENERATION}'; }
save_station_express_resume
`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        HOME: home,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        PATH: TEST_SYSTEM_PATH,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { home, result, output: `${result.stdout}${result.stderr}` };
}

describe("DGX Station installer resume contract", () => {
  it("accepts the express resume receipt written by the installer (#8205)", () => {
    const { home, result, output } = writeStationExpressInstallerResume("express");

    try {
      expect(result.status, output).toBe(0);
      expect(() =>
        assertStationExpressInstallerResumeMatches(STATION_GENERATION, { HOME: home }),
      ).not.toThrow();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts the provider resume receipt written by the installer (#8205)", () => {
    const { home, result, output } = writeStationExpressInstallerResume("provider");

    try {
      expect(result.status, output).toBe(0);
      expect(() =>
        assertStationExpressInstallerResumeMatches(STATION_GENERATION, { HOME: home }),
      ).not.toThrow();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects the installer receipt when the writer mode field drifts (#8205)", () => {
    const { home, result, output } = writeStationExpressInstallerResume("express");
    const stateFile = path.join(home, ".nemoclaw", "station-express-resume");

    try {
      expect(result.status, output).toBe(0);
      const receipt = fs.readFileSync(stateFile, "utf8");
      const driftedReceipt = receipt.replace(/^mode=/m, "install_mode=");
      expect(driftedReceipt).not.toBe(receipt);
      fs.writeFileSync(stateFile, driftedReceipt, { mode: 0o600 });

      expect(() =>
        assertStationExpressInstallerResumeMatches(STATION_GENERATION, { HOME: home }),
      ).toThrow("malformed");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("DGX Station installer resume cleanup", () => {
  it("preserves pair and SSH-binding state when interactive host preflight skips onboarding", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-resume-cleanup-"));
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
pair_state="$HOME/.nemoclaw/station-dual-pair-resume.json"
binding_state="\${pair_state}.ssh-binding"
mkdir -p "$binding_state"
printf '{}\n' >"$pair_state"
printf 'binding\n' >"$binding_state/token"
printf 'resume\n' >"$HOME/.nemoclaw/station-express-resume"
_SELECTED_EXPRESS_PLATFORM='DGX Station'
ONBOARD_RAN=false
clear_station_resume_after_completed_onboarding
printf 'PAIR=%s BINDING=%s EXPRESS=%s\n' \
  "$([ -f "$pair_state" ] && printf present)" \
  "$([ -f "$binding_state/token" ] && printf present)" \
  "$([ -f "$HOME/.nemoclaw/station-express-resume" ] && printf present)"
`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          PATH: TEST_SYSTEM_PATH,
        },
      },
    );

    try {
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).toContain("PAIR=present BINDING=present EXPRESS=present");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
