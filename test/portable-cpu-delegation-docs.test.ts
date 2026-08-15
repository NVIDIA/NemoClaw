// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const troubleshootingPath = path.join(repoRoot, "docs", "reference", "troubleshooting.mdx");
const temporaryDirectories: string[] = [];

function extractDropInCreationCommand(): string {
  const markdown = fs.readFileSync(troubleshootingPath, "utf8");
  const sectionStart = markdown.indexOf("Use the two dedicated NemoClaw drop-in paths below.");
  expect(sectionStart).toBeGreaterThanOrEqual(0);

  const section = markdown.slice(sectionStart);
  const block = section.match(/```bash\n([\s\S]*?)\n```/u);
  expect(block).not.toBeNull();
  return block?.[1] ?? "";
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cpu-delegation-docs-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable CPU delegation documentation", () => {
  it("does not replace a drop-in created after the existence check (#9195)", () => {
    const root = makeTemporaryDirectory();
    const delegationDropIn = path.join(root, "system", "90-nemoclaw-cpu-delegation.conf");
    const appSliceDropIn = path.join(root, "user", "90-nemoclaw-cpu-controller.conf");
    const fakeBin = path.join(root, "bin");
    const raceMarker = path.join(root, "race-created");
    const sudo = path.join(fakeBin, "sudo");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      sudo,
      `#!/bin/sh
set -eu
if [ "\${1-}" = dd ] && [ ! -e "$RACE_MARKER" ]; then
  printf '%s\\n' 'concurrent content' > "$RACE_TARGET"
  : > "$RACE_MARKER"
fi
exec "$@"
`,
      { mode: 0o755 },
    );

    const command = extractDropInCreationCommand()
      .replace(
        'delegation_drop_in="/etc/systemd/system/user@.service.d/90-nemoclaw-cpu-delegation.conf"',
        `delegation_drop_in=${JSON.stringify(delegationDropIn)}`,
      )
      .replace(
        'app_slice_drop_in="/etc/systemd/user/app.slice.d/90-nemoclaw-cpu-controller.conf"',
        `app_slice_drop_in=${JSON.stringify(appSliceDropIn)}`,
      )
      .replaceAll("sudo install -d -o root -g root -m 0755 --", "install -d -m 0755 --");

    const result = spawnSync("bash", ["-c", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        RACE_MARKER: raceMarker,
        RACE_TARGET: delegationDropIn,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Refusing to replace existing file: ${delegationDropIn}`);
    expect(fs.readFileSync(delegationDropIn, "utf8")).toBe("concurrent content\n");
    expect(fs.existsSync(appSliceDropIn)).toBe(false);
  });
});
