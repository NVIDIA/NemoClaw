// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe.each(["install.sh", "install-openshell.sh"])("%s BSD directory metadata", (installer) => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "../../scripts", installer),
    "utf8",
  );
  const guard = source.match(/^user_local_executable_directory_safe\(\) \{[\s\S]*?^\}/m)![0];

  it.skipIf(process.platform === "win32").each([
    {
      name: "accepts a root-owned sticky ancestor",
      owner: 0,
      mode: "1777",
      target: false,
      status: 0,
    },
    {
      name: "rejects a root-owned writable ancestor without sticky permission",
      owner: 0,
      mode: "0777",
      target: false,
      status: 1,
    },
    {
      name: "rejects a user-owned writable sticky ancestor",
      owner: 501,
      mode: "1777",
      target: false,
      status: 1,
    },
    {
      name: "rejects a root-owned writable sticky target",
      owner: 0,
      mode: "1777",
      target: true,
      status: 1,
    },
  ])("$name", ({ owner, mode, target, status }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bsd-directory-"));
    const child = path.join(root, "bin");
    fs.mkdirSync(child);
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${guard}
id() { printf '501\n'; }
stat() {
  [ "$1" = -f ] || return 1
  local owner=501 mode=0755
  if [ "$3" = "$TEST_ANCESTOR" ]; then owner="$TEST_OWNER"; mode="$TEST_MODE"; fi
  # BSD's low permission field excludes the sticky/set-ID bits.
  case "$2" in
    '%u %Lp') printf '%s %s\n' "$owner" "\${mode#?}" ;;
    '%u %Mp%03Lp') printf '%s %s\n' "$owner" "$mode" ;;
    *) return 1 ;;
  esac
}
user_local_executable_directory_safe "$TEST_TARGET"
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            TEST_ANCESTOR: root,
            TEST_TARGET: target ? root : child,
            TEST_OWNER: String(owner),
            TEST_MODE: mode,
          },
        },
      );
      expect(result.status, result.stderr).toBe(status);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
