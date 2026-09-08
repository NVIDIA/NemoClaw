// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const INSTALLER = path.join(import.meta.dirname, "../..", "install.sh");
const temporaryDirectories: string[] = [];

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function runInstall(
  installedVersion: string,
  targetVersion: string,
  extraEnvironment: Record<string, string> = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-downgrade-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  const payloadMarker = path.join(root, "payload-ran");
  fs.mkdirSync(bin);
  writeExecutable(
    path.join(bin, "nemoclaw"),
    `#!/usr/bin/env bash
printf 'nemoclaw v%s\n' "${installedVersion}"
`,
  );
  writeExecutable(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
repo=''
if [[ "\${1:-}" == '-C' ]]; then
  repo="$2"
  shift 2
fi
case "\${1:-}" in
  init)
    target="\${@: -1}"
    mkdir -p "$target/scripts"
    cat >"$target/scripts/install.sh" <<'PAYLOAD'
#!/usr/bin/env bash
# NEMOCLAW_VERSIONED_INSTALLER_PAYLOAD=1
touch "\${EXECUTION_MARKER:?}"
PAYLOAD
    chmod +x "$target/scripts/install.sh"
    ;;
  rev-parse)
    printf 'target-commit\n'
    ;;
  ls-remote)
    printf 'target-commit\trefs/tags/v%s\n' "${targetVersion}"
    ;;
esac
`,
  );

  const result = spawnSync("bash", [], {
    cwd: root,
    input: fs.readFileSync(INSTALLER),
    encoding: "utf8",
    env: {
      HOME: root,
      PATH: `${bin}:/usr/bin:/bin`,
      EXECUTION_MARKER: payloadMarker,
      ...extraEnvironment,
    },
  });
  return { result, payloadMarker };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("public installer downgrade guard", () => {
  it("keeps the installed CLI when the implicit lkg release is older (#10948)", () => {
    const { result, payloadMarker } = runInstall("0.0.118", "0.0.109");

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Refusing to replace installed NemoClaw v0.0.118 with maintained lkg v0.0.109.",
    );
    expect(`${result.stdout}${result.stderr}`).toContain("The installed CLI was not changed.");
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it("runs the selected payload when the implicit lkg release is newer", () => {
    const { result, payloadMarker } = runInstall("0.0.108", "0.0.109");

    expect(result.status).toBe(0);
    expect(fs.existsSync(payloadMarker)).toBe(true);
  });

  it("runs an older release when the user selects its tag", () => {
    const { result, payloadMarker } = runInstall("0.0.118", "0.0.109", {
      NEMOCLAW_INSTALL_TAG: "v0.0.109",
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(payloadMarker)).toBe(true);
  });

  it("keeps the installed CLI when the implicit lkg version cannot be verified", () => {
    const { result, payloadMarker } = runInstall("0.0.118", "unknown");

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Cannot verify the maintained lkg version before replacing installed NemoClaw v0.0.118.",
    );
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });
});
