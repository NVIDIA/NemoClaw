// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const INSTALLER = path.join(import.meta.dirname, "..", "install.sh");
const CURL_PIPE_INSTALLER = path.join(import.meta.dirname, "..", "install.sh");
const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");
const GITHUB_INSTALL_URL = "git+https://github.com/NVIDIA/NemoClaw.git";
/**
 * Build an isolated "system bin" directory used by every test in this file
 * via TEST_SYSTEM_PATH. The directory mirrors /usr/bin and /bin via symlinks
 * — EXCEPT for `node`, `npm`, and `npx`, which are deliberately excluded.
 *
 * Why: the runtime preflight tests need a PATH where the host's real `node`
 * and `npm` are NOT visible, so the "node missing" / "npm missing" error
 * branches are actually exercised. The previous `"/usr/bin:/bin"` literal
 * leaks /usr/bin/node on any Linux distribution that installs Node via
 * `apt install nodejs` (i.e. most of them), causing those tests to assert
 * the wrong code path on developer machines while passing on the upstream
 * CI runners (where Node is installed under /opt/hostedtoolcache/, not
 * /usr/bin/).
 *
 * Tests that need a fake `node` or `npm` continue to write a stub into
 * `fakeBin` and prepend it to PATH (`${fakeBin}:${TEST_SYSTEM_PATH}`); the
 * fake still wins because it comes first.
 *
 * The directory lives under `os.tmpdir()` and is intentionally not cleaned
 * up — it's tiny (a few hundred symlinks), the OS reaps it on reboot, and
 * cleanup would require an `afterAll` hook in every describe block.
 */
function buildIsolatedSystemPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preflight-sysbin-"));
  const EXCLUDE = new Set(["node", "npm", "npx"]);
  for (const sysDir of ["/usr/bin", "/bin"]) {
    if (!fs.existsSync(sysDir)) continue;
    for (const name of fs.readdirSync(sysDir)) {
      if (EXCLUDE.has(name)) continue;
      try {
        fs.symlinkSync(path.join(sysDir, name), path.join(dir, name));
      } catch (err) {
        // Only swallow EEXIST — the expected case is when /bin is a symlink
        // to /usr/bin (modern Linux) and we already linked the same name on
        // the first pass. Any other error (EPERM, EACCES, EINVAL, ENOENT…)
        // would leave TEST_SYSTEM_PATH partially populated and turn into a
        // confusing downstream test failure, so re-throw it.
        if (err && err.code === "EEXIST") continue;
        throw err;
      }
    }
  }
  return dir;
}

const TEST_SYSTEM_PATH = buildIsolatedSystemPath();

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
if [ -n "\${1:-}" ] && [ -f "$1" ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
fi
if [ "$1" = "-e" ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
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

  it("treats the installer script's checkout as the source root even when cwd is elsewhere", () => {
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
if [ -n "\${1:-}" ] && [ -f "$1" ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
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
if [ "\${1:-}" = "-c" ]; then
  shift 2
fi
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
if [ "$1" = "uninstall" ]; then
  exit 0
fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "onboard" ]; then
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "nemoclaw v0.1.0-test"
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
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
        GIT_LOG_PATH: gitLog,
      },
    });

    expect(result.status).toBe(0);
    const gitCalls = fs.readFileSync(gitLog, "utf-8");
    expect(gitCalls).not.toMatch(/clone/);
    expect(gitCalls).not.toMatch(/fetch/);
  }, 60_000);

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
if [ "\${1:-}" = "-c" ]; then
  shift 2
