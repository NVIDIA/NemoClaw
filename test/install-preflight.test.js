// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const INSTALLER = path.join(import.meta.dirname, "..", "install.sh");
const CURL_PIPE_INSTALLER = path.join(import.meta.dirname, "..", "install.sh");
const LEGACY_INSTALLER_WRAPPER = path.join(import.meta.dirname, "..", "scripts", "install.sh");
const GITHUB_INSTALL_URL = "git+https://github.com/NVIDIA/NemoClaw.git";
const TEST_SYSTEM_PATH = "/usr/bin:/bin";

function writeExecutable(target, contents) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Helpers shared across suites
// ---------------------------------------------------------------------------

/** Fake node that reports v22.16.0. */
function writeNodeStub(fakeBin) {
  writeExecutable(
    path.join(fakeBin, "node"),
    `#!/usr/bin/env bash
if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then echo "v22.16.0"; exit 0; fi
if [ "$1" = "-e" ]; then
  if [[ "$2" == *"dependencies.openclaw"* ]]; then
    echo "2026.3.11"
    exit 0
  fi
  exit 0
fi
exit 99`,
  );
}

/**
 * Minimal npm stub. Handles --version, config-get-prefix, and a custom
 * install handler injected as a shell snippet via NPM_INSTALL_HANDLER.
 */
