// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const installer = path.resolve(import.meta.dirname, "../../scripts/install.sh");
const roots: string[] = [];
const hasPty =
  process.platform === "linux" &&
  spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Exercise the installer output boundary without downloading or installing binaries. */
function runInstall(tty: boolean, failed = false, existing = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-output-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(
    path.join(root, "scripts/install-openshell.sh"),
    failed
      ? "#!/bin/bash\nprintf 'SHA-256 checksum verification failed\\n' >&2\nexit 7\n"
      : "#!/bin/bash\nprintf 'openshell-cli.tar.gz: OK\\nopenshell-gateway.tar.gz: OK\\n'\n",
  );
  const probe = path.join(root, "probe.sh");
  fs.writeFileSync(
    probe,
    `source "$INSTALLER_UNDER_TEST" >/dev/null
uname() { printf 'Linux\\n'; }
command_exists() { ${existing ? "return 0" : "return 1"}; }
prefer_user_local_openshell() { return 0; }
prefer_homebrew_openshell() { return 1; }
install_nemoclaw_openshell_gateway_user_service() { printf 'SERVICE_INSTALLED\\n'; }
NEMOCLAW_SOURCE_ROOT="$FIXTURE_ROOT"
maybe_install_openshell_during_install ${existing ? "if-missing" : "force"}
`,
  );
  return spawnSync(
    tty ? "script" : "bash",
    tty ? ["-qec", 'bash "$PROBE_UNDER_TEST"', "/dev/null"] : [probe],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        INSTALLER_UNDER_TEST: installer,
        PROBE_UNDER_TEST: probe,
        FIXTURE_ROOT: root,
        NEMOCLAW_DEFER_OPENSHELL_INSTALL: "0",
      },
    },
  );
}

describe.each([false, true])("OpenShell installation output with terminal=%s", (tty) => {
  it.skipIf(tty && !hasPty)("retains successful asset verification output (#12275)", () => {
    const result = runInstall(tty);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("openshell-cli.tar.gz: OK");
    expect(result.stdout).toContain("openshell-gateway.tar.gz: OK");
    expect(result.stdout).toContain("SERVICE_INSTALLED");
  });
  it.skipIf(tty && !hasPty)(
    "reports verification failure without installing the gateway service",
    () => {
      const result = runInstall(tty, true);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("SHA-256 checksum verification failed");
      expect(result.stdout).not.toContain("SERVICE_INSTALLED");
    },
  );
  it.skipIf(tty && !hasPty)(
    "does not invent verification evidence when reusing an installed CLI",
    () => {
      const result = runInstall(tty, false, true);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(".tar.gz: OK");
      expect(result.stdout).toContain("SERVICE_INSTALLED");
    },
  );
});
