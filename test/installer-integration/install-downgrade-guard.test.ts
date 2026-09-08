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
case "${installedVersion}" in
  hang) /bin/sleep 60 ;;
  ignore-term) trap '' TERM; while :; do :; done ;;
  invalid) printf 'not a NemoClaw version\n' ;;
  *) printf 'nemoclaw v%s\n' "${installedVersion}" ;;
esac
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
    if [[ "${targetVersion}" == 'hang' ]]; then
      /bin/sleep 60
    elif [[ "${targetVersion}" == annotated-* ]]; then
      version="${targetVersion.replace(/^annotated-/, "")}"
      printf 'tag-object\trefs/tags/v%s\n' "$version"
      printf 'target-commit\trefs/tags/v%s^{}\n' "$version"
    else
      printf 'target-commit\trefs/tags/v%s\n' "${targetVersion}"
    fi
    ;;
esac
`,
  );
  const sleepBody =
    ["hang", "ignore-term"].includes(installedVersion) || targetVersion === "hang"
      ? "#!/usr/bin/env bash\nexit 0\n"
      : '#!/usr/bin/env bash\nexec /bin/sleep "$@"\n';
  writeExecutable(path.join(bin, "sleep"), sleepBody);

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

  it("runs the selected payload when the implicit lkg release is unchanged", () => {
    const { result, payloadMarker } = runInstall("0.0.109", "0.0.109");

    expect(result.status).toBe(0);
    expect(fs.existsSync(payloadMarker)).toBe(true);
  });

  it("keeps a newer installed prerelease when the implicit lkg release is older", () => {
    const { result, payloadMarker } = runInstall("0.0.119-rc.1", "0.0.118");

    expect(result.status).toBe(1);
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it("accepts the peeled commit from an annotated maintained release tag", () => {
    const { result, payloadMarker } = runInstall("0.0.108", "annotated-0.0.109");

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

  it("keeps the installed CLI when lkg is selected explicitly", () => {
    const { result, payloadMarker } = runInstall("0.0.118", "0.0.109", {
      NEMOCLAW_INSTALL_TAG: "lkg",
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it("keeps the installed CLI when the fully qualified lkg tag is selected", () => {
    const { result, payloadMarker } = runInstall("0.0.118", "0.0.109", {
      NEMOCLAW_INSTALL_TAG: "refs/tags/lkg",
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it("fails closed when the installed CLI reports an invalid version", () => {
    const { result, payloadMarker } = runInstall("invalid", "0.0.109");

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Cannot verify the installed NemoClaw version",
    );
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it("keeps the installed CLI when the implicit lkg version cannot be verified", () => {
    const { result, payloadMarker } = runInstall("0.0.118", "unknown");

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Cannot verify the maintained lkg version before replacing installed NemoClaw v0.0.118.",
    );
    expect(fs.existsSync(payloadMarker)).toBe(false);
  });

  it.each([
    ["installed NemoClaw version lookup", "hang", "0.0.109"],
    ["installed NemoClaw version lookup", "ignore-term", "0.0.109"],
    ["maintained release tag lookup", "0.0.108", "hang"],
  ])(
    "bounds the %s",
    (label, installedVersion, targetVersion) => {
      const { result, payloadMarker } = runInstall(installedVersion, targetVersion);

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(`Timed out during ${label}`);
      expect(`${result.stdout}${result.stderr}`).toContain("The installed CLI was not changed.");
      expect(fs.existsSync(payloadMarker)).toBe(false);
    },
    15_000,
  );
});
