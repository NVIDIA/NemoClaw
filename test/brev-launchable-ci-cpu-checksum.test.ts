// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "brev-launchable-ci-cpu.sh");
const BREV_LIFECYCLE_SCRIPT_MAX_BYTES = 16 * 1024;
const ASSET = "openshell-x86_64-unknown-linux-musl.tar.gz";
const PINNED_ASSET_SHA256 = "37836c3b50383e03249c5e16512c1806e591fba8451408a84fb2f628ddb318c4";

type FakeSystemOptions = {
  checksum: "match" | "mismatch" | "unpinned";
  nodeSourceChecksumTool?: boolean;
  openshellVersion?: string;
};

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function linkSystemCommands(targetDir: string, commands: readonly string[]): void {
  for (const command of commands) {
    const source = [`/usr/bin/${command}`, `/bin/${command}`].find((candidate) =>
      fs.existsSync(candidate),
    );
    expect(source, `Required test command is unavailable: ${command}`).toBeDefined();
    fs.symlinkSync(source as string, path.join(targetDir, command));
  }
}

function makeFakeSystem(options: FakeSystemOptions): {
  cleanup: () => void;
  cloneDir: string;
  curlLog: string;
  dockerLog: string;
  fakeBin: string;
  launchLog: string;
  sudoLog: string;
  tarLog: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-brev-checksum-"));
  const fakeBin = path.join(root, "bin");
  const cloneDir = path.join(root, "NemoClaw");
  const launchLog = path.join(root, "launch.log");
  const curlLog = path.join(root, "curl.log");
  const dockerLog = path.join(root, "docker.log");
  const sudoLog = path.join(root, "sudo.log");
  const tarLog = path.join(root, "tar.log");
  fs.mkdirSync(fakeBin);

  linkSystemCommands(
    fakeBin,
    options.nodeSourceChecksumTool === false
      ? ["bash", "basename", "cut", "date", "dirname", "head", "mkdir", "mktemp", "rm", "tee"]
      : [],
  );

  writeExecutable(
    path.join(fakeBin, "uname"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-m" ]; then printf 'x86_64\\n'; else printf 'Linux\\n'; fi
`,
  );
  writeExecutable(
    path.join(fakeBin, "id"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-un" ]; then printf 'tester\\n'; else /usr/bin/id "$@"; fi
`,
  );
  writeExecutable(
    path.join(fakeBin, "getent"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "passwd" ]; then printf 'tester:x:1000:1000::${root}:/bin/bash\\n'; exit 0; fi
exit 1
`,
  );
  writeExecutable(
    path.join(fakeBin, "fuser"),
    `#!/usr/bin/env bash
exit 1
`,
  );
  writeExecutable(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(dockerLog)}
if [ "\${1:-}" = "--version" ]; then printf 'Docker version 25.0.0\\n'; exit 0; fi
if [ "\${1:-}" = "image" ] && [ "\${2:-}" = "inspect" ]; then exit 1; fi
exit 0
`,
  );
  writeExecutable(
    path.join(fakeBin, "sg"),
    `#!/usr/bin/env bash
if [ "\${1:-}" != "docker" ] || [ "\${2:-}" != "-c" ]; then exit 2; fi
shift 2
exec bash -c "\${1:-}"
`,
  );
  writeExecutable(
    path.join(fakeBin, "node"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-p" ]; then printf '${options.nodeSourceChecksumTool === false ? "20" : "22"}\\n'; exit 0; fi
if [ "\${1:-}" = "--version" ]; then printf 'v22.16.0\\n'; exit 0; fi
exit 0
`,
  );
  writeExecutable(
    path.join(fakeBin, "npm"),
    `#!/usr/bin/env bash
printf 'npm stub %s\\n' "$*"
exit 0
`,
  );
  writeExecutable(
    path.join(fakeBin, "git"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "clone" ]; then
  dest="\${@: -1}"
  mkdir -p "$dest/.git" "$dest/nemoclaw" "$dest/bin"
  printf '#!/usr/bin/env node\\n' > "$dest/bin/nemoclaw.js"
  exit 0
fi
exit 0
`,
  );
  writeExecutable(
    path.join(fakeBin, "tar"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(tarLog)}
exec /usr/bin/tar "$@"
`,
  );
  writeExecutable(
    path.join(fakeBin, "sudo"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(sudoLog)}
if [ "\${1:-}" = "install" ]; then
  shift
  if [ "\${1:-}" = "-m" ]; then shift 2; fi
  src="\${1:-}"
  cp "$src" ${JSON.stringify(path.join(fakeBin, "openshell"))}
  chmod +x ${JSON.stringify(path.join(fakeBin, "openshell"))}
  exit 0
fi
if [ "\${1:-}" = "tee" ]; then
  shift
  if [ "\${1:-}" = "-a" ]; then
    shift
    cat >> "$1"
  else
    cat >/dev/null
  fi
  exit 0
fi
exit 0
`,
  );
  writeExecutable(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(curlLog)}
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    out="$1"
  fi
  shift || true
done
case "$(basename "$out")" in
  ${ASSET})
    tmp="$(mktemp -d)"
    printf '#!/usr/bin/env bash\\nprintf "openshell 0.0.72\\\\n"\\n' > "$tmp/openshell"
    chmod +x "$tmp/openshell"
    /usr/bin/tar -czf "$out" -C "$tmp" openshell
    rm -rf "$tmp"
    ;;
  openshell-checksums-sha256.txt)
    if [ ${JSON.stringify(options.checksum)} = "unpinned" ]; then
      digest="0000000000000000000000000000000000000000000000000000000000000000"
    else
      digest=${JSON.stringify(PINNED_ASSET_SHA256)}
    fi
    printf '%s  %s\\n' "$digest" "${ASSET}" > "$out"
    ;;
  *)
    : > "$out"
    ;;
