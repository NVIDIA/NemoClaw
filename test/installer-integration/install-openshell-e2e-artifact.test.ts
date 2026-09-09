// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER = path.join(import.meta.dirname, "../..", "scripts", "install-openshell.sh");
const COPY_HELPER = path.join(
  import.meta.dirname,
  "../..",
  ".github",
  "scripts",
  "copy-openshell-dev-asset.sh",
);
const FEATURE_MARKERS =
  "request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods";

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function createFixture(architecture: "x86_64" | "aarch64" = "x86_64") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-dev-assets-"));
  const assetDirectory = path.join(root, "assets");
  const fakeBin = path.join(root, "bin");
  const source = path.join(root, "source");
  fs.mkdirSync(assetDirectory);
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(source);

  const cliArchitecture = architecture === "x86_64" ? "x86_64" : "aarch64";
  const archives = [
    [
      `openshell-${cliArchitecture}-unknown-linux-musl.tar.gz`,
      "openshell",
      "openshell-checksums-sha256.txt",
    ],
    [
      `openshell-gateway-${architecture}-unknown-linux-gnu.tar.gz`,
      "openshell-gateway",
      "openshell-gateway-checksums-sha256.txt",
    ],
    [
      `openshell-sandbox-${architecture}-unknown-linux-musl.tar.gz`,
      "openshell-sandbox",
      "openshell-sandbox-checksums-sha256.txt",
    ],
  ] as const;
  for (const [archive, binary, checksum] of archives) {
    writeExecutable(
      path.join(source, binary),
      `#!/usr/bin/env bash\nif [ "\${1:-}" = "--version" ]; then echo "${binary} 0.0.106-dev.1+gabc12345"; exit 0; fi\n# ${FEATURE_MARKERS}\nexit 0\n`,
    );
    const archivePath = path.join(assetDirectory, archive);
    const tar = spawnSync("tar", ["czf", archivePath, "-C", source, binary]);
    expect(tar.status, `unable to create ${archive}`).toBe(0);
    const digest = createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
    fs.writeFileSync(path.join(assetDirectory, checksum), `${digest}  ${archive}\n`);
  }
  writeExecutable(
    path.join(fakeBin, "uname"),
    `#!/usr/bin/env bash\nif [ "\${1:-}" = "-m" ]; then echo ${architecture}; else echo Linux; fi`,
  );
  writeExecutable(
    path.join(fakeBin, "openshell"),
    `#!/usr/bin/env bash\nif [ "\${1:-}" = "--version" ]; then echo "openshell 0.0.36"; exit 0; fi\nexit 99`,
  );
  return { assetDirectory, fakeBin, root };
}

function runInstaller(fixture: ReturnType<typeof createFixture>) {
  writeExecutable(
    path.join(fixture.fakeBin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
asset="$7"
destination="$9"
bash "$OPENSHELL_DEV_COPY_HELPER" "$OPENSHELL_DEV_ASSET_DIR" "$asset" "$destination"`,
  );
  writeExecutable(
    path.join(fixture.fakeBin, "curl"),
    `#!/usr/bin/env bash
printf 'Network fallback is disabled for retained OpenShell assets.\n' >&2
exit 1`,
  );
  return spawnSync("bash", [INSTALLER], {
    env: {
      ...process.env,
      NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      NEMOCLAW_OPENSHELL_FORCE_INSTALL: "1",
      OPENSHELL_DEV_ASSET_DIR: fixture.assetDirectory,
      OPENSHELL_DEV_COPY_HELPER: COPY_HELPER,
      PATH: `${fixture.fakeBin}:/usr/bin:/bin`,
      XDG_BIN_HOME: path.join(fixture.root, "local-bin"),
    },
    encoding: "utf8",
  });
}

describe("OpenShell retained E2E artifact installation", () => {
  it("runs retained assets through the trusted installer without network fallback (#9051)", () => {
    const fixture = createFixture();
    try {
      const result = runInstaller(fixture);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Verifying SHA-256 checksum");
      expect(result.stderr).not.toContain("Network fallback is disabled");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("installs the arm64 development MUSL sandbox with retained-artifact checksum verification", () => {
    const fixture = createFixture("aarch64");
    try {
      const result = runInstaller(fixture);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Verifying SHA-256 checksum");
      expect(result.stderr).not.toContain("Network fallback is disabled");
      expect(fs.existsSync(path.join(fixture.fakeBin, "openshell-sandbox"))).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects retained bytes that do not match their release checksum (#9051)", () => {
    const fixture = createFixture();
    try {
      fs.appendFileSync(
        path.join(fixture.assetDirectory, "openshell-x86_64-unknown-linux-musl.tar.gz"),
        "tampered",
      );
      const result = runInstaller(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("SHA-256 checksum verification failed");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("blocks network fallback when a retained asset is a symbolic link (#9051)", () => {
    const fixture = createFixture();
    try {
      const archive = path.join(
        fixture.assetDirectory,
        "openshell-x86_64-unknown-linux-musl.tar.gz",
      );
      fs.rmSync(archive);
      fs.symlinkSync(path.join(fixture.root, "source", "openshell"), archive);
      const result = runInstaller(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Network fallback is disabled for retained OpenShell assets");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
