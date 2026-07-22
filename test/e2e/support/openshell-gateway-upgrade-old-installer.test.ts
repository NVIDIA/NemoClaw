// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { patchOldInstallerFixture } from "../live/openshell-gateway-upgrade-old-installer.ts";

const temporaryDirectories: string[] = [];

function writeHistoricalFixture(advisoryAuditCount = 1): {
  dockerfile: string;
  installer: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-old-upgrade-installer-"));
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "source");
  const dockerfile = path.join(sourceRoot, "Dockerfile");
  const payload = path.join(root, "payload.sh");
  const installer = path.join(root, "install.sh");
  fs.mkdirSync(sourceRoot);

  const advisoryAudit =
    "    npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime audit --omit=dev --audit-level=low; \\\n";
  fs.writeFileSync(
    dockerfile,
    [
      "FROM fixture",
      "ARG OPENCLAW_VERSION=2026.5.27",
      ...Array.from({ length: advisoryAuditCount }, () => advisoryAudit.trimEnd()),
      "    npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime audit signatures; \\",
      "    true",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    payload,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `nemoclaw_src=${JSON.stringify(sourceRoot)}`,
      "_CLI_DISPLAY=NemoClaw",
      "release_ref=fixture",
      'spin() { shift; "$@"; }',
      "clone_nemoclaw_ref() { :; }",
      '    spin "Cloning ${_CLI_DISPLAY} source" clone_nemoclaw_ref "$release_ref" "$nemoclaw_src"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    installer,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `payload_script=${JSON.stringify(payload)}`,
      `source_root=${JSON.stringify(sourceRoot)}`,
      '  legacy_script="${source_root}/install.sh"',
      '"$payload_script"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return { dockerfile, installer };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("historical OpenShell gateway upgrade installer adapter", () => {
  it("keeps signature verification while isolating current advisory drift", () => {
    const fixture = writeHistoricalFixture();
    patchOldInstallerFixture(fixture.installer);

    const result = spawnSync("bash", [fixture.installer], {
      encoding: "utf8",
      env: { ...process.env, NEMOCLAW_OLD_OPENCLAW_VERSION: "2026.5.27" },
    });
    expect(result.status, result.stderr).toBe(0);

    const dockerfile = fs.readFileSync(fixture.dockerfile, "utf8");
    expect(dockerfile).toContain('openclaw@2026.5.27"');
    expect(dockerfile).not.toContain("audit --omit=dev --audit-level=low");
    expect(dockerfile).toContain(
      "Skipping current advisory audit for the immutable historical mcporter lock",
    );
    expect(dockerfile).toContain("audit signatures");
  });

  it("rejects an ambiguous historical advisory boundary", () => {
    const fixture = writeHistoricalFixture(2);
    patchOldInstallerFixture(fixture.installer);

    const result = spawnSync("bash", [fixture.installer], {
      encoding: "utf8",
      env: { ...process.env, NEMOCLAW_OLD_OPENCLAW_VERSION: "2026.5.27" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("historical mcporter advisory audits; expected at most one");
  });
});