esac
exit 0
`,
  );
  writeExecutable(
    path.join(
      fakeBin,
      options.nodeSourceChecksumTool === false ? "sha256sum-unavailable" : "sha256sum",
    ),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-c" ]; then
  cat >/dev/null
  if [ ${JSON.stringify(options.checksum)} = "mismatch" ]; then
    printf '%s: FAILED\\n' ${JSON.stringify(ASSET)} >&2
    exit 1
  fi
  printf '%s: OK\\n' ${JSON.stringify(ASSET)}
  exit 0
fi
exec /usr/bin/sha256sum "$@"
`,
  );

  return {
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    cloneDir,
    curlLog,
    dockerLog,
    fakeBin,
    launchLog,
    sudoLog,
    tarLog,
  };
}

function runLaunchable(options: FakeSystemOptions) {
  const fake = makeFakeSystem(options);
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: {
      ...process.env,
      LAUNCH_LOG: fake.launchLog,
      NEMOCLAW_CLONE_DIR: fake.cloneDir,
      OPENSHELL_VERSION: options.openshellVersion ?? "v0.0.72",
      PATH:
        options.nodeSourceChecksumTool === false ? fake.fakeBin : `${fake.fakeBin}:/usr/bin:/bin`,
      SUDO_USER: "tester",
    },
    timeout: 20_000,
  });
  return { fake, result };
}

function combinedLaunchableOutput(result: ReturnType<typeof spawnSync>, launchLog: string): string {
  return [
    result.stdout || "",
    result.stderr || "",
    fs.existsSync(launchLog) ? fs.readFileSync(launchLog, "utf-8") : "",
  ].join("\n");
}

