// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const INSTALLER = path.join(__dirname, "..", "install.sh");
const CURL_PIPE_INSTALLER = path.join(__dirname, "..", "scripts", "install.sh");
const GITHUB_INSTALL_URL = "git+https://github.com/NVIDIA/NemoClaw.git";
const TEST_SYSTEM_PATH = "/usr/bin:/bin";

function writeExecutable(target, contents) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

describe("installer runtime preflight", () => {
  it("fails fast with a clear message on unsupported Node.js and npm", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-preflight-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "v18.19.1"
  exit 0
fi
echo "unexpected node invocation: $*" >&2
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "9.8.1"
  exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 98
`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /Unsupported runtime detected/);
    assert.match(output, /Node\.js >=20 and npm >=10/);
    assert.match(output, /v18\.19\.1/);
    assert.match(output, /9\.8\.1/);
  });

  it("uses the HTTPS GitHub fallback when not installing from a repo checkout", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-fallback-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const npmLog = path.join(tmp, "npm.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "v22.14.0"
  exit 0
fi
echo "unexpected node invocation: $*" >&2
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$NPM_LOG_PATH"
if [ "$1" = "--version" ]; then
  echo "10.9.2"
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  echo "$NPM_PREFIX"
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "-g" ] && [ "$3" = "${GITHUB_INSTALL_URL}" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "onboard" ]; then
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "v0.1.0-test"
  exit 0
fi
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 98
`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NPM_PREFIX: prefix,
        NPM_LOG_PATH: npmLog,
      },
    });

    assert.equal(result.status, 0);
    assert.match(fs.readFileSync(npmLog, "utf-8"), new RegExp(`install -g ${GITHUB_INSTALL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("prints the HTTPS GitHub remediation when the binary is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-remediation-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "v22.14.0"
  exit 0
fi
echo "unexpected node invocation: $*" >&2
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then
  echo "10.9.2"
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  echo "$NPM_PREFIX"
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "-g" ] && [ "$3" = "${GITHUB_INSTALL_URL}" ]; then
  exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 98
`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NPM_PREFIX: prefix,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, new RegExp(GITHUB_INSTALL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(output, /npm install -g nemoclaw/);
  });

  it("does not silently prefer Colima when both macOS runtimes are available", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-macos-runtime-choice-"));
    const fakeBin = path.join(tmp, "bin");
    const colimaSocket = path.join(tmp, ".colima/default/docker.sock");
    const dockerDesktopSocket = path.join(tmp, ".docker/run/docker.sock");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then
  echo "v22.14.0"
  exit 0
fi
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "10.9.2"
  exit 0
fi
echo "/tmp/npm-prefix"
exit 0
`,
    );

    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = "info" ]; then
  exit 1
fi
exit 0
`,
    );

    writeExecutable(
      path.join(fakeBin, "colima"),
      `#!/usr/bin/env bash
echo "colima should not be started" >&2
exit 97
`,
    );

    writeExecutable(
      path.join(fakeBin, "uname"),
      `#!/usr/bin/env bash
if [ "$1" = "-s" ]; then
  echo "Darwin"
  exit 0
fi
if [ "$1" = "-m" ]; then
  echo "arm64"
  exit 0
fi
echo "Darwin"
`,
    );

    const result = spawnSync("bash", [CURL_PIPE_INSTALLER], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_TEST_SOCKET_PATHS: `${colimaSocket}:${dockerDesktopSocket}`,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /Both Colima and Docker Desktop are available/);
    assert.doesNotMatch(output, /colima should not be started/);
  });

  it("can run via stdin without a sibling runtime.sh file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-pipe-installer-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then
  echo "v22.14.0"
  exit 0
fi
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then
  echo "10.9.2"
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
  echo "$NPM_PREFIX"
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "-g" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "v0.1.0-test"
  exit 0
fi
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 98
`,
    );

    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = "info" ]; then
  exit 0
fi
exit 0
`,
    );

    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.9"
  exit 0
fi
exit 0
`,
    );

    const scriptContents = fs.readFileSync(CURL_PIPE_INSTALLER, "utf-8");
    const result = spawnSync("bash", [], {
      cwd: tmp,
      input: scriptContents,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NPM_PREFIX: prefix,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0);
    assert.match(output, /Installation complete!/);
    assert.match(output, /nemoclaw v0\.1\.0-test is ready/);
  });
});
