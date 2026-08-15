// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const GUARD_PATH = path.resolve("scripts/state-dir-guard.py");
const VERIFY_HIGH_RISK_MODES = String.raw`
import importlib.util
import json
import os
import stat
import sys

spec = importlib.util.spec_from_file_location("nemoclaw_state_dir_guard", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(root_uid=0, root_gid=0, sandbox_uid=1000, sandbox_gid=1000)

def verify(mode):
    entry = os.stat_result((stat.S_IFREG | mode, 1, 1, 1, 0, 1000, 0, 0, 0, 0))
    issue = module._verify_metadata(
        "devices/pending.json.nemoclaw-self-approval-journal",
        entry,
        "file",
        "high-risk",
        "lock",
        identity,
    )
    return None if issue is None else issue.as_json()

print(json.dumps({format(mode, "04o"): verify(mode) for mode in (0o600, 0o700, 0o640, 0o750)}))
`;

describe("state directory guard verification", () => {
  it("rejects locked high-risk files that lost sandbox group access (#8304)", () => {
    const result = spawnSync("python3", ["-I", "-c", VERIFY_HIGH_RISK_MODES, GUARD_PATH], {
      encoding: "utf-8",
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const modes = JSON.parse(result.stdout) as Record<string, { code: string } | null>;
    expect(modes["0600"]?.code).toBe("verification-mode-mismatch");
    expect(modes["0700"]?.code).toBe("verification-mode-mismatch");
    expect(modes["0640"]).toBeNull();
    expect(modes["0750"]).toBeNull();
  });
});
