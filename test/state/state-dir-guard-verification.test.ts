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

const VERIFY_OPENCLAW_NATIVE_MUTABLE_MODES = String.raw`
import importlib.util
import json
import os
import stat
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location("nemoclaw_state_dir_guard", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(
    root_uid=os.getuid(),
    root_gid=os.getgid(),
    sandbox_uid=os.getuid(),
    sandbox_gid=os.getgid(),
)

def verify(
    config_path,
    root_name,
    action,
    checked_identity=identity,
    root_mode=0o755,
    file_mode=0o600,
    nested_directory_mode=0o755,
):
    with tempfile.TemporaryDirectory() as temp_root:
        root_path = os.path.join(temp_root, root_name)
        os.mkdir(root_path, root_mode)
        os.chmod(root_path, root_mode)
        record_path = os.path.join(root_path, "paired.json")
        with open(record_path, "w", encoding="utf-8") as record:
            record.write("{}")
        os.chmod(record_path, file_mode)
        nested_path = os.path.join(root_path, "nested")
        os.mkdir(nested_path, nested_directory_mode)
        os.chmod(nested_path, nested_directory_mode)
        root_fd = os.open(root_path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            context = module.TraversalContext(
                -1,
                config_path,
                os.fstat(root_fd).st_dev,
                (root_name,),
                module.WorkBudget(time.monotonic() + 10),
            )
            issues = []
            module._verify_dir(
                context,
                root_fd,
                root_name,
                "high-risk",
                action,
                checked_identity,
                {},
                issues,
                1,
                is_root=True,
            )
            return [issue.as_json() for issue in issues]
        finally:
            os.close(root_fd)

def verify_native_metadata(entry_type, mode):
    kind = stat.S_IFDIR if entry_type == "directory" else stat.S_IFREG
    entry = os.stat_result(
        (kind | mode, 1, 1, 1, os.getuid(), os.getgid(), 0, 0, 0, 0)
    )
    issue = module._verify_metadata(
        f"/sandbox/.openclaw/devices/{entry_type}",
        entry,
        entry_type,
        "high-risk",
        "unlock",
        identity,
        allow_openclaw_native_mutable=True,
    )
    return None if issue is None else issue.as_json()

wrong_owner = module.Identity(
    root_uid=os.getuid() + 1,
    root_gid=os.getgid(),
    sandbox_uid=os.getuid() + 1,
    sandbox_gid=os.getgid(),
)
print(json.dumps({
    "devices-unlock": verify("/sandbox/.openclaw", "devices", "unlock"),
    "devices-private-directory": verify(
        "/sandbox/.openclaw", "devices", "unlock", root_mode=0o700
    ),
    "devices-nested-private-directory": verify(
        "/sandbox/.openclaw", "devices", "unlock", nested_directory_mode=0o700
    ),
    "devices-normal-directory": verify_native_metadata("directory", 0o2770),
    "devices-normal-file": verify_native_metadata("file", 0o660),
    "other-root-unlock": verify("/sandbox/.openclaw", "skills", "unlock"),
    "other-config-unlock": verify("/tmp/.openclaw", "devices", "unlock"),
    "devices-lock": verify("/sandbox/.openclaw", "devices", "lock"),
    "devices-wrong-owner": verify(
        "/sandbox/.openclaw", "devices", "unlock", wrong_owner
    ),
    "devices-unsafe-directory": verify(
        "/sandbox/.openclaw", "devices", "unlock", root_mode=0o777
    ),
    "devices-unsafe-file": verify(
        "/sandbox/.openclaw", "devices", "unlock", file_mode=0o644
    ),
}))
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

  it("accepts native OpenClaw devices modes only while restoring mutable state (#8112)", () => {
    const result = spawnSync(
      "python3",
      ["-I", "-c", VERIFY_OPENCLAW_NATIVE_MUTABLE_MODES, GUARD_PATH],
      { encoding: "utf-8" },
    );

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const outcomes = JSON.parse(result.stdout) as Record<string, Array<{ code: string }> | null>;
    expect(outcomes["devices-unlock"]).toEqual([]);
    expect(outcomes["devices-private-directory"]).toEqual([]);
    expect(outcomes["devices-nested-private-directory"]).toEqual([]);
    expect(outcomes["devices-normal-directory"]).toBeNull();
    expect(outcomes["devices-normal-file"]).toBeNull();
    expect(outcomes["other-root-unlock"]).toContainEqual(
      expect.objectContaining({
        code: "verification-mode-mismatch",
        path: "/sandbox/.openclaw/skills",
        detail: "directory mode is 0755, expected 2770",
      }),
    );
    expect(outcomes["other-config-unlock"]).toContainEqual(
      expect.objectContaining({
        code: "verification-mode-mismatch",
        path: "/tmp/.openclaw/devices",
        detail: "directory mode is 0755, expected 2770",
      }),
    );
    expect(outcomes["devices-lock"]).toContainEqual(
      expect.objectContaining({
        code: "verification-mode-mismatch",
        path: "/sandbox/.openclaw/devices/paired.json",
        detail:
          "high-risk file does not preserve owner read/execute access for the sandbox group: 0600",
      }),
    );
    expect(outcomes["devices-wrong-owner"]).toContainEqual(
      expect.objectContaining({
        code: "verification-owner-mismatch",
        path: "/sandbox/.openclaw/devices",
        detail: expect.any(String),
      }),
    );
    expect(outcomes["devices-unsafe-directory"]).toContainEqual(
      expect.objectContaining({
        code: "verification-mode-mismatch",
        path: "/sandbox/.openclaw/devices",
      }),
    );
    expect(outcomes["devices-unsafe-file"]).toContainEqual(
      expect.objectContaining({
        code: "verification-mode-mismatch",
        path: "/sandbox/.openclaw/devices/paired.json",
        detail: "mutable file mode does not satisfy g+rwX,o-rwx: 0644",
      }),
    );
  });
});
