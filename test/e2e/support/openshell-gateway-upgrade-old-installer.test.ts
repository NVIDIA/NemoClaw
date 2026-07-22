// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OLD_INSTALLER_ADVISORY_AUDIT,
  OLD_INSTALLER_BOOTSTRAP_NEEDLE,
  OLD_INSTALLER_CLONE_NEEDLE,
  patchOldInstallerFixture,
  reviewedOldOpenClawArchive,
} from "../live/openshell-gateway-upgrade-old-installer.ts";

const temporaryDirectories: string[] = [];

function writeHistoricalFixture(advisoryAuditCount = 1): {
  archive: string;
  dockerfile: string;
  installer: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-old-upgrade-installer-"));
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "source");
  const dockerfile = path.join(sourceRoot, "Dockerfile");
  const archive = path.join(root, "reviewed-openclaw.tgz");
  const payload = path.join(root, "payload.sh");
  const installer = path.join(root, "install.sh");
  fs.mkdirSync(sourceRoot);
  fs.writeFileSync(archive, "reviewed fixture archive");

  fs.writeFileSync(
    dockerfile,
    [
      "FROM fixture",
      "ARG OPENCLAW_VERSION=2026.5.27",
      ...Array.from({ length: advisoryAuditCount }, () => OLD_INSTALLER_ADVISORY_AUDIT.trimEnd()),
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
      OLD_INSTALLER_CLONE_NEEDLE.trimEnd(),
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
      OLD_INSTALLER_BOOTSTRAP_NEEDLE.trimEnd(),
      '"$payload_script"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return { archive, dockerfile, installer };
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
      env: {
        ...process.env,
        NEMOCLAW_OLD_OPENCLAW_ARCHIVE: fixture.archive,
        NEMOCLAW_OLD_OPENCLAW_VERSION: "2026.5.27",
      },
    });
    expect(result.status, result.stderr).toBe(0);

    const dockerfile = fs.readFileSync(fixture.dockerfile, "utf8");
    expect(
      fs.readFileSync(
        path.join(path.dirname(fixture.dockerfile), ".nemoclaw-e2e-old-openclaw.tgz"),
        "utf8",
      ),
    ).toBe("reviewed fixture archive");
    expect(dockerfile).toContain(
      "COPY .nemoclaw-e2e-old-openclaw.tgz /tmp/nemoclaw-e2e-old-openclaw.tgz",
    );
    expect(dockerfile).toContain(
      "npm install -g --ignore-scripts --no-audit --no-fund --no-progress /tmp/nemoclaw-e2e-old-openclaw.tgz",
    );
    expect(dockerfile).not.toMatch(/npm install -g [^\n]*openclaw@/u);
    expect(dockerfile).not.toContain("audit --omit=dev --audit-level=low");
    expect(dockerfile).toContain(
      "Skipping current advisory audit for the immutable historical mcporter lock",
    );
    expect(dockerfile).toContain("audit signatures");
  });

  it("rejects an ambiguous historical advisory boundary", () => {
    const fixture = writeHistoricalFixture(2);
    patchOldInstallerFixture(fixture.installer);
    const originalDockerfile = fs.readFileSync(fixture.dockerfile, "utf8");

    const result = spawnSync("bash", [fixture.installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_OLD_OPENCLAW_ARCHIVE: fixture.archive,
        NEMOCLAW_OLD_OPENCLAW_VERSION: "2026.5.27",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("historical mcporter advisory audits; expected exactly one");
    expect(fs.readFileSync(fixture.dockerfile, "utf8")).toBe(originalDockerfile);
  });

  it("rejects a missing historical advisory boundary", () => {
    const fixture = writeHistoricalFixture(0);
    patchOldInstallerFixture(fixture.installer);
    const originalDockerfile = fs.readFileSync(fixture.dockerfile, "utf8");

    const result = spawnSync("bash", [fixture.installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_OLD_OPENCLAW_ARCHIVE: fixture.archive,
        NEMOCLAW_OLD_OPENCLAW_VERSION: "2026.5.27",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "found 0 historical mcporter advisory audits; expected exactly one",
    );
    expect(fs.readFileSync(fixture.dockerfile, "utf8")).toBe(originalDockerfile);
  });

  it.each([
    [
      "2026.4.24",
      "sha512-W6u4XeIIP4+uG4DYV9G3JeS6QNuKwfhQIej1GIoL4BdcnUFgrnB8kHYNXL3MxiHRKuhZB9OYwUMGs8jKFZR/Vg==",
    ],
    [
      "2026.5.22",
      "sha512-m+zgBELGbCHjWB1IWF5WSWNPr480cMKOMff2OF72c8A0AMD4hC/9+qwYtzjYmGkETcffnB711JymlVsQnh2Tow==",
    ],
    [
      "2026.5.27",
      "sha512-2N93zhdAo88KAbHt6T7KvYXf4s7XIkYXBgv1npYpn7e1Y9FvrtgtpsA38my9rtFW+70uXEojRPX5/OqnuDqJPw==",
    ],
  ])("binds historical OpenClaw %s to its reviewed archive", (version, expectedIntegrity) => {
    expect(reviewedOldOpenClawArchive(version)).toEqual({
      expectedIntegrity,
      label: `historical fixture OpenClaw ${version}`,
      packageSpec: `openclaw@${version}`,
      tarballUrl: `https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz`,
    });
  });

  it("rejects an unreviewed historical OpenClaw version", () => {
    expect(() => reviewedOldOpenClawArchive("2026.5.28")).toThrow(/no reviewed archive pin/);
  });
});
