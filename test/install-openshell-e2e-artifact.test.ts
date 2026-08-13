// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh");
const OPENSHELL_FEATURE_MARKERS =
  "request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods";
const OPENSHELL_MCP_FEATURE_MARKER = "allow_all_known_mcp_methods";

type InstallFixture = {
  assetDirectory: string;
  fakeBin: string;
  networkLog: string;
  temporaryDirectory: string;
};

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function createFixture(): InstallFixture {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-openshell-dev-assets-"),
  );
  const fakeBin = path.join(temporaryDirectory, "bin");
  const assetDirectory = path.join(temporaryDirectory, "assets");
  const networkLog = path.join(temporaryDirectory, "network.log");
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(assetDirectory);
  const assets = [
    "openshell-x86_64-unknown-linux-musl.tar.gz",
    "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
    "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz",
  ];
  for (const asset of assets) fs.writeFileSync(path.join(assetDirectory, asset), asset);
  const digest = "a".repeat(64);
  fs.writeFileSync(
    path.join(assetDirectory, "openshell-checksums-sha256.txt"),
    `${digest}  ${assets[0]}\n`,
  );
  fs.writeFileSync(
    path.join(assetDirectory, "openshell-gateway-checksums-sha256.txt"),
    `${digest}  ${assets[1]}\n`,
  );
  fs.writeFileSync(
    path.join(assetDirectory, "openshell-sandbox-checksums-sha256.txt"),
    `${digest}  ${assets[2]}\n`,
  );

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
  writeExecutable(
    path.join(fakeBin, "sha256sum"),
    '#!/usr/bin/env bash\n[ "$1" = "-c" ] && [ "$2" = "-" ] || exit 92\ncat >/dev/null\necho "checksum OK"',
  );
  writeExecutable(
    path.join(fakeBin, "tar"),
    `#!/usr/bin/env bash
case "$*" in
*openshell-gateway*) name="openshell-gateway" ;;
*openshell-sandbox*) name="openshell-sandbox" ;;
*) name="openshell" ;;
esac
case "\${1:-}" in
-tzf) printf '%s\\n' "$name"; exit 0 ;;
-tvzf) printf '%s\\n' "-rwxr-xr-x 0/0 1 2026-01-01 00:00 $name"; exit 0 ;;
esac
outdir=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "-C" ]; then outdir="$argument"; break; fi
  previous="$argument"
done
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$outdir/$name"
chmod 755 "$outdir/$name"`,
  );
  writeExecutable(
    path.join(fakeBin, "install"),
    `#!/usr/bin/env bash
destination="\${@: -1}"
mkdir -p "$(dirname "$destination")"
case "$(basename "$destination")" in
openshell)
  printf '#!/usr/bin/env bash\\nif [ "$1" = "--version" ]; then echo "openshell 0.0.106-dev.1+gabc12345"; exit 0; fi\\n# ${OPENSHELL_FEATURE_MARKERS}\\nexit 0\\n' > "$destination" ;;
openshell-gateway)
  printf '#!/usr/bin/env bash\\nif [ "$1" = "--version" ]; then echo "openshell-gateway 0.0.106-dev.1+gabc12345"; exit 0; fi\\nexit 0\\n' > "$destination" ;;
openshell-sandbox)
  printf '#!/usr/bin/env bash\\nif [ "$1" = "--version" ]; then echo "openshell-sandbox 0.0.106-dev.1+gabc12345"; exit 0; fi\\n# ${OPENSHELL_MCP_FEATURE_MARKER}\\nexit 0\\n' > "$destination" ;;
*) exit 93 ;;
esac
chmod 755 "$destination"`,
  );
  return { assetDirectory, fakeBin, networkLog, temporaryDirectory };
}

function runInstaller(fixture: InstallFixture, e2eJob: boolean) {
  return spawnSync("bash", [SCRIPT], {
    env: {
      ...process.env,
      HOME: fixture.temporaryDirectory,
      XDG_BIN_HOME: path.join(fixture.temporaryDirectory, "local-bin"),
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
      expect(result.stderr).toContain(
        "NEMOCLAW_E2E_OPENSHELL_RELEASE_ASSET_DIR is restricted to E2E jobs.",
      );
    } finally {
      fs.rmSync(fixture.temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("installs verified assets without a network fallback (#9051)", () => {
    const fixture = createFixture();
    try {
      const result = runInstaller(fixture, true);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Using the same-run verified OpenShell dev artifact.");
      expect(result.stdout).toContain("Loading same-run verified OpenShell release assets");
      expect(fs.existsSync(fixture.networkLog)).toBe(false);
    } finally {
      fs.rmSync(fixture.temporaryDirectory, { force: true, recursive: true });
    }
  });
});