function writeNpmStub(fakeBin, installSnippet = "exit 0") {
  writeExecutable(
    path.join(fakeBin, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then echo "10.9.2"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then echo "$NPM_PREFIX"; exit 0; fi
if [ "$1" = "install" ] || [ "$1" = "link" ] || [ "$1" = "uninstall" ] || [ "$1" = "pack" ] || [ "$1" = "run" ]; then
  ${installSnippet}
fi
echo "unexpected npm invocation: $*" >&2; exit 98`,
  );
}

// ---------------------------------------------------------------------------

describe("installer runtime preflight", () => {
  it("attempts nvm upgrade when system Node.js is below minimum version", () => {
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

    // Fake curl that fails — prevents real nvm download and keeps the test fast.
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
exit 1
`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/v18\.19\.1.*found but NemoClaw requires/);
    expect(output).toMatch(/upgrading via nvm/);
    expect(output).toMatch(/Failed to download nvm installer/);
  });

  it("uses the HTTPS GitHub fallback when not installing from a repo checkout", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-fallback-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const gitLog = path.join(tmp, "git.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "v22.16.0"
  exit 0
fi
if [ "$1" = "-e" ]; then
  exit 1
fi
echo "unexpected node invocation: $*" >&2
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG_PATH"
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.1.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.1.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0
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
if [ "$1" = "pack" ]; then
  exit 1
fi
if [ "$1" = "install" ] && [[ "$*" == *"--ignore-scripts"* ]]; then
  exit 0
fi
if [ "$1" = "run" ]; then
  exit 0
fi
if [ "$1" = "link" ]; then
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
        GIT_LOG_PATH: gitLog,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(gitLog, "utf-8")).toMatch(/clone.*NemoClaw\.git/);
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
  echo "v22.16.0"
  exit 0
fi
if [ "$1" = "-e" ]; then
  exit 1
fi
echo "unexpected node invocation: $*" >&2
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.1.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.1.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0
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
if [ "$1" = "pack" ]; then
  exit 1
fi
if [ "$1" = "install" ] && [[ "$*" == *"--ignore-scripts"* ]]; then
  exit 0
fi
if [ "$1" = "run" ]; then
  exit 0
fi
if [ "$1" = "link" ]; then
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(new RegExp(GITHUB_INSTALL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(output).not.toMatch(/npm install -g nemoclaw/);
  });

  it("legacy scripts/install.sh delegates to the root installer from a repo checkout", () => {
    const result = spawnSync("bash", [LEGACY_INSTALLER_WRAPPER, "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toMatch(/deprecated compatibility wrapper/);
    expect(output).toMatch(/https:\/\/www\.nvidia\.com\/nemoclaw\.sh/);
    expect(output).toMatch(/NemoClaw Installer/);
  });

  it("legacy scripts/install.sh fails clearly when run without the repo root installer", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-legacy-installer-stdin-"));
    const scriptContents = fs.readFileSync(LEGACY_INSTALLER_WRAPPER, "utf-8");
    const result = spawnSync("bash", [], {
      cwd: tmp,
      input: scriptContents,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: TEST_SYSTEM_PATH,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/deprecated compatibility wrapper/);
    expect(output).toMatch(/supported installer/);
    expect(output).toMatch(/https:\/\/www\.nvidia\.com\/nemoclaw\.sh/);
    expect(output).toMatch(/only works from a NemoClaw repository checkout/);
  });

  it("--help exits 0 and shows install usage", () => {
    const result = spawnSync("bash", [INSTALLER, "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/NemoClaw Installer/);
    expect(output).toMatch(/--non-interactive/);
    expect(output).toMatch(/--version/);
    expect(output).toMatch(/NEMOCLAW_PROVIDER/);
    expect(output).toMatch(/NEMOCLAW_POLICY_MODE/);
    expect(output).toMatch(/NEMOCLAW_SANDBOX_NAME/);
    expect(output).toMatch(/nvidia\.com\/nemoclaw\.sh/);
  });

  it("--version exits 0 and prints the version number", () => {
    const result = spawnSync("bash", [INSTALLER, "--version"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/nemoclaw-installer v\d+\.\d+\.\d+/);
  });

  it("-v exits 0 and prints the version number", () => {
    const result = spawnSync("bash", [INSTALLER, "-v"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/nemoclaw-installer v\d+\.\d+\.\d+/);
  });

  it("uses npm install + npm link for a source checkout (no -g)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-source-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const npmLog = path.join(tmp, "npm.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeNodeStub(fakeBin);
    writeNpmStub(
      fakeBin,
      `printf '%s\\n' "$*" >> "$NPM_LOG_PATH"
if [ "$1" = "pack" ]; then
  tmpdir="$4"
  mkdir -p "$tmpdir/package"
  tar -czf "$tmpdir/openclaw-2026.3.11.tgz" -C "$tmpdir" package
  exit 0
fi
if [ "$1" = "install" ]; then exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "build" ]; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "onboard" ] || [ "$1" = "--version" ]; then exit 0; fi
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi`,
    );

    // Write a package.json that triggers the source-checkout path.
    // Must use spaces after colons to match the grep in install.sh.
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "nemoclaw", version: "0.1.0" }, null, 2),
    );
    fs.mkdirSync(path.join(tmp, "nemoclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "nemoclaw", "package.json"),
      JSON.stringify({ name: "nemoclaw-plugin", version: "0.1.0" }, null, 2),
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
        NPM_LOG_PATH: npmLog,
      },
    });

    expect(result.status).toBe(0);
    const log = fs.readFileSync(npmLog, "utf-8");
    // install (no -g) and link must both have been called
    expect(log).toMatch(/^install(?!\s+-g)/m);
    expect(log).toMatch(/^link/m);
    // the GitHub URL must NOT appear — this is a local install
    expect(log).not.toMatch(new RegExp(GITHUB_INSTALL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("auto-resumes an interrupted onboarding session during install", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-resume-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const onboardLog = path.join(tmp, "onboard.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".nemoclaw"), { recursive: true });

    fs.writeFileSync(
      path.join(tmp, ".nemoclaw", "onboard-session.json"),
      JSON.stringify({ resumable: true, status: "in_progress" }, null, 2),
    );

    writeNodeStub(fakeBin);
    writeNpmStub(
      fakeBin,
      `if [ "$1" = "pack" ]; then
  tmpdir="$4"
  mkdir -p "$tmpdir/package"
  tar -czf "$tmpdir/openclaw-2026.3.11.tgz" -C "$tmpdir" package
  exit 0
fi
if [ "$1" = "install" ]; then exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "build" ]; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NEMOCLAW_ONBOARD_LOG"
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi`,
    );

    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "nemoclaw", version: "0.1.0" }, null, 2),
    );
    fs.mkdirSync(path.join(tmp, "nemoclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "nemoclaw", "package.json"),
      JSON.stringify({ name: "nemoclaw-plugin", version: "0.1.0" }, null, 2),
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
        NEMOCLAW_ONBOARD_LOG: onboardLog,
      },
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Found an interrupted onboarding session — resuming it\./);
    expect(fs.readFileSync(onboardLog, "utf-8")).toMatch(/^onboard --resume --non-interactive$/m);
  });

  it("spin() non-TTY: dumps wrapped-command output and exits non-zero on failure", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-spin-fail-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeNodeStub(fakeBin);
    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.1.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.1.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0
`,
    );
    writeNpmStub(
      fakeBin,
      `if [ "$1" = "pack" ]; then
  echo "ENOTFOUND simulated network error" >&2
  exit 1
fi
if [ "$1" = "install" ] || [ "$1" = "run" ] || [ "$1" = "link" ]; then
  echo "ENOTFOUND simulated network error" >&2
  exit 1
fi`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/ENOTFOUND simulated network error/);
  });

  it("creates a user-local shim when npm installs outside the current PATH", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-shim-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".local"), { recursive: true });

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then
  echo "v22.16.0"
  exit 0
fi
if [ "$1" = "-e" ]; then
  exit 1
fi
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.1.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.1.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0
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
if [ "$1" = "pack" ]; then
  exit 1
fi
if [ "$1" = "install" ] && [[ "$*" == *"--ignore-scripts"* ]]; then
  exit 0
fi
if [ "$1" = "run" ]; then
  exit 0
fi
if [ "$1" = "link" ]; then
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

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
      },
    });

    const shimPath = path.join(tmp, ".local", "bin", "nemoclaw");
    expect(result.status).toBe(0);
    expect(fs.readlinkSync(shimPath)).toBe(path.join(prefix, "bin", "nemoclaw"));
    expect(`${result.stdout}${result.stderr}`).toMatch(/Created user-local shim/);
  });

  it("does not print PATH recovery instructions when nemoclaw is already usable in this shell", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-ready-shell-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const nvmDir = path.join(tmp, ".nvm");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.writeFileSync(path.join(nvmDir, "nvm.sh"), "# stub nvm\n");

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then
  echo "v22.16.0"
  exit 0
fi
if [ "$1" = "-e" ]; then
  exit 1
fi
exit 99
`,
    );

    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.1.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.1.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0
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
if [ "$1" = "pack" ]; then
  exit 1
fi
if [ "$1" = "install" ] && [[ "$*" == *"--ignore-scripts"* ]]; then
  exit 0
fi
if [ "$1" = "run" ]; then
  exit 0
fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "onboard" ] || [ "$1" = "--version" ]; then
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

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
        NVM_DIR: nvmDir,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).not.toMatch(/current shell cannot resolve 'nemoclaw'/);
    expect(output).not.toMatch(/source .*\.bashrc|source .*\.zshrc|source .*\.profile/);
  });
});

