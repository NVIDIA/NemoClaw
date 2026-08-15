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

type CommandFixture = {
  appSliceDropIn: string;
  command: string;
  delegationDropIn: string;
  environment: NodeJS.ProcessEnv;
  installCallMarker: string;
};

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

function makeCommandFixture(): CommandFixture {
  const root = makeTemporaryDirectory();
  const delegationDropIn = path.join(root, "system", "90-nemoclaw-cpu-delegation.conf");
  const appSliceDropIn = path.join(root, "user", "90-nemoclaw-cpu-controller.conf");
  const fakeBin = path.join(root, "bin");
  const installCallMarker = path.join(root, "install-call");
  const sudo = path.join(fakeBin, "sudo");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    sudo,
    `#!/bin/sh
set -eu
if [ "\${1-}" = install ]; then
  install_call=1
  if [ -e "$INSTALL_CALL_MARKER" ]; then
    install_call=$(( $(cat "$INSTALL_CALL_MARKER") + 1 ))
  fi
  printf '%s\\n' "$install_call" > "$INSTALL_CALL_MARKER"
  if [ "$install_call" -eq "\${FAIL_INSTALL_CALL:-0}" ]; then
    printf '%s\\n' 'simulated directory creation failure' >&2
    exit 73
  fi
  shift
  exec install -d -m 0755 -- "$9"
fi
if [ "\${1-}" = dd ]; then
  case "\${SUDO_SCENARIO:-}" in
    concurrent)
      printf '%s\\n' 'concurrent content' > "$FAILURE_TARGET"
      ;;
    partial)
      printf '%s\\n' 'partial content' > "$FAILURE_TARGET"
      printf '%s\\n' 'simulated dd write failure' >&2
      exit 74
      ;;
  esac
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
    );

  return {
    appSliceDropIn,
    command,
    delegationDropIn,
    environment: {
      ...process.env,
      FAILURE_TARGET: delegationDropIn,
      INSTALL_CALL_MARKER: installCallMarker,
      LC_ALL: "C",
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
    installCallMarker,
  };
}

function runDocumentedCommand(fixture: CommandFixture, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", fixture.command], {
    encoding: "utf8",
    env: { ...fixture.environment, ...environment },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable CPU delegation documentation", () => {
  it("does not replace a drop-in created after the existence check (#9195)", () => {
    const fixture = makeCommandFixture();
    const result = runDocumentedCommand(fixture, { SUDO_SCENARIO: "concurrent" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("File exists");
    expect(result.stderr).toContain(
      `CPU controller drop-in creation failed: ${fixture.delegationDropIn}`,
    );
    expect(result.stderr).not.toContain("Refusing to replace existing file");
    expect(fs.readFileSync(fixture.delegationDropIn, "utf8")).toBe("concurrent content\n");
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
  });

  it.each([1, 2])(
    "does not create a drop-in when directory creation command %i fails (#9195)",
    (failedInstallCall) => {
      const fixture = makeCommandFixture();
      const result = runDocumentedCommand(fixture, {
        FAIL_INSTALL_CALL: String(failedInstallCall),
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("simulated directory creation failure");
      expect(fs.readFileSync(fixture.installCallMarker, "utf8")).toBe(`${failedInstallCall}\n`);
      expect(fs.existsSync(fixture.delegationDropIn)).toBe(false);
      expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
    },
  );

  it("reports a partial-file failure without classifying it as a collision (#9195)", () => {
    const fixture = makeCommandFixture();
    const result = runDocumentedCommand(fixture, { SUDO_SCENARIO: "partial" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("simulated dd write failure");
    expect(result.stderr).toContain(
      `CPU controller drop-in creation failed: ${fixture.delegationDropIn}`,
    );
    expect(result.stderr).not.toContain("Refusing to replace existing file");
    expect(fs.readFileSync(fixture.delegationDropIn, "utf8")).toBe("partial content\n");
    expect(fs.existsSync(fixture.appSliceDropIn)).toBe(false);
  });
});
