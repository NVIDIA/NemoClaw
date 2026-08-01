// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildAutoPairApprovalScript,
  parseAutoPairApprovalReceipt,
  readAutoPairApprovalPolicyModule,
} from "./auto-pair-approval";

describe("restored-clone state-root traversal (#4616)", () => {
  const pyIt =
    spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status === 0 ? it : it.skip;

  pyIt("traverses the clone layout when root read access is denied", () => {
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const restoredClonePolicy = `${policy}
import errno as _nemoclaw_test_errno
import os as _nemoclaw_test_os
_nemoclaw_test_original_open = _nemoclaw_test_os.open
_nemoclaw_test_synthetic_path_flag = not hasattr(_nemoclaw_test_os, 'O_PATH')
_nemoclaw_test_path_flag = getattr(_nemoclaw_test_os, 'O_PATH', 1 << 30)
if _nemoclaw_test_synthetic_path_flag:
    _nemoclaw_test_os.O_PATH = _nemoclaw_test_path_flag

def _nemoclaw_test_open(path_value, flags, mode=0o777, *, dir_fd=None):
    if (
        dir_fd is None
        and _nemoclaw_test_os.fspath(path_value) == _nemoclaw_test_os.sep
        and not flags & _nemoclaw_test_path_flag
    ):
        raise PermissionError(
            _nemoclaw_test_errno.EACCES,
            'restored clone denies a read-directory handle for the filesystem root',
        )
    effective_flags = (
        flags & ~_nemoclaw_test_path_flag
        if _nemoclaw_test_synthetic_path_flag
        else flags
    )
    return _nemoclaw_test_original_open(path_value, effective_flags, mode, dir_fd=dir_fd)

_nemoclaw_test_os.open = _nemoclaw_test_open
`;
    const script = buildAutoPairApprovalScript(
      Buffer.from(restoredClonePolicy, "utf-8").toString("base64"),
      {
        emitReceipt: true,
        localDeviceOnly: true,
        budget: { maxApprovals: 1 },
      },
    );
    const legacyScript = script.replace("getattr(os, 'O_PATH', os.O_RDONLY)", "os.O_RDONLY");
    const tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restored-root-")),
    );
    try {
      const stateDir = path.join(tmpDir, "sandbox", ".openclaw");
      fs.mkdirSync(path.join(stateDir, "devices"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "openclaw"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const run = (approvalScript: string) =>
        spawnSync("sh", {
          encoding: "utf-8",
          input: approvalScript,
          env: {
            ...process.env,
            PATH: `${tmpDir}:/usr/bin:/bin`,
            OPENCLAW_STATE_DIR: stateDir,
          },
          timeout: 10_000,
        });

      expect(parseAutoPairApprovalReceipt(run(legacyScript).stdout)).toBe("list-state-root-failed");
      expect(parseAutoPairApprovalReceipt(run(script).stdout)).toBe("list-pending-unavailable");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