// ---------------------------------------------------------------------------
// Release-tag resolution — install.sh should clone the latest GitHub release
// tag instead of defaulting to main.
// ---------------------------------------------------------------------------

describe("installer release-tag resolution", () => {
  /**
   * Helper: call resolve_release_tag() in isolation by sourcing install.sh.
   * Requires the source guard so that main() doesn't run on source.
   * `fakeBin` must contain a `curl` stub (and optionally `node`).
   */
  function callResolveReleaseTag(fakeBin, env = {}) {
    return spawnSync(
      "bash",
      [
        "-c",
        `source "${INSTALLER}" 2>/dev/null; resolve_release_tag`,
      ],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          HOME: os.tmpdir(),
          PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
          ...env,
        },
      },
    );
  }

  it("returns the tag_name from the GitHub releases API", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-tag-ok-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    // curl stub that returns a realistic GitHub releases/latest JSON snippet
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
cat <<'EOF'
{
  "tag_name": "v0.3.0",
  "name": "NemoClaw v0.3.0"
}
EOF`,
    );
    writeExecutable(path.join(fakeBin, "node"), "#!/usr/bin/env bash\nexit 1");

    const result = callResolveReleaseTag(fakeBin);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("v0.3.0");
  });

  it("falls back to 'main' when curl fails (network error)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-tag-neterr-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    // curl stub that fails
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
exit 1`,
    );
    writeExecutable(path.join(fakeBin, "node"), "#!/usr/bin/env bash\nexit 1");

    const result = callResolveReleaseTag(fakeBin);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("main");
  });

  it("falls back to 'main' when API returns garbage JSON", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-tag-garbage-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    // curl stub that returns nonsense
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
echo "502 Bad Gateway"`,
    );
    writeExecutable(path.join(fakeBin, "node"), "#!/usr/bin/env bash\nexit 1");

    const result = callResolveReleaseTag(fakeBin);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("main");
  });

  it("uses NEMOCLAW_INSTALL_TAG override without calling curl", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-tag-override-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    // curl stub that would fail — must NOT be called
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
echo "curl should not be called" >&2
exit 99`,
    );
    writeExecutable(path.join(fakeBin, "node"), "#!/usr/bin/env bash\nexit 1");

    const result = callResolveReleaseTag(fakeBin, {
      NEMOCLAW_INSTALL_TAG: "v0.2.0",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("v0.2.0");
  });

  it("falls back to 'main' when tag_name has no 'v' prefix (e.g. 'release-1.0')", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-tag-noprefix-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
echo '{"tag_name":"release-1.0","name":"NemoClaw release-1.0"}'`,
    );
    writeExecutable(path.join(fakeBin, "node"), "#!/usr/bin/env bash\nexit 1");

    const result = callResolveReleaseTag(fakeBin);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("main");
  });

  it("accepts partial semver tags like 'v1' or 'v1.2'", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-tag-partial-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
echo '{"tag_name":"v1.2","name":"NemoClaw v1.2"}'`,
    );
    writeExecutable(path.join(fakeBin, "node"), "#!/usr/bin/env bash\nexit 1");

    const result = callResolveReleaseTag(fakeBin);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("v1.2");
  });

  it("falls back to 'main' when API returns empty JSON object", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-tag-empty-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
echo '{}'`,
    );
    writeExecutable(path.join(fakeBin, "node"), "#!/usr/bin/env bash\nexit 1");

    const result = callResolveReleaseTag(fakeBin);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("main");
  });

  it("source-checkout path does NOT call resolve_release_tag / git clone", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-source-notag-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const gitLog = path.join(tmp, "git.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeNodeStub(fakeBin);
    writeNpmStub(
      fakeBin,
      `if [ "$1" = "pack" ]; then exit 1; fi
if [ "$1" = "install" ] || [ "$1" = "run" ]; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "onboard" ] || [ "$1" = "--version" ]; then exit 0; fi
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi`,
    );

    // curl stub that would fail — must NOT be called
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
echo "curl should not be called for source checkout" >&2
exit 99`,
    );

    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG_PATH"
