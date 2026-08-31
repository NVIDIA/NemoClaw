// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  INSTALLER_PAYLOAD,
  TEST_SYSTEM_PATH,
  writeExecutable,
} from "../helpers/installer-sourced-env";

const REPO_ROOT = path.join(import.meta.dirname, "../..");

function restore(env: Record<string, string | undefined>) {
  return spawnSync(
    "bash",
    ["-c", `source "${INSTALLER_PAYLOAD}" 2>/dev/null; restore_onboard_forward_after_post_checks`],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { HOME: os.tmpdir(), PATH: TEST_SYSTEM_PATH, ...env },
    },
  );
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-forward-recover-"));
  const bin = path.join(root, "bin");
  const state = path.join(root, ".nemoclaw");
  const cliLog = path.join(root, "cli.log");
  const openshellLog = path.join(root, "openshell.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.writeFileSync(
    path.join(state, "onboard-session.json"),
    JSON.stringify({ sandboxName: "created-by-onboard", agent: "hermes" }),
  );
  fs.writeFileSync(
    path.join(state, "sandboxes.json"),
    JSON.stringify({ sandboxes: { "created-by-onboard": { hermesApiPort: 8647 } } }),
  );
  writeExecutable(
    path.join(bin, "nemoclaw"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$CLI_LOG\"\nexit \"${CLI_STATUS:-0}\"\n",
  );
  fs.symlinkSync(path.join(bin, "nemoclaw"), path.join(bin, "nemohermes"));
  writeExecutable(
    path.join(bin, "openshell"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$OPENSHELL_LOG\"\nexit 0\n",
  );
  writeExecutable(path.join(bin, "curl"), "#!/usr/bin/env bash\nexit \"${CURL_STATUS:-0}\"\n");
  const env = {
    HOME: root,
    PATH: `${bin}:${TEST_SYSTEM_PATH}`,
    CLI_LOG: cliLog,
    OPENSHELL_LOG: openshellLog,
  };
  return { bin, cliLog, env, openshellLog, root, state };
}

function addForwardReceipt(state: string): void {
  const receipts = path.join(state, "state", "forwards");
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(receipts, "created-by-onboard-8647.json"), "{}\n");
}

function expectRecovery(h: ReturnType<typeof fixture>): void {
  const result = restore(h.env);
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readFileSync(h.cliLog, "utf8").trim()).toBe("created-by-onboard recover");
  expect(fs.existsSync(h.openshellLog)).toBe(false);
}

describe("Hermes installer forward restore", () => {
  it("delegates a no-receipt state to identity-bound NemoClaw recovery", () => {
    const h = fixture();
    try {
      expectRecovery(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("delegates a receipt-backed state to identity-bound NemoClaw recovery", () => {
    const h = fixture();
    addForwardReceipt(h.state);
    try {
      expectRecovery(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs recovery even when the port health probe is already reachable", () => {
    const h = fixture();
    addForwardReceipt(h.state);
    try {
      const result = restore({ ...h.env, CURL_STATUS: "0" });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(h.cliLog, "utf8").trim()).toBe("created-by-onboard recover");
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed before recovery when the registered Hermes port is unavailable", () => {
    const h = fixture();
    try {
      fs.writeFileSync(path.join(h.state, "sandboxes.json"), JSON.stringify({ sandboxes: {} }));
      const result = restore(h.env);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("registered API port");
      expect(fs.existsSync(h.cliLog)).toBe(false);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails when recovery fails or its post-recovery health probe is unhealthy", () => {
    const recoveryFailure = fixture();
    const healthFailure = fixture();
    try {
      expect(restore({ ...recoveryFailure.env, CLI_STATUS: "1" }).status).toBe(1);
      expect(restore({ ...healthFailure.env, CURL_STATUS: "1" }).status).toBe(1);
    } finally {
      fs.rmSync(recoveryFailure.root, { recursive: true, force: true });
      fs.rmSync(healthFailure.root, { recursive: true, force: true });
    }
  }, 45_000);
});