describe("brev-launchable-ci-cpu.sh OpenShell checksum gate", { timeout: 30_000 }, () => {
  it("fits within Brev's lifecycle setup-script limit", () => {
    expect(fs.statSync(SCRIPT).size).toBeLessThanOrEqual(BREV_LIFECYCLE_SCRIPT_MAX_BYTES);
  });

  it("rejects malformed OPENSHELL_VERSION before downloads or privileged setup", () => {
    const { fake, result } = runLaunchable({
      checksum: "match",
      openshellVersion: "v0.0.72;touch /tmp/nemoclaw-version-injection",
    });
    try {
      const out = combinedLaunchableOutput(result, fake.launchLog);
      expect(result.status, out).toBe(1);
      expect(out).toContain("Invalid OPENSHELL_VERSION");
      expect(fs.existsSync(fake.curlLog) ? fs.readFileSync(fake.curlLog, "utf-8") : "").toBe("");
      expect(fs.existsSync(fake.tarLog) ? fs.readFileSync(fake.tarLog, "utf-8") : "").toBe("");
      expect(fs.existsSync(fake.sudoLog) ? fs.readFileSync(fake.sudoLog, "utf-8") : "").not.toMatch(
        /^install -m 755 .*openshell/m,
      );
    } finally {
      fake.cleanup();
    }
  });

  it("rejects a tampered OpenShell CLI asset before tar or sudo install", () => {
    const { fake, result } = runLaunchable({ checksum: "mismatch" });
    try {
      const out = combinedLaunchableOutput(result, fake.launchLog);
      expect(result.status, out).toBe(1);
      expect(out).toContain(`OpenShell CLI checksum verification failed for ${ASSET}`);
      expect(fs.existsSync(fake.tarLog) ? fs.readFileSync(fake.tarLog, "utf-8") : "").toBe("");
      expect(fs.existsSync(fake.sudoLog) ? fs.readFileSync(fake.sudoLog, "utf-8") : "").not.toMatch(
        /^install -m 755 .*openshell/m,
      );
    } finally {
      fake.cleanup();
    }
  });

  it("rejects a same-release checksum file that disagrees with the NemoClaw-pinned digest", () => {
    const { fake, result } = runLaunchable({ checksum: "unpinned" });
    try {
      const out = combinedLaunchableOutput(result, fake.launchLog);
      expect(result.status, out).toBe(1);
      expect(out).toContain(
        `OpenShell release checksum for ${ASSET} does not match NemoClaw-pinned v0.0.72 digest`,
      );
      expect(fs.existsSync(fake.tarLog) ? fs.readFileSync(fake.tarLog, "utf-8") : "").toBe("");
      expect(fs.existsSync(fake.sudoLog) ? fs.readFileSync(fake.sudoLog, "utf-8") : "").not.toMatch(
        /^install -m 755 .*openshell/m,
      );
    } finally {
      fake.cleanup();
    }
  });

  it("refuses to run the NodeSource installer as root when no SHA-256 tool is available", () => {
    const { fake, result } = runLaunchable({
      checksum: "match",
      nodeSourceChecksumTool: false,
    });
    try {
      const out = combinedLaunchableOutput(result, fake.launchLog);
      const sudoLog = fs.existsSync(fake.sudoLog) ? fs.readFileSync(fake.sudoLog, "utf-8") : "";
      expect(result.status, out).toBe(1);
      expect(out).toContain("No SHA-256 tool available (sha256sum/shasum)");
      expect(fs.readFileSync(fake.curlLog, "utf-8")).toContain(
        "https://deb.nodesource.com/setup_22.x",
      );
      expect(sudoLog).not.toMatch(/^-E bash /m);
      expect(out).not.toContain("NodeSource installer integrity verified");
    } finally {
      fake.cleanup();
    }
  });

  it("extracts and installs the OpenShell CLI when the checksum matches", () => {
    const { fake, result } = runLaunchable({ checksum: "match" });
    try {
      const out = combinedLaunchableOutput(result, fake.launchLog);
      expect(result.status, out).toBe(0);
      expect(out).toContain("OpenShell CLI installed: openshell 0.0.72");
      expect(fs.readFileSync(fake.tarLog, "utf-8")).toContain(`xzf`);
      const sudoLog = fs.readFileSync(fake.sudoLog, "utf-8");
      expect(sudoLog).toMatch(/^install -m 755 .*openshell/m);
      expect(sudoLog).toContain("usermod -aG docker tester");
      expect(sudoLog).not.toMatch(/chmod\s+(?:0?666|a\+rw)\s+[^\n]*docker\.sock/u);
      expect(fs.readFileSync(fake.dockerLog, "utf-8").trim().split("\n")).toEqual([
        "--version",
        "--version",
      ]);
      expect(out).toContain("CI-Ready CPU launchable setup complete");
    } finally {
      fake.cleanup();
    }
  });
});