exit 0`,
    );

    // Write package.json that triggers source-checkout path
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "nemoclaw", version: "0.1.0", dependencies: { openclaw: "2026.3.11" } }, null, 2),
    );
    fs.mkdirSync(path.join(tmp, "nemoclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "nemoclaw", "package.json"),
      JSON.stringify({ name: "nemoclaw-plugin", version: "0.1.0" }, null, 2),
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
        GIT_LOG_PATH: gitLog,
      },
    });

    expect(result.status).toBe(0);
    // git should NOT have been called at all in the source-checkout path
    expect(fs.existsSync(gitLog)).toBe(false);
    // And curl for the releases API should NOT have been called
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/curl should not be called/);
  });

  it("full install: git clone receives --branch with the resolved release tag", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-tag-e2e-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const gitLog = path.join(tmp, "git.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeNodeStub(fakeBin);

    // curl stub: returns a release tag for the API URL, passes through otherwise
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == *"api.github.com/repos/NVIDIA/NemoClaw/releases/latest"* ]]; then
    echo '{"tag_name":"v0.5.0","name":"NemoClaw v0.5.0"}'
    exit 0
  fi
done
# Fall through to real curl for anything else (e.g. nvm)
/usr/bin/curl "$@"`,
    );

    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG_PATH"
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.5.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.5.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0`,
    );

    writeNpmStub(
      fakeBin,
      `if [ "$1" = "pack" ]; then exit 1; fi
