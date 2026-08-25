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

function callInstallerPayloadFn(fnCall: string, env: Record<string, string | undefined> = {}) {
  return spawnSync("bash", ["-c", `source "${INSTALLER_PAYLOAD}" 2>/dev/null; ${fnCall}`], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      HOME: os.tmpdir(),
      PATH: TEST_SYSTEM_PATH,
      ...env,
    },
  });
}

describe("Hermes installer forward restore", () => {
  it("fails closed without a registered port and restores the recorded port (#8543)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-forward-restore-"));
    try {
      const fakeBin = path.join(tempDir, "bin");
      const stateDir = path.join(tempDir, ".nemoclaw");
      const openshellLog = path.join(tempDir, "openshell.log");
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      fs.symlinkSync(process.execPath, path.join(fakeBin, "node"));
      fs.writeFileSync(
        path.join(stateDir, "onboard-session.json"),
        JSON.stringify({ sandboxName: "created-by-onboard", agent: "hermes" }),
      );
      writeExecutable(
        path.join(fakeBin, "openshell"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OPENSHELL_LOG"
case "$1 $2" in
  "forward list")
    echo "SANDBOX BIND PORT PID STATUS"
    echo "created-by-onboard 127.0.0.1 8647 123 running"
    ;;
esac
exit 0
`,
      );

      writeExecutable(path.join(fakeBin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
      writeExecutable(path.join(fakeBin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");

      const restoreEnv = {
        HOME: tempDir,
        NEMOCLAW_SKIP_FORWARD_WATCHER: "1",
        OPENSHELL_LOG: openshellLog,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
      };
      const restore = () =>
        callInstallerPayloadFn("restore_onboard_forward_after_post_checks", restoreEnv);

      const missingRegistry = restore();
      expect(missingRegistry.status).toBe(1);
      expect(missingRegistry.stderr).toContain(
        "registered API port for sandbox 'created-by-onboard' is unavailable or invalid",
      );

      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({ sandboxes: { "created-by-onboard": {} } }),
      );
      const restoredLegacyPort = restore();
      expect(restoredLegacyPort.status).toBe(0);
      expect(fs.readFileSync(openshellLog, "utf-8")).toContain(
        "forward start --background 8642 created-by-onboard",
      );
      fs.writeFileSync(openshellLog, "");

      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: { "created-by-onboard": { hermesApiPort: 8647 } },
        }),
      );
      const restored = restore();

      expect(restored.status).toBe(0);
      const openshellCalls = fs.readFileSync(openshellLog, "utf-8");
      expect(openshellCalls).toContain("forward stop 8647 created-by-onboard");
      expect(openshellCalls).toContain("forward start --background 8647 created-by-onboard");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});
