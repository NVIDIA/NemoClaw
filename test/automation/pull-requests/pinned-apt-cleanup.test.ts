// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("removes APT lists when creating the isolated Ubuntu source fails (#11320)", () => {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-apt-cleanup-"));
  const fakeBin = join(root, "bin");
  const runnerTemp = join(root, "runner-temp");
  const calls = join(root, "sudo-calls");
  mkdirSync(fakeBin);
  mkdirSync(runnerTemp, { mode: 0o700 });
  writeFileSync(calls, "");
  writeFileSync(
    join(fakeBin, "sudo"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$APT_CALLS"
if [[ "$1" == rm ]]; then "$@"; fi
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(fakeBin, "mktemp"),
    `#!/usr/bin/env bash
if [[ "$1" == -d && "$2" == /tmp/nemoclaw-ubuntu-sources.* ]]; then exit 73; fi
exec /usr/bin/mktemp "$@"
`,
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(
      "bash",
      [
        join(process.cwd(), ".github/actions/ci-install-pinned-ubuntu-packages.sh"),
        "fd-find=9.0.0-1",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          APT_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: runnerTemp,
        },
      },
    );
    expect(result.status).toBe(73);
    const cleanupCalls = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .filter((call) => call.startsWith("rm -rf -- "));
    expect(cleanupCalls).toHaveLength(1);
    const listPath = cleanupCalls[0]?.slice("rm -rf -- ".length);
    expect(listPath).toMatch(/^\/tmp\/nemoclaw-apt-lists\.\S+$/u);
    expect(existsSync(listPath ?? "")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