if [ "$1" = "install" ] || [ "$1" = "run" ]; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "onboard" ] || [ "$1" = "--version" ]; then exit 0; fi
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
        GIT_LOG_PATH: gitLog,
      },
    });

    expect(result.status).toBe(0);
    const gitCalls = fs.readFileSync(gitLog, "utf-8");
    expect(gitCalls).toMatch(/--branch v0\.5\.0/);
  });
});

// ---------------------------------------------------------------------------
// Pure helper functions — sourced and tested in isolation.
// ---------------------------------------------------------------------------

describe("installer pure helpers", () => {
  /**
   * Helper: source install.sh and call a function, returning stdout.
   */
  function callInstallerFn(fnCall, env = {}) {
    return spawnSync(
      "bash",
      ["-c", `source "${INSTALLER}" 2>/dev/null; ${fnCall}`],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          HOME: os.tmpdir(),
          PATH: TEST_SYSTEM_PATH,
          ...env,
        },
      },
    );
  }

  // -- version_gte --

  it("version_gte: equal versions return 0", () => {
    const r = callInstallerFn('version_gte "1.2.3" "1.2.3" && echo yes || echo no');
    expect(r.stdout.trim()).toBe("yes");
  });

  it("version_gte: higher major returns 0", () => {
    const r = callInstallerFn('version_gte "2.0.0" "1.9.9" && echo yes || echo no');
    expect(r.stdout.trim()).toBe("yes");
  });

  it("version_gte: lower major returns 1", () => {
    const r = callInstallerFn('version_gte "0.17.0" "0.18.0" && echo yes || echo no');
    expect(r.stdout.trim()).toBe("no");
  });

  it("version_gte: higher minor returns 0", () => {
    const r = callInstallerFn('version_gte "0.19.0" "0.18.0" && echo yes || echo no');
    expect(r.stdout.trim()).toBe("yes");
  });

  it("version_gte: higher patch returns 0", () => {
    const r = callInstallerFn('version_gte "0.18.1" "0.18.0" && echo yes || echo no');
    expect(r.stdout.trim()).toBe("yes");
  });

  it("version_gte: lower patch returns 1", () => {
    const r = callInstallerFn('version_gte "0.18.0" "0.18.1" && echo yes || echo no');
    expect(r.stdout.trim()).toBe("no");
  });

  // -- version_major --

  it("version_major: strips v prefix", () => {
    const r = callInstallerFn('version_major "v22.14.0"');
    expect(r.stdout.trim()).toBe("22");
  });

  it("version_major: works without v prefix", () => {
    const r = callInstallerFn('version_major "10.9.2"');
    expect(r.stdout.trim()).toBe("10");
  });

  it("version_major: single digit", () => {
    const r = callInstallerFn('version_major "v8"');
    expect(r.stdout.trim()).toBe("8");
  });

  // -- resolve_installer_version --

  it("resolve_installer_version: reads version from package.json", () => {
    const r = callInstallerFn("resolve_installer_version");
    // Should read from the repo's actual package.json
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("resolve_installer_version: falls back to DEFAULT when no package.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-ver-"));
    // source from a directory with no package.json — SCRIPT_DIR will be wrong
    const r = spawnSync(
      "bash",
      ["-c", `SCRIPT_DIR="${tmp}"; source "${INSTALLER}" 2>/dev/null; resolve_installer_version`],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: { HOME: tmp, PATH: TEST_SYSTEM_PATH },
      },
    );
    expect(r.stdout.trim()).toBe("0.1.0");
  });

  // -- resolve_default_sandbox_name --

  it("resolve_default_sandbox_name: returns 'my-assistant' with no registry", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sandbox-name-"));
    const r = callInstallerFn("resolve_default_sandbox_name", { HOME: tmp });
    expect(r.stdout.trim()).toBe("my-assistant");
  });

  it("resolve_default_sandbox_name: reads defaultSandbox from registry", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sandbox-name-reg-"));
    const registryDir = path.join(tmp, ".nemoclaw");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: "work-bot",
        sandboxes: { "work-bot": {}, "test-bot": {} },
      }),
    );
    const r = callInstallerFn("resolve_default_sandbox_name", {
      HOME: tmp,
      PATH: `${process.env.PATH}`,
    });
    expect(r.stdout.trim()).toBe("work-bot");
  });

  it("resolve_default_sandbox_name: honors NEMOCLAW_SANDBOX_NAME env var", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sandbox-name-env-"));
    const r = callInstallerFn("resolve_default_sandbox_name", {
      HOME: tmp,
      NEMOCLAW_SANDBOX_NAME: "my-custom-name",
    });
    expect(r.stdout.trim()).toBe("my-custom-name");
  });
});

