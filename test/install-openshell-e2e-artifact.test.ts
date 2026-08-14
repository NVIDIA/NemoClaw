// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh");
const FEATURE_MARKERS =
  "request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods";

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-dev-assets-"));
  const assetDirectory = path.join(root, "assets");
  const fakeBin = path.join(root, "bin");
  const source = path.join(root, "source");
  const networkLog = path.join(root, "network.log");
  fs.mkdirSync(assetDirectory);
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(source);

  const archives = [
    ["openshell-x86_64-unknown-linux-musl.tar.gz", "openshell", "openshell-checksums-sha256.txt"],
    [
      "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
      "openshell-gateway",
      "openshell-gateway-checksums-sha256.txt",
    ],
    [
      "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz",
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
    `#!/usr/bin/env bash\nif [ "\${1:-}" = "-m" ]; then echo x86_64; else echo Linux; fi`,
  );
  writeExecutable(
    path.join(fakeBin, "openshell"),
    `#!/usr/bin/env bash\nif [ "\${1:-}" = "--version" ]; then echo "openshell 0.0.36"; exit 0; fi\nexit 99`,
  );
  for (const command of ["gh", "curl"]) {
    writeExecutable(
      path.join(fakeBin, command),
      `#!/usr/bin/env bash\nprintf '%s\\n' '${command}' >> ${JSON.stringify(networkLog)}\nexit 91`,
    );
  }
  return { assetDirectory, fakeBin, networkLog, root };
}

function runInstaller(fixture: ReturnType<typeof createFixture>, e2eJob: boolean) {
  return spawnSync("bash", [SCRIPT], {
    env: {
      ...process.env,
      XDG_BIN_HOME: path.join(fixture.root, "local-bin"),
      ...(e2eJob ? { E2E_JOB: "1" } : {}),
      NEMOCLAW_E2E_OPENSHELL_RELEASE_ASSET_DIR: fixture.assetDirectory,
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      NEMOCLAW_OPENSHELL_FORCE_INSTALL: "1",
      PATH: `${fixture.fakeBin}:/usr/bin:/bin`,
    },
    encoding: "utf8",
  });
}

describe("OpenShell same-run E2E artifact installation", () => {
  it("rejects the internal artifact directory outside E2E (#9051)", () => {
    const fixture = createFixture();
    try {
      const result = runInstaller(fixture, false);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("restricted to E2E jobs");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("installs retained assets without a network fallback (#9051)", () => {
    const fixture = createFixture();
    try {
      const result = runInstaller(fixture, true);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Using the same-run verified OpenShell dev artifact");
      expect(fs.existsSync(fixture.networkLog)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