fi
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
if [ "$1" = "uninstall" ]; then
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
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/curl -fsSL https:\/\/www\.nvidia\.com\/nemoclaw\.sh \| bash/);
    expect(output).not.toMatch(/npm install -g nemoclaw/);
  });

  it("scripts/install.sh runs as the installer from a repo checkout", () => {
    const result = spawnSync("bash", [INSTALLER_PAYLOAD, "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toMatch(/NemoClaw Installer/);
    expect(output).not.toMatch(/deprecated compatibility wrapper/);
  });

  it("scripts/install.sh --help works when run directly outside a repo checkout", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-payload-stdin-"));
    const scriptContents = fs.readFileSync(INSTALLER_PAYLOAD, "utf-8");
    const result = spawnSync("bash", ["-s", "--", "--help"], {
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
    expect(result.status).toBe(0);
    expect(output).toMatch(/NemoClaw Installer/);
    expect(output).not.toMatch(/deprecated compatibility wrapper/);
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
    expect(output).toMatch(/build \| openai \| anthropic \| anthropicCompatible/);
    expect(output).toMatch(/gemini \| ollama \| custom \| nim-local \| vllm/);
    expect(output).toMatch(/aliases: cloud -> build, nim -> nim-local/);
    expect(output).toMatch(/NEMOCLAW_POLICY_MODE/);
    expect(output).toMatch(/NEMOCLAW_SANDBOX_NAME/);
    expect(output).toMatch(/nvidia\.com\/nemoclaw\.sh/);
  });

  it("scripts/install.sh --help lists the full non-interactive provider set", () => {
    const result = spawnSync("bash", [INSTALLER_PAYLOAD, "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toMatch(/build \| openai \| anthropic \| anthropicCompatible/);
    expect(output).toMatch(/gemini \| ollama \| custom \| nim-local \| vllm/);
    expect(output).toMatch(/aliases: cloud -> build, nim -> nim-local/);
  });

  it("--version exits 0 and prints the version number", () => {
    const result = spawnSync("bash", [INSTALLER, "--version"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output.trim()).toMatch(/^nemoclaw-installer(?: v\d+\.\d+\.\d+(?:-.+)?)?$/);
    expect(output).not.toMatch(/0\.1\.0/);
  });

  it("-v exits 0 and prints the version number", () => {
    const result = spawnSync("bash", [INSTALLER, "-v"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output.trim()).toMatch(/^nemoclaw-installer(?: v\d+\.\d+\.\d+(?:-.+)?)?$/);
    expect(output).not.toMatch(/0\.1\.0/);
  });

  it("piped --help does not show the placeholder installer version", () => {
    const result = spawnSync("bash", ["-s", "--", "--help"], {
      cwd: os.tmpdir(),
      encoding: "utf-8",
      input: fs.readFileSync(INSTALLER, "utf-8"),
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/NemoClaw Installer/);
    expect(output).not.toMatch(/0\.1\.0/);
  });

  it("piped --version omits the placeholder installer version", () => {
    const result = spawnSync("bash", ["-s", "--", "--version"], {
      cwd: os.tmpdir(),
      encoding: "utf-8",
      input: fs.readFileSync(INSTALLER, "utf-8"),
    });

    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output.trim()).toBe("nemoclaw-installer");
    expect(output).not.toMatch(/0\.1\.0/);
  });

  it("uses npm install + npm link for a source checkout (no -g)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-source-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const npmLog = path.join(tmp, "npm.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(tmp, ".git"));
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
if [ "$1" = "run" ] && { [ "$2" = "build" ] || [ "$2" = "build:cli" ] || [ "$2" = "--if-present" ]; }; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "nemoclaw v0.1.0-test"; exit 0; fi
if [ "$1" = "onboard" ]; then exit 0; fi
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
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
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
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = "info" ]; then
  echo '{"ServerVersion":"29.3.1","OperatingSystem":"Ubuntu 24.04","CgroupVersion":"2"}'
  exit 0
fi
exit 0
`,
    );
    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.22"
  exit 0
fi
exit 0
`,
    );
    writeNpmStub(
      fakeBin,
      `if [ "$1" = "pack" ]; then
  tmpdir="$4"
  mkdir -p "$tmpdir/package"
  tar -czf "$tmpdir/openclaw-2026.3.11.tgz" -C "$tmpdir" package
  exit 0
fi
if [ "$1" = "install" ]; then exit 0; fi
if [ "$1" = "run" ] && { [ "$2" = "build" ] || [ "$2" = "build:cli" ] || [ "$2" = "--if-present" ]; }; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "nemoclaw v0.1.0-test"; exit 0; fi
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
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
        NEMOCLAW_ONBOARD_LOG: onboardLog,
      },
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /Found an interrupted onboarding session — resuming it\./,
    );
    expect(fs.readFileSync(onboardLog, "utf-8")).toMatch(
      /^onboard --resume --non-interactive --yes-i-accept-third-party-software$/m,
    );
  });

  it("skips onboarding when shared host preflight detects Docker is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-missing-docker-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const onboardLog = path.join(tmp, "onboard.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeNodeStub(fakeBin);
    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.22"
  exit 0
fi
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
    // Stub systemctl so preflight sees docker service as inactive (not a
    // group/permission issue).  Without this, a CI host whose real systemctl
    // reports docker as active would trigger the docker-group remediation
    // instead of the "Start Docker" path this test expects.
    writeExecutable(
      path.join(fakeBin, "systemctl"),
      `#!/usr/bin/env bash
if [ "$1" = "is-active" ] && [ "$2" = "docker" ]; then echo "inactive"; exit 3; fi
if [ "$1" = "is-enabled" ] && [ "$2" = "docker" ]; then echo "disabled"; exit 1; fi
exit 0
`,
    );
    writeNpmStub(
      fakeBin,
      `if [ "$1" = "pack" ]; then
  tmpdir="$4"
  mkdir -p "$tmpdir/package"
  tar -czf "$tmpdir/openclaw-2026.3.11.tgz" -C "$tmpdir" package
  exit 0
fi
if [ "$1" = "install" ]; then exit 0; fi
if [ "$1" = "run" ] && { [ "$2" = "build" ] || [ "$2" = "build:cli" ] || [ "$2" = "--if-present" ]; }; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "nemoclaw v0.1.0-test"; exit 0; fi
printf '%s\\n' "$*" >> "$NEMOCLAW_ONBOARD_LOG"
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
        NEMOCLAW_ONBOARD_LOG: onboardLog,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toMatch(/Host preflight found issues that will prevent onboarding right now\./);
    expect(output).toMatch(/Start Docker/);
    expect(output).toMatch(/Skipping onboarding until the host prerequisites above are fixed\./);
    expect(fs.existsSync(onboardLog)).toBe(false);
  });

  it("warns on Podman but still runs onboarding", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-podman-warning-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const onboardLog = path.join(tmp, "onboard.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeNodeStub(fakeBin);
    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.22"
  exit 0
fi
exit 0
`,
    );
    writeNpmStub(
      fakeBin,
      `if [ "$1" = "pack" ]; then
  tmpdir="$4"
  mkdir -p "$tmpdir/package"
  tar -czf "$tmpdir/openclaw-2026.3.11.tgz" -C "$tmpdir" package
  exit 0
fi
if [ "$1" = "install" ]; then exit 0; fi
if [ "$1" = "run" ] && { [ "$2" = "build" ] || [ "$2" = "build:cli" ] || [ "$2" = "--if-present" ]; }; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "nemoclaw v0.1.0-test"; exit 0; fi
printf '%s\\n' "$*" >> "$NEMOCLAW_ONBOARD_LOG"
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi`,
    );
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = "info" ]; then
  echo "Podman Engine"
  exit 0
fi
exit 0
`,
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
        NEMOCLAW_ONBOARD_LOG: onboardLog,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toMatch(/Host preflight found warnings\./);
    expect(output).toMatch(/Detected container runtime: podman/);
    expect(output).toMatch(
      /Podman may work in some environments, but it is not a supported runtime/,
    );
    expect(fs.readFileSync(onboardLog, "utf-8")).toMatch(
      /^onboard --non-interactive --yes-i-accept-third-party-software$/m,
    );
  });

  it("requires explicit terms acceptance in non-interactive install mode", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-terms-required-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const onboardLog = path.join(tmp, "onboard.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeNodeStub(fakeBin);
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = "info" ]; then
  echo '{"ServerVersion":"29.3.1","OperatingSystem":"Ubuntu 24.04","CgroupVersion":"2"}'
  exit 0
fi
exit 0
`,
    );
    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.22"
  exit 0
fi
exit 0
`,
    );
    writeNpmStub(
      fakeBin,
      `if [ "$1" = "pack" ]; then
  tmpdir="$4"
  mkdir -p "$tmpdir/package"
  tar -czf "$tmpdir/openclaw-2026.3.11.tgz" -C "$tmpdir" package
  exit 0
fi
if [ "$1" = "install" ]; then exit 0; fi
if [ "$1" = "run" ] && { [ "$2" = "build" ] || [ "$2" = "build:cli" ] || [ "$2" = "--if-present" ]; }; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "nemoclaw v0.1.0-test"; exit 0; fi
printf '%s\\n' "$*" >> "$NEMOCLAW_ONBOARD_LOG"
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi`,
    );

    const result = spawnSync("bash", [INSTALLER, "--non-interactive"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "",
        NPM_PREFIX: prefix,
        NEMOCLAW_ONBOARD_LOG: onboardLog,
      },
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /--yes-i-accept-third-party-software|NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1/,
    );
    expect(fs.existsSync(onboardLog)).toBe(false);
  });

  it("passes the acceptance flag through to non-interactive onboard", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-terms-accept-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const onboardLog = path.join(tmp, "onboard.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeNodeStub(fakeBin);
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = "info" ]; then
  echo '{"ServerVersion":"29.3.1","OperatingSystem":"Ubuntu 24.04","CgroupVersion":"2"}'
  exit 0
fi
exit 0
`,
    );
    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.22"
  exit 0
fi
exit 0
`,
    );
    writeNpmStub(
      fakeBin,
      `if [ "$1" = "pack" ]; then
  tmpdir="$4"
  mkdir -p "$tmpdir/package"
  tar -czf "$tmpdir/openclaw-2026.3.11.tgz" -C "$tmpdir" package
  exit 0
fi
if [ "$1" = "install" ]; then exit 0; fi
if [ "$1" = "run" ] && { [ "$2" = "build" ] || [ "$2" = "build:cli" ] || [ "$2" = "--if-present" ]; }; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "nemoclaw v0.1.0-test"; exit 0; fi
printf '%s\\n' "$*" >> "$NEMOCLAW_ONBOARD_LOG"
exit 0
EOS
  chmod +x "$NPM_PREFIX/bin/nemoclaw"
  exit 0
fi`,
    );

    const result = spawnSync(
      "bash",
      [INSTALLER, "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmp,
          PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
          NPM_PREFIX: prefix,
          NEMOCLAW_ONBOARD_LOG: onboardLog,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(fs.readFileSync(onboardLog, "utf-8")).toMatch(
      /^onboard --non-interactive --yes-i-accept-third-party-software$/m,
    );
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
if [ "\${1:-}" = "-c" ]; then
  shift 2
fi
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
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
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
if [ -n "\${1:-}" ] && [ -f "$1" ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
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
if [ "\${1:-}" = "-c" ]; then
  shift 2
fi
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
if [ "$1" = "uninstall" ]; then
  exit 0
fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "onboard" ]; then
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "nemoclaw v0.1.0-test"
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
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
      },
    });

    const shimPath = path.join(tmp, ".local", "bin", "nemoclaw");
    expect(result.status).toBe(0);
    expect(fs.readFileSync(shimPath, "utf-8")).toContain(`export PATH="${fakeBin}:$PATH"`);
    expect(fs.readFileSync(shimPath, "utf-8")).toContain(path.join(prefix, "bin", "nemoclaw"));
    expect(`${result.stdout}${result.stderr}`).toMatch(/Created user-local shim/);
  });

  it("shows source hint even when bin dir is already in PATH (stale hash protection)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-ready-shell-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const prefixBin = path.join(prefix, "bin");
    const nvmDir = path.join(tmp, ".nvm");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(prefixBin, { recursive: true });
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.writeFileSync(path.join(nvmDir, "nvm.sh"), "# stub nvm\n");

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then
  echo "v22.16.0"
  exit 0
fi
if [ -n "\${1:-}" ] && [ -f "$1" ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
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
if [ "\${1:-}" = "-c" ]; then
  shift 2
fi
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
if [ "$1" = "uninstall" ]; then
  exit 0
fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "nemoclaw v0.1.0-test"; exit 0; fi
if [ "$1" = "onboard" ]; then exit 0; fi
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
        PATH: `${fakeBin}:${prefixBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
        NVM_DIR: nvmDir,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).not.toMatch(/current shell cannot resolve 'nemoclaw'/);
    // Always show source hint — the parent shell may have stale hash-table
    // entries after an upgrade/reinstall even when the dir is in PATH.
    expect(output).toMatch(/\$ source /);
  });

  it("shows shell reload hint when PATH was extended by the installer", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-reload-hint-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const nvmDir = path.join(tmp, ".nvm");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.writeFileSync(path.join(nvmDir, "nvm.sh"), "# stub nvm\n");

    writeNodeStub(fakeBin);
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = "info" ]; then
  echo '{"ServerVersion":"29.3.1","OperatingSystem":"Ubuntu 24.04","CgroupVersion":"2"}'
  exit 0
fi
exit 0
`,
    );
    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.22"
  exit 0
fi
exit 0
`,
    );
    writeNpmStub(
      fakeBin,
      `if [ "$1" = "pack" ]; then exit 1; fi
if [ "$1" = "install" ] || [ "$1" = "run" ]; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "nemoclaw v0.1.0-test"; exit 0; fi
if [ "$1" = "onboard" ]; then exit 0; fi
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
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
        NVM_DIR: nvmDir,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toMatch(/\$ source /);
    expect(output).not.toContain("Onboarding has not run yet.");
    expect(output).not.toContain(
      "Onboarding did not run because this shell cannot resolve 'nemoclaw' yet.",
    );
    expect(output).toMatch(/\$ nemoclaw my-assistant connect/);
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
    return spawnSync("bash", ["-c", `source "${INSTALLER}" 2>/dev/null; resolve_release_tag`], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        HOME: os.tmpdir(),
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        ...env,
      },
    });
  }

  it("defaults to 'latest' with no env override", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-tag-default-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(path.join(fakeBin, "node"), "#!/usr/bin/env bash\nexit 1");

    const result = callResolveReleaseTag(fakeBin);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("latest");
  });

  it("uses NEMOCLAW_INSTALL_TAG override", () => {
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
if [ "$1" = "--version" ]; then echo "nemoclaw v0.1.0-test"; exit 0; fi
if [ "$1" = "onboard" ]; then exit 0; fi
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
      JSON.stringify(
        { name: "nemoclaw", version: "0.1.0", dependencies: { openclaw: "2026.3.11" } },
        null,
        2,
      ),
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
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
        GIT_LOG_PATH: gitLog,
      },
    });

    expect(result.status).toBe(0);
    // git clone / git fetch should NOT have been called in the source-checkout path.
    // git may be called for version resolution (git describe), so we check
    // that no clone or fetch was attempted rather than no git calls at all.
    if (fs.existsSync(gitLog)) {
      const gitCalls = fs.readFileSync(gitLog, "utf-8");
      expect(gitCalls).not.toMatch(/clone/);
      expect(gitCalls).not.toMatch(/fetch/);
    }
    // And curl for the releases API should NOT have been called
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/curl should not be called/);
  });

  it("repo-checkout install does not clone a separate ref even when cwd is elsewhere", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-tag-e2e-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const gitLog = path.join(tmp, "git.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeNodeStub(fakeBin);

    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
/usr/bin/curl "$@"`,
    );

    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG_PATH"
if [ "\${1:-}" = "-c" ]; then
  shift 2
fi
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
if [ "$1" = "--version" ]; then echo "nemoclaw v0.1.0-test"; exit 0; fi
if [ "$1" = "onboard" ]; then exit 0; fi
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
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
        GIT_LOG_PATH: gitLog,
      },
    });

    expect(result.status).toBe(0);
    const gitCalls = fs.readFileSync(gitLog, "utf-8");
    expect(gitCalls).not.toMatch(/clone/);
    expect(gitCalls).not.toMatch(/fetch/);
  });

  // Issue #2178 — when nvm installs a new Node, the user's parent shell still
  // resolves `node` to the old version until the shell is reloaded. The
  // installer's upgrade path must surface this loudly and adjacent to the
  // "Node.js installed" line, not only in the generic bottom-of-output Next
  // block where it's easy to miss.
  it("install_nodejs upgrade path emits a Node-specific shell-reload hint", () => {
    const script = fs.readFileSync(INSTALLER_PAYLOAD, "utf-8");
    const installNodejs = script.match(/install_nodejs\(\)\s*\{[\s\S]*?\n\}/);
    expect(installNodejs).not.toBeNull();
    const body = installNodejs![0];
    // Anchor to the actual warn/printf calls (not the comment) so the test
    // fails if the executable statements are removed. A child process can't
    // mutate the parent's PATH, so the honest fix is printing the exact
    // command the user can run in their existing shell (no exec tricks —
    // those create a nested shell that masks the problem; see PR #2298).
    expect(body).toMatch(/\n\s*warn\s+"Your current shell may still resolve/);
    // Single-quoted printf avoids bash expansion of $NVM_DIR / $HOME in the
    // printed text — the user gets a literal, env-aware command to paste.
    expect(body).toMatch(/\n\s*printf\s+'[^']*NVM_DIR:-\$HOME\/\.nvm[^']*nvm use 22/);
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
    return spawnSync("bash", ["-c", `source "${INSTALLER}" 2>/dev/null; ${fnCall}`], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        HOME: os.tmpdir(),
        PATH: TEST_SYSTEM_PATH,
        ...env,
      },
    });
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

  it("resolve_installer_version: reads version from git or package.json", () => {
    const r = callInstallerFn("resolve_installer_version");
    // May return clean semver ("0.0.2") or git describe format ("0.0.2-3-gabcdef1")
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(-.+)?$/);
  });

  it("resolve_openclaw_version: falls back to Dockerfile.base when package.json omits it", () => {
    const dockerfileContent = fs.readFileSync(
      path.join(import.meta.dirname, "..", "Dockerfile.base"),
      "utf-8",
    );
    const expected = dockerfileContent.match(/ARG\s+OPENCLAW_VERSION\s*=\s*(\S+)/)?.[1];
    expect(expected).toBeDefined();
    const r = callInstallerFn('resolve_openclaw_version "$PWD"');
    expect(r.stdout.trim()).toBe(expected);
  });

  it("is_source_checkout: rejects a payload-like checkout without git metadata", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-checkout-"));
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "nemoclaw", version: "0.1.0" }, null, 2),
    );
    const r = spawnSync(
      "bash",
      [
        "-c",
        `source "${INSTALLER}" 2>/dev/null; is_source_checkout "${tmp}" && echo yes || echo no`,
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: { HOME: tmp, PATH: TEST_SYSTEM_PATH },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("no");
  });

  it("is_source_checkout: accepts an explicit source checkout with git metadata", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-checkout-git-"));
    fs.mkdirSync(path.join(tmp, ".git"));
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "nemoclaw", version: "0.1.0" }, null, 2),
    );
    const r = spawnSync(
      "bash",
      [
        "-c",
        `source "${INSTALLER}" 2>/dev/null; is_source_checkout "${tmp}" && echo yes || echo no`,
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: { HOME: tmp, PATH: TEST_SYSTEM_PATH },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("yes");
  });

  it("is_source_checkout: rejects bootstrap payload clones even when git metadata exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-checkout-bootstrap-"));
    fs.mkdirSync(path.join(tmp, ".git"));
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "nemoclaw", version: "0.1.0" }, null, 2),
    );
    const r = spawnSync(
      "bash",
      [
        "-c",
        `source "${INSTALLER}" 2>/dev/null; is_source_checkout "${tmp}" && echo yes || echo no`,
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: { HOME: tmp, PATH: TEST_SYSTEM_PATH, NEMOCLAW_BOOTSTRAP_PAYLOAD: "1" },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("no");
  });

  it("resolve_installer_version: falls back to package.json when git tags are unavailable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-ver-pkg-"));
    fs.mkdirSync(path.join(tmp, ".git"));
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      `${JSON.stringify({ version: "0.5.0" }, null, 2)}\n`,
    );
    // source overwrites SCRIPT_DIR, so we re-set it after sourcing.
    // The temp dir advertises git metadata but has no usable tags,
    // so the function should fall back to package.json instead of exiting.
    const r = spawnSync(
      "bash",
      ["-c", `source "${INSTALLER}" 2>/dev/null; SCRIPT_DIR="${tmp}"; resolve_installer_version`],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: { HOME: tmp, PATH: TEST_SYSTEM_PATH },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0.5.0");
  });

  it("resolve_installer_version: falls back to DEFAULT when no package.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolve-ver-"));
    // source overwrites SCRIPT_DIR, so we re-set it after sourcing.
    // The temp dir has no .git, no .version, and no package.json,
    // so the function should fall back to DEFAULT_NEMOCLAW_VERSION.
    const r = spawnSync(
      "bash",
      ["-c", `source "${INSTALLER}" 2>/dev/null; SCRIPT_DIR="${tmp}"; resolve_installer_version`],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: { HOME: tmp, PATH: TEST_SYSTEM_PATH },
      },
    );
    expect(r.stdout.trim()).toBe("0.1.0");
  });

  it("installer_version_for_display: hides the placeholder default", () => {
    const r = callInstallerFn(
      'NEMOCLAW_VERSION="$DEFAULT_NEMOCLAW_VERSION"; installer_version_for_display',
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("installer_version_for_display: formats real versions for display", () => {
    const r = callInstallerFn('NEMOCLAW_VERSION="0.0.21"; installer_version_for_display');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("  v0.0.21");
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
if [ -n "\${1:-}" ] && [ -f "$1" ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
fi
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
if [ "$1" = "uninstall" ]; then exit 0; fi
if [ "$1" = "link" ]; then
  cat > "$NPM_PREFIX/bin/nemoclaw" <<'EOS'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "nemoclaw v0.5.0-test"; exit 0; fi
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

  it("repo-checkout install ignores release-tag cloning when invoked by path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-pipe-tag-e2e-"));
    const { fakeBin, prefix, gitLog } = buildCurlPipeEnv(tmp, {
      curlStub: `#!/usr/bin/env bash
/usr/bin/curl "$@"`,
      gitStub: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG_PATH"
if [ "\${1:-}" = "-c" ]; then
  shift 2
fi
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
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
        GIT_LOG_PATH: gitLog,
      },
    });

    expect(result.status).toBe(0);
    const gitCalls = fs.readFileSync(gitLog, "utf-8");
    expect(gitCalls).not.toMatch(/clone/);
    expect(gitCalls).not.toMatch(/fetch/);
  });

  it("repo-checkout install ignores NEMOCLAW_INSTALL_TAG when invoked by path", () => {
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
if [ "\${1:-}" = "-c" ]; then
  shift 2
fi
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
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
        GIT_LOG_PATH: gitLog,
        NEMOCLAW_INSTALL_TAG: "v0.2.0",
      },
    });

    expect(result.status).toBe(0);
    const gitCalls = fs.readFileSync(gitLog, "utf-8");
    expect(gitCalls).not.toMatch(/clone/);
    expect(gitCalls).not.toMatch(/fetch/);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/curl should not hit the releases API/);
  });

  it("falls back to the legacy root installer when the selected ref only has the old scripts/install.sh wrapper", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-pipe-legacy-ref-"));
    const legacyLog = path.join(tmp, "legacy.log");
    const { fakeBin, prefix } = buildCurlPipeEnv(tmp, {
      curlStub: `#!/usr/bin/env bash
/usr/bin/curl "$@"`,
      gitStub: `#!/usr/bin/env bash
if [ "\${1:-}" = "-c" ]; then
  shift 2
fi
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/scripts"
  cat > "$target/scripts/install.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
echo legacy-wrapper >&2
exit 97
EOS
  chmod +x "$target/scripts/install.sh"
  cat > "$target/install.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${NEMOCLAW_INSTALL_TAG:-unset}" > "\${LEGACY_LOG_PATH:?}"
EOS
  chmod +x "$target/install.sh"
  exit 0
fi
exit 0`,
    });

    const installerInput = fs.readFileSync(CURL_PIPE_INSTALLER, "utf-8");
    const result = spawnSync("bash", [], {
      cwd: tmp,
      input: installerInput,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_INSTALL_TAG: "v0.0.1",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
        LEGACY_LOG_PATH: legacyLog,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(legacyLog, "utf-8")).toMatch(/^v0\.0\.1\s*$/);
  });

  it("resolves the usage notice helper from the cloned source during piped installs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-pipe-usage-notice-"));
    const { fakeBin, prefix } = buildCurlPipeEnv(tmp, {
      curlStub: `#!/usr/bin/env bash
/usr/bin/curl "$@"`,
      gitStub: `#!/usr/bin/env bash
if [ "\${1:-}" = "-c" ]; then
  shift 2
fi
if [ "$1" = "clone" ]; then
  target="\${@: -1}"
  mkdir -p "$target/nemoclaw" "$target/bin/lib" "$target/scripts"
  echo '{"name":"nemoclaw","version":"0.5.0","dependencies":{"openclaw":"2026.3.11"}}' > "$target/package.json"
  echo '{"name":"nemoclaw-plugin","version":"0.5.0"}' > "$target/nemoclaw/package.json"
  cat > "$target/bin/lib/usage-notice.js" <<'EOS'
#!/usr/bin/env node
process.exit(0)
EOS
  chmod +x "$target/bin/lib/usage-notice.js"
  cat > "$target/scripts/install.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
# NEMOCLAW_VERSIONED_INSTALLER_PAYLOAD=1
repo_root="\${NEMOCLAW_REPO_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
node "$repo_root/bin/lib/usage-notice.js"
EOS
  chmod +x "$target/scripts/install.sh"
  exit 0
fi
exit 0`,
    });

    const installerInput = fs.readFileSync(CURL_PIPE_INSTALLER, "utf-8");
    const result = spawnSync("bash", [], {
      cwd: tmp,
      input: installerInput,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NPM_PREFIX: prefix,
      },
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/Cannot find module .*usage-notice\.js/);
  });
});