// ---------------------------------------------------------------------------
// main() flag parsing edge cases
// ---------------------------------------------------------------------------

describe("installer flag parsing", () => {
  it("rejects unknown flags with usage + error", () => {
    const result = spawnSync("bash", [INSTALLER, "--bogus"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/Unknown option: --bogus/);
    expect(output).toMatch(/NemoClaw Installer/); // usage was printed
  });

  it("--help shows NEMOCLAW_INSTALL_TAG in environment section", () => {
    const result = spawnSync("bash", [INSTALLER, "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/NEMOCLAW_INSTALL_TAG/);
  });
});

// ---------------------------------------------------------------------------
// ensure_supported_runtime — missing binary paths
// ---------------------------------------------------------------------------

describe("installer runtime checks (sourced)", () => {
  /**
   * Call ensure_supported_runtime() in isolation by sourcing install.sh.
   * This avoids triggering install_nodejs() which would download real nvm.
   */
  function callEnsureSupportedRuntime(fakeBin, env = {}) {
    return spawnSync(
      "bash",
      ["-c", `source "${INSTALLER}" 2>/dev/null; ensure_supported_runtime`],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          HOME: os.tmpdir(),
          PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
          ...env,
        },
      },
    );
  }

  it("fails with clear message when node is missing entirely", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-no-node-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    // npm exists but node does not
    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
echo "10.9.2"`,
    );

    const result = callEnsureSupportedRuntime(fakeBin);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Node\.js was not found on PATH/);
  });

  it("fails with clear message when npm is missing entirely", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-no-npm-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "v22.14.0"; exit 0; fi
exit 0`,
    );

    const result = callEnsureSupportedRuntime(fakeBin);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/npm was not found on PATH/);
  });

  it("succeeds with acceptable Node.js 22.16 and npm 10", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-ok-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "v22.16.0"; exit 0; fi
exit 0`,
    );
    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "10.0.0"; exit 0; fi
exit 0`,
    );

    const result = callEnsureSupportedRuntime(fakeBin);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Runtime OK/);
  });

  it("rejects Node.js 20 which is below the 22.16 minimum", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-node20-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "v20.18.0"; exit 0; fi
exit 0`,
    );
    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "10.9.2"; exit 0; fi
exit 0`,
    );

    const result = callEnsureSupportedRuntime(fakeBin);

    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/Unsupported runtime detected/);
    expect(output).toMatch(/v20\.18\.0/);
  });

  it("rejects node that returns a non-numeric version", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-badver-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "nope"; exit 0; fi
exit 0`,
    );
    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "10.9.2"; exit 0; fi
exit 0`,
    );

    const result = callEnsureSupportedRuntime(fakeBin);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Could not determine Node\.js version/);
  });
});

// ---------------------------------------------------------------------------
// scripts/install.sh (curl-pipe installer) release-tag resolution
// ---------------------------------------------------------------------------

describe("curl-pipe installer release-tag resolution", () => {
  /**
   * Build the full fakeBin environment needed to run scripts/install.sh.
   * Unlike install.sh, this script also requires docker, openshell, and
   * uname stubs because it runs everything top-to-bottom with no main().
   */
  function buildCurlPipeEnv(tmp, { curlStub, gitStub }) {
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const gitLog = path.join(tmp, "git.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then echo "v22.16.0"; exit 0; fi
if [ "$1" = "-e" ]; then exit 1; fi
exit 99`,
    );

    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "--version" ]; then echo "10.9.2"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then echo "$NPM_PREFIX"; exit 0; fi
if [ "$1" = "pack" ]; then exit 1; fi
if [ "$1" = "install" ] && [[ "$*" == *"--ignore-scripts"* ]]; then exit 0; fi
if [ "$1" = "run" ]; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "v0.5.0-test"; exit 0; fi
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi
echo "unexpected npm invocation: $*" >&2; exit 98`,
    );

    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = "info" ]; then exit 0; fi
exit 0`,
    );

    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "openshell 0.0.9"; exit 0; fi
exit 0`,
    );

    writeExecutable(path.join(fakeBin, "curl"), curlStub);
    writeExecutable(path.join(fakeBin, "git"), gitStub);

    return { fakeBin, prefix, gitLog };
  }

  it("git clone receives --branch with the resolved release tag", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-pipe-tag-e2e-"));
    const { fakeBin, prefix, gitLog } = buildCurlPipeEnv(tmp, {
      curlStub: `#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == *"api.github.com/repos/NVIDIA/NemoClaw/releases/latest"* ]]; then
    echo '{"tag_name":"v0.5.0","name":"NemoClaw v0.5.0"}'
    exit 0
  fi
done
/usr/bin/curl "$@"`,
      gitStub: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG_PATH"
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.5.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.5.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0`,
    });

    const result = spawnSync("bash", [CURL_PIPE_INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
        GIT_LOG_PATH: gitLog,
      },
    });

    expect(result.status).toBe(0);
    const gitCalls = fs.readFileSync(gitLog, "utf-8");
    expect(gitCalls).toMatch(/--branch v0\.5\.0/);
  });

  it("falls back to 'main' when the GitHub API is unreachable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-pipe-tag-fail-"));
    const { fakeBin, prefix, gitLog } = buildCurlPipeEnv(tmp, {
      curlStub: `#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == *"api.github.com"* ]]; then
    exit 1
  fi
done
/usr/bin/curl "$@"`,
      gitStub: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG_PATH"
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.1.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.1.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0`,
    });

    const result = spawnSync("bash", [CURL_PIPE_INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
        GIT_LOG_PATH: gitLog,
      },
    });

    expect(result.status).toBe(0);
    const gitCalls = fs.readFileSync(gitLog, "utf-8");
    expect(gitCalls).toMatch(/--branch main/);
  });

  it("uses NEMOCLAW_INSTALL_TAG override without calling the API", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-pipe-tag-override-"));
    const { fakeBin, prefix, gitLog } = buildCurlPipeEnv(tmp, {
      curlStub: `#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == *"api.github.com"* ]]; then
    echo "curl should not hit the releases API" >&2
    exit 99
  fi
done
/usr/bin/curl "$@"`,
      gitStub: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG_PATH"
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw"
  echo '{"name":"nemoclaw","version":"0.2.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.2.0"}' > "$target/nemoclaw/package.json"
  exit 0
fi
exit 0`,
    });

    const result = spawnSync("bash", [CURL_PIPE_INSTALLER], {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NPM_PREFIX: prefix,
        GIT_LOG_PATH: gitLog,
        NEMOCLAW_INSTALL_TAG: "v0.2.0",
      },
    });

    expect(result.status).toBe(0);
    const gitCalls = fs.readFileSync(gitLog, "utf-8");
    expect(gitCalls).toMatch(/--branch v0\.2\.0/);
    // Confirm the releases API was NOT called
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/curl should not hit the releases API/);
  });
});
