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
        const code =
          typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
        if (code === "EEXIST") continue;
        throw err;
      }
    }
  }
  return dir;
}

const TEST_SYSTEM_PATH = buildIsolatedSystemPath();

function writeExecutable(target: string, contents: string) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function requireMatch(match: RegExpMatchArray | null, message: string): RegExpMatchArray {
  expect(match).not.toBeNull();
  if (!match) {
    throw new Error(message);
  }
  return match;
}

// ---------------------------------------------------------------------------
// Helpers shared across suites
// ---------------------------------------------------------------------------

/** Fake node that reports v22.16.0. */
function writeNodeStub(fakeBin: string) {
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
function writeNpmStub(fakeBin: string, installSnippet: string = "exit 0") {
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

function writeFailedOnboardSession(home: string) {
  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".nemoclaw", "onboard-session.json"),
    JSON.stringify(
      {
        resumable: true,
        status: "failed",
        failure: { step: "inference", message: "Ollama proxy unreachable" },
      },
      null,
      2,
    ),
  );
}

function runFailedSessionPromptChoice(answer: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-failed-choice-"));
  const fakeBin = path.join(tmp, "bin");
  const onboardLog = path.join(tmp, "onboard.log");
  const promptInput = path.join(tmp, "prompt-input.txt");
  fs.mkdirSync(fakeBin);
  writeFailedOnboardSession(tmp);
  fs.writeFileSync(promptInput, answer);
  writeNodeStub(fakeBin);
  writeExecutable(
    path.join(fakeBin, "nemoclaw"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NEMOCLAW_ONBOARD_LOG"
exit 0
`,
  );

  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
source "$INSTALLER_UNDER_TEST"
show_usage_notice() { :; }
info() { printf 'INFO: %s\\n' "$*" >&2; }
warn() { printf 'WARN: %s\\n' "$*" >&2; }
error() { printf 'ERROR: %s\\n' "$*" >&2; exit 1; }
function [ {
  if [[ "$#" -eq 3 && "$1" = "-t" && "$2" = "0" && "$3" = "]" ]]; then
    return 0
  fi
  builtin [ "$@"
}
run_onboard < "$PROMPT_INPUT_FILE"
`,
    ],
    {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        FRESH: "",
        HOME: tmp,
        NEMOCLAW_AGENT: "openclaw",
        NEMOCLAW_FRESH: "",
        NEMOCLAW_NON_INTERACTIVE: "",
        NON_INTERACTIVE: "",
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        NEMOCLAW_ONBOARD_LOG: onboardLog,
        PROMPT_INPUT_FILE: promptInput,
      },
    },
  );

  return { result, onboardLog };
}

// ---------------------------------------------------------------------------

describe("installer runtime preflight", { timeout: 15_000 }, () => {
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
        // Bypass the #2671 fail-fast license gate — this test exercises the
        // Node-version-detection / nvm-upgrade path, not the license path.
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
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
    expect(output).toMatch(/gemini \| ollama \| custom \| nim-local \| vllm \| routed/);
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
    expect(output).toMatch(/gemini \| ollama \| custom \| nim-local \| vllm \| routed/);
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

  it("uses npm install + npm link for a source checkout (no -g)", { timeout: 20000 }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-source-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const npmLog = path.join(tmp, "npm.log");
    const pythonLog = path.join(tmp, "python.log");
    const gitLog = path.join(tmp, "git.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(tmp, ".git"));
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });

    writeNodeStub(fakeBin);
    writeExecutable(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$GIT_LOG_PATH"
exit 90
`,
    );
    writeExecutable(
      path.join(fakeBin, "python3"),
      `#!/usr/bin/env bash
printf 'python3 %s\\n' "$*" >> "$PYTHON_LOG_PATH"
exit 88
`,
    );
    writeExecutable(
      path.join(fakeBin, "pip3"),
      `#!/usr/bin/env bash
printf 'pip3 %s\\n' "$*" >> "$PYTHON_LOG_PATH"
exit 89
`,
    );
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
    fs.mkdirSync(path.join(tmp, "nemoclaw-blueprint", "router", "llm-router"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, "nemoclaw-blueprint", "router", "llm-router", "pyproject.toml"),
      "[project]\nname = 'llm-router'\n",
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
        PYTHON_LOG_PATH: pythonLog,
        GIT_LOG_PATH: gitLog,
      },
    });

    expect(result.status).toBe(0);
    const log = fs.readFileSync(npmLog, "utf-8");
    // install (no -g) and link must both have been called
    expect(log).toMatch(/^install(?!\s+-g)/m);
    expect(log).toMatch(/^link/m);
    // the GitHub URL must NOT appear — this is a local install
    expect(log).not.toMatch(new RegExp(GITHUB_INSTALL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // Model Router must not run provider-specific dependency setup from the generic installer.
    expect(fs.existsSync(pythonLog)).toBe(false);
    const gitCalls = fs.existsSync(gitLog) ? fs.readFileSync(gitLog, "utf-8") : "";
    expect(gitCalls).not.toMatch(/submodule/);
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
      /^onboard --resume --non-interactive --yes-i-accept-third-party-software --yes$/m,
    );
  });

  // #2430: a failed session used to be auto-resumed just like in_progress.
  // That loops forever when the failure was caused by the user's provider
  // choice at step 3 (no way to pick a different provider). In
  // non-interactive mode there is no safe default, so we refuse instead.
  it("refuses to auto-resume a failed onboarding session in non-interactive mode (#2430)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-failed-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const onboardLog = path.join(tmp, "onboard.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".nemoclaw"), { recursive: true });

    fs.writeFileSync(
      path.join(tmp, ".nemoclaw", "onboard-session.json"),
      JSON.stringify(
        {
          resumable: true,
          status: "failed",
          failure: { step: "inference", message: "Ollama proxy unreachable" },
        },
        null,
        2,
      ),
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

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Previous onboarding session failed/);
    expect(`${result.stdout}${result.stderr}`).toMatch(/--fresh/);
    // The installer must have bailed out before invoking nemoclaw onboard.
    expect(fs.existsSync(onboardLog)).toBe(false);
  });

  it.each([
    { answer: "FrEsH\n", expectedArgs: "onboard --fresh", unexpectedFlag: /--resume/ },
    { answer: "RESUME\n", expectedArgs: "onboard --resume", unexpectedFlag: /--fresh/ },
    { answer: "\n", expectedArgs: "onboard --resume", unexpectedFlag: /--fresh/ },
  ])("lowercases failed-session prompt answer $answer before invoking onboard", (testCase) => {
    const { result, onboardLog } = runFailedSessionPromptChoice(testCase.answer);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Previous onboarding session failed/);
    const log = fs.readFileSync(onboardLog, "utf-8");
    expect(log).toMatch(new RegExp(`^${testCase.expectedArgs}$`, "m"));
    expect(log).not.toMatch(testCase.unexpectedFlag);
  });

  // #2430: --fresh is the escape hatch. Even with a session file on disk
  // (failed or otherwise), the installer should skip the auto-resume check
  // and let the onboard command create a new session.
  it("--fresh skips auto-resume regardless of session state (#2430)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-fresh-"));
    const fakeBin = path.join(tmp, "bin");
    const prefix = path.join(tmp, "prefix");
    const onboardLog = path.join(tmp, "onboard.log");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".nemoclaw"), { recursive: true });

    // A session that WOULD auto-resume (status=in_progress) without --fresh.
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

    const result = spawnSync("bash", [INSTALLER, "--fresh"], {
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
    expect(`${result.stdout}${result.stderr}`).toMatch(/Starting a fresh onboarding session/);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(
      /Found an interrupted onboarding session/,
    );
    // onboard was called with --fresh (forwarded so the CLI clears the
    // existing session file) and without --resume.
    const log = fs.readFileSync(onboardLog, "utf-8");
    expect(log).toMatch(
      /^onboard --fresh --non-interactive --yes-i-accept-third-party-software --yes$/m,
    );
    expect(log).not.toMatch(/--resume/);
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
      /^onboard --non-interactive --yes-i-accept-third-party-software --yes$/m,
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
      /^onboard --non-interactive --yes-i-accept-third-party-software --yes$/m,
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

  it("preserves ready output when nemoclaw is already resolvable after install", () => {
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
        NEMOCLAW_SANDBOX_NAME: "my-assistant",
        NPM_PREFIX: prefix,
        NVM_DIR: nvmDir,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).not.toMatch(/current shell cannot resolve 'nemoclaw'/);
    expect(output).not.toMatch(/this shell needs PATH refresh/);
    expect(output).toMatch(/\$ source /);
    expect(output).toMatch(/\$ nemoclaw my-assistant connect/);
  });

  it("makes current-shell PATH refresh obvious when the installer added the bin dir", () => {
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
        NEMOCLAW_SANDBOX_NAME: "my-assistant",
        NPM_PREFIX: prefix,
        NVM_DIR: nvmDir,
        SHELL: "/bin/bash",
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toContain(
      "NemoClaw installed, but this shell needs PATH refresh before 'nemoclaw' will run.",
    );
    expect(output).toContain(`$ source ${path.join(tmp, ".bashrc")}`);
    expect(output).toContain(`$ export PATH="${path.join(tmp, ".local", "bin")}:$PATH"`);
    expect(fs.readFileSync(path.join(tmp, ".bashrc"), "utf-8")).toContain(
      "# NemoClaw PATH setup",
    );
    expect(output).not.toContain("Your OpenClaw Sandbox is live.");
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
  function callResolveReleaseTag(fakeBin: string, env: Record<string, string | undefined> = {}) {
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

  it("clone_nemoclaw_ref uses fetch checkout so fully-qualified refs work", () => {
    const payload = fs.readFileSync(INSTALLER_PAYLOAD, "utf-8");
    const bootstrap = fs.readFileSync(CURL_PIPE_INSTALLER, "utf-8");
    for (const src of [payload, bootstrap]) {
      const fn = src.match(/clone_nemoclaw_ref\(\) \{([\s\S]*?)^}/m);
      expect(fn).toBeTruthy();
      expect(fn![1]).toContain('git init --quiet "$dest"');
      expect(fn![1]).toContain('git -C "$dest" fetch --quiet --depth 1 origin "$ref"');
      expect(fn![1]).toContain("checkout --quiet --detach FETCH_HEAD");
      expect(fn![1]).not.toContain("clone --quiet --depth 1 --branch");
    }
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-nvm-upgrade-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then echo "v18.19.1"; exit 0; fi
exit 99
`,
    );
    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "9.8.1"; exit 0; fi
exit 98
`,
    );
    writeExecutable(
      path.join(fakeBin, "sha256sum"),
      `#!/usr/bin/env bash
echo "4b7412c49960c7d31e8df72da90c1fb5b8cccb419ac99537b737028d497aba4f  $1"
`,
    );
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi
done
cat > "$out" <<'INSTALL'
#!/usr/bin/env bash
set -euo pipefail
nvm_dir="\${NVM_DIR:-$HOME/.nvm}"
mkdir -p "$nvm_dir"
cat > "$nvm_dir/nvm.sh" <<'NVM'
nvm() {
  case "$1" in
    install)
      mkdir -p "$NVM_DIR/versions/node/v22/bin"
      cat > "$NVM_DIR/versions/node/v22/bin/node" <<'NODE'
#!/usr/bin/env bash
if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then echo "v22.16.0"; exit 0; fi
exit 0
NODE
      chmod +x "$NVM_DIR/versions/node/v22/bin/node"
      ;;
    use)
      export PATH="$NVM_DIR/versions/node/v22/bin:$PATH"
      ;;
    alias)
      return 0
      ;;
  esac
}
NVM
INSTALL
`,
    );

    const result = spawnSync("bash", ["-c", `source "${INSTALLER}" 2>/dev/null; install_nodejs`], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        HOME: tmp,
        NVM_DIR: path.join(tmp, ".nvm"),
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toContain("Node.js installed via nvm: v22.16.0");
    expect(output).toContain("Your current shell may still resolve `node` to an older version");
    expect(output).toContain('source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22');
  });
});

// ---------------------------------------------------------------------------
// Pure helper functions — sourced and tested in isolation.
// ---------------------------------------------------------------------------

describe("installer pure helpers", () => {
  /**
   * Helper: source install.sh and call a function, returning stdout.
   */
  function callInstallerFn(fnCall: string, env: Record<string, string | undefined> = {}) {
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

  function callInstallerPayloadFn(fnCall: string, env: Record<string, string | undefined> = {}) {
    return spawnSync("bash", ["-c", `source "${INSTALLER_PAYLOAD}" 2>/dev/null; ${fnCall}`], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        HOME: os.tmpdir(),
        PATH: TEST_SYSTEM_PATH,
        ...env,
      },
    });
  }

  it("verify_nemoclaw checks the active CLI alias", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-verify-cli-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    writeExecutable(
      path.join(fakeBin, "nemohermes"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "nemohermes v0.1.0-test"
  exit 0
fi
exit 1
`,
    );

    const r = spawnSync(
      "bash",
      [
        "-c",
        `source "${INSTALLER}" 2>/dev/null; verify_nemoclaw; printf 'READY=%s\n' "$NEMOCLAW_READY_NOW"`,
      ],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmp,
          NEMOCLAW_AGENT: "hermes",
          PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        },
      },
    );

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("READY=true");
    expect(r.stdout).toContain("Verified: nemohermes is available");
  });

  it("is_real_nemoclaw_cli accepts the active NemoHermes binary name", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-real-cli-"));
    const fakeCli = path.join(tmp, "nemohermes");
    writeExecutable(
      fakeCli,
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "nemohermes v0.1.0-test"
  exit 0
fi
exit 1
`,
    );

    const result = callInstallerFn(
      `is_real_nemoclaw_cli ${JSON.stringify(fakeCli)} "nemohermes" && echo yes || echo no`,
    );
    expect(result.stdout.trim()).toBe("yes");
  });

  it("is_real_nemoclaw_cli accepts semver prerelease plus build metadata", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-real-cli-"));
    const fakeCli = path.join(tmp, "nemohermes");
    writeExecutable(
      fakeCli,
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "nemohermes v0.1.0-rc.1+build.5"
  exit 0
fi
exit 1
`,
    );

    const result = callInstallerFn(
      `is_real_nemoclaw_cli ${JSON.stringify(fakeCli)} "nemohermes" && echo yes || echo no`,
    );
    expect(result.stdout.trim()).toBe("yes");
  });

  it("is_real_nemoclaw_cli rejects mismatched CLI aliases", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-real-cli-"));
    const fakeCli = path.join(tmp, "nemohermes");
    writeExecutable(
      fakeCli,
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "nemohermes v0.1.0-test"
  exit 0
fi
exit 1
`,
    );

    const result = callInstallerFn(
      `is_real_nemoclaw_cli ${JSON.stringify(fakeCli)} "nemoclaw" && echo yes || echo no`,
    );
    expect(result.stdout.trim()).toBe("no");
  });

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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-version-"));
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "fixture" }));
    fs.writeFileSync(path.join(tmp, "Dockerfile.base"), "ARG OPENCLAW_VERSION=1.2.3\n");
    const r = callInstallerFn(`resolve_openclaw_version ${JSON.stringify(tmp)}`);
    expect(r.stdout.trim()).toBe("1.2.3");
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

  it("agent_display_name: formats Hermes and NemoClaw names", () => {
    const hermes = callInstallerPayloadFn("agent_display_name hermes");
    expect(hermes.status).toBe(0);
    expect(hermes.stdout.trim()).toBe("Hermes");

    const nemoclaw = callInstallerPayloadFn("agent_display_name nemoclaw");
    expect(nemoclaw.status).toBe(0);
    expect(nemoclaw.stdout.trim()).toBe("Nemoclaw");
  });

  it("prefer_user_local_openshell: exports the freshly installed OpenShell path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-path-"));
    const localBin = path.join(tmp, ".local", "bin");
    const openshell = path.join(localBin, "openshell");
    fs.mkdirSync(localBin, { recursive: true });
    writeExecutable(openshell, "#!/usr/bin/env bash\nexit 0\n");

    const r = callInstallerPayloadFn(
      'prefer_user_local_openshell; printf "%s\\n%s\\n" "$NEMOCLAW_OPENSHELL_BIN" "$PATH"',
      {
        HOME: tmp,
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      },
    );
    const [resolved, pathValue] = r.stdout.trim().split("\n");
    expect(r.status).toBe(0);
    expect(resolved).toBe(openshell);
    expect(pathValue.startsWith(`${localBin}:`)).toBe(true);
  });

  it("restore_onboard_forward_after_post_checks: restores Hermes forward from session", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-forward-restore-"));
    const fakeBin = path.join(tmp, "bin");
    const stateDir = path.join(tmp, ".nemoclaw");
    const openshellLog = path.join(tmp, "openshell.log");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "onboard-session.json"),
      JSON.stringify({ sandboxName: "created-by-onboard", agent: "hermes" }),
    );
    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OPENSHELL_LOG"
if [ "$1" = "forward" ] && [ "$2" = "list" ]; then
  echo "SANDBOX BIND PORT PID STATUS"
  echo "created-by-onboard 127.0.0.1 8642 123 running"
fi
exit 0
`,
    );
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
exit 0
`,
    );
    writeExecutable(
      path.join(fakeBin, "sleep"),
      `#!/usr/bin/env bash
exit 0
`,
    );

    const r = callInstallerPayloadFn("restore_onboard_forward_after_post_checks", {
      HOME: tmp,
      NEMOCLAW_SKIP_FORWARD_WATCHER: "1",
      OPENSHELL_LOG: openshellLog,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
    });

    expect(r.status).toBe(0);
    const openshellCalls = fs.readFileSync(openshellLog, "utf-8");
    expect(openshellCalls).toContain("forward stop 8642 created-by-onboard");
    expect(openshellCalls).toContain("forward start --background 8642 created-by-onboard");
  });

  // -- resolve_default_sandbox_name --

  it("resolve_default_sandbox_name: returns 'my-assistant' with no registry", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sandbox-name-"));
    const r = callInstallerFn("resolve_default_sandbox_name", { HOME: tmp });
    expect(r.stdout.trim()).toBe("my-assistant");
  });

  it("resolve_default_sandbox_name: defaults to 'hermes' for NemoHermes with no state", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-sandbox-name-"));
    const r = callInstallerFn("resolve_default_sandbox_name", {
      HOME: tmp,
      NEMOCLAW_AGENT: "hermes",
    });
    expect(r.stdout.trim()).toBe("hermes");
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

  it("resolve_default_sandbox_name: current onboard session wins over env and registry", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sandbox-name-session-"));
    const registryDir = path.join(tmp, ".nemoclaw");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "onboard-session.json"),
      JSON.stringify({ sandboxName: "created-by-onboard" }),
    );
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: "old-default",
        sandboxes: { "old-default": {} },
      }),
    );
    const r = callInstallerFn("resolve_default_sandbox_name", {
      HOME: tmp,
      NEMOCLAW_SANDBOX_NAME: "env-name",
      PATH: `${process.env.PATH}`,
    });
    expect(r.stdout.trim()).toBe("created-by-onboard");
  });

  it("resolve_default_sandbox_name: payload session lookup wins even when node is absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sandbox-name-payload-session-"));
    const registryDir = path.join(tmp, ".nemoclaw");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "onboard-session.json"),
      `${JSON.stringify({ sandboxName: "created-by-onboard" }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: "old-default",
        sandboxes: { "old-default": {} },
      }),
    );
    const r = callInstallerPayloadFn("resolve_default_sandbox_name", {
      HOME: tmp,
      NEMOCLAW_SANDBOX_NAME: "env-name",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("created-by-onboard");
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
  function callEnsureSupportedRuntime(
    fakeBin: string,
    env: Record<string, string | undefined> = {},
  ) {
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

describe("installer Docker bootstrap (sourced)", () => {
  function runEnsureDockerWithStubs({
    dockerScript,
    idScript,
    systemctlScript = `#!/usr/bin/env bash
if [ "\${1:-}" = "is-active" ]; then exit 0; fi
if [ "\${1:-}" = "enable" ]; then exit 0; fi
exit 0
`,
    sudoScript = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-n" ]; then shift; fi
printf '%s\\n' "$*" >> "$SUDO_LOG"
exec "$@"
`,
  }: {
    dockerScript: string;
    idScript: string;
    systemctlScript?: string;
    sudoScript?: string;
  }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-bootstrap-"));
    const fakeBin = path.join(tmp, "bin");
    const sudoLog = path.join(tmp, "sudo.log");
    const idLog = path.join(tmp, "id.log");
    const dockerCount = path.join(tmp, "docker-count");
    fs.mkdirSync(fakeBin);

    writeExecutable(path.join(fakeBin, "docker"), dockerScript);
    writeExecutable(path.join(fakeBin, "id"), idScript);
    writeExecutable(path.join(fakeBin, "sudo"), sudoScript);
    writeExecutable(path.join(fakeBin, "systemctl"), systemctlScript);
    writeExecutable(
      path.join(fakeBin, "uname"),
      `#!/usr/bin/env bash
printf 'Linux\\n'
`,
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
info() { printf 'INFO: %s\\n' "$*" >&2; }
warn() { printf 'WARN: %s\\n' "$*" >&2; }
error() { printf 'ERROR: %s\\n' "$*" >&2; exit 1; }
ensure_docker
`,
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: {
          HOME: tmp,
          PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          SUDO_LOG: sudoLog,
          ID_LOG: idLog,
          DOCKER_COUNT: dockerCount,
        },
      },
    );

    return {
      result,
      sudoLog: fs.existsSync(sudoLog) ? fs.readFileSync(sudoLog, "utf-8") : "",
      idLog: fs.existsSync(idLog) ? fs.readFileSync(idLog, "utf-8") : "",
    };
  }

  it("prompts for newgrp when persisted docker membership is not active", () => {
    const { result, sudoLog } = runEnsureDockerWithStubs({
      dockerScript: `#!/usr/bin/env bash
if [ "\${1:-}" = "info" ]; then exit 1; fi
exit 0
`,
      idScript: `#!/usr/bin/env bash
case "$*" in
  "-u") printf '1000\\n' ;;
  "-un") printf 'alice\\n' ;;
  "-nG alice") printf 'alice docker\\n' ;;
  "-nG") printf 'alice adm\\n' ;;
  *) printf 'unexpected id %s\\n' "$*" >&2; exit 99 ;;
esac
`,
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Docker group membership is not active in this shell yet/);
    expect(output).toMatch(/newgrp docker/);
    expect(output).not.toMatch(/Docker is installed but not reachable/);
    expect(sudoLog).not.toMatch(/usermod/);
  });

  it("reports daemon reachability when the active shell already has docker", () => {
    const { result } = runEnsureDockerWithStubs({
      dockerScript: `#!/usr/bin/env bash
if [ "\${1:-}" = "info" ]; then exit 1; fi
exit 0
`,
      idScript: `#!/usr/bin/env bash
case "$*" in
  "-u") printf '1000\\n' ;;
  "-un") printf 'alice\\n' ;;
  "-nG alice") printf 'alice docker\\n' ;;
  "-nG") printf 'alice docker adm\\n' ;;
  *) printf 'unexpected id %s\\n' "$*" >&2; exit 99 ;;
esac
`,
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/Docker is installed but not reachable/);
    expect(output).toMatch(/sudo systemctl start docker/);
    expect(output).not.toMatch(/newgrp docker/);
  });

  it("skips docker group membership checks for root", () => {
    const { result, idLog } = runEnsureDockerWithStubs({
      dockerScript: `#!/usr/bin/env bash
if [ "\${1:-}" = "info" ]; then
  count=0
  if [ -f "$DOCKER_COUNT" ]; then count="$(cat "$DOCKER_COUNT")"; fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$DOCKER_COUNT"
  if [ "$count" -ge 2 ]; then exit 0; fi
  exit 1
fi
exit 0
`,
      idScript: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ID_LOG"
case "$*" in
  "-u") printf '0\\n' ;;
  "-un") printf 'root\\n' ;;
  "-nG"*) printf 'root should not check groups\\n' >&2; exit 99 ;;
  *) printf 'unexpected id %s\\n' "$*" >&2; exit 99 ;;
esac
`,
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(idLog).toMatch(/^-u$/m);
    expect(idLog).not.toMatch(/-nG/);
  });
});

describe("installer license acceptance (sourced)", () => {
  /**
   * Source scripts/install.sh and invoke show_usage_notice() in isolation. The
   * helper stubs the usage-notice.js script to record the argv it received so
   * tests can assert which flags flowed through, without actually downloading
   * or evaluating the real notice.
   */
  function callShowUsageNotice(env: Record<string, string | undefined>) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-show-usage-"));
    const fakeBin = path.join(tmp, "bin");
    const sourceRoot = path.join(tmp, "src");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(sourceRoot, "bin", "lib"), { recursive: true });
    const argLog = path.join(tmp, "notice-args.log");

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
# Stub node: write argv (excluding the script path) to argLog and exit 0.
{ shift; printf '%s\\n' "$*"; } > ${JSON.stringify(argLog)}
exit 0`,
    );

    fs.writeFileSync(path.join(sourceRoot, "bin", "lib", "usage-notice.js"), "// stub\n");

    // Source scripts/install.sh and invoke show_usage_notice in a fresh
    // session with no controlling TTY. On Linux/WSL we wrap the child in
    // setsid because WSL runners keep /dev/tty openable from the child
    // process even when stdin is /dev/null — `(: </dev/tty)` succeeds and
    // show_usage_notice takes its TTY-fallback branch instead of the
    // `else error` we mean to exercise. setsid creates a new session with
    // no controlling terminal so /dev/tty becomes unopenable.
    //
    // macOS does not ship setsid (it's a util-linux binary). Headless
    // GitHub-hosted macOS runners have no controlling TTY in the first
    // place, so plain bash is sufficient there.
    //
    // 2>/dev/null suppresses any top-level noise the source may emit
    // before main()'s guard.
    //
    // The env object below is constructed as a fresh literal — process.env
    // is intentionally NOT merged so ambient runner vars
    // (NON_INTERACTIVE, ACCEPT_THIRD_PARTY_SOFTWARE) cannot leak into the
    // child. Callers control the env entirely via the `env` parameter.
    const useSetsid = process.platform !== "darwin";
    const bashScript = `source ${JSON.stringify(INSTALLER_PAYLOAD)} 2>/dev/null; show_usage_notice </dev/null`;
    const result = useSetsid
      ? spawnSync("setsid", ["bash", "-c", bashScript], {
          cwd: tmp,
          encoding: "utf-8",
          env: {
            HOME: tmp,
            PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
            NEMOCLAW_SOURCE_ROOT: sourceRoot,
            ...env,
          },
        })
      : spawnSync("bash", ["-c", bashScript], {
          cwd: tmp,
          encoding: "utf-8",
          env: {
            HOME: tmp,
            PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
            NEMOCLAW_SOURCE_ROOT: sourceRoot,
            ...env,
          },
        });
    const args = fs.existsSync(argLog) ? fs.readFileSync(argLog, "utf-8").trim() : "";
    return { result, args };
  }

  it("#2670: ACCEPT_THIRD_PARTY_SOFTWARE=1 alone clears the notice in non-TTY mode", () => {
    const { result, args } = callShowUsageNotice({
      // Simulates curl|bash mode: stdin is not a TTY, NON_INTERACTIVE is unset,
      // and only --yes-i-accept-third-party-software was passed.
      ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    });
    expect(result.status).toBe(0);
    // Notice script must receive both flags so it actually accepts and exits.
    expect(args).toMatch(/--non-interactive/);
    expect(args).toMatch(/--yes-i-accept-third-party-software/);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(
      /Interactive third-party software acceptance requires a TTY/,
    );
  });

  it("NON_INTERACTIVE=1 alone keeps the notice prompt-driven (regression)", () => {
    // Existing behavior preserved: --non-interactive without --yes-i-accept-... still
    // launches the notice helper non-interactively (which itself prompts/declines).
    const { result, args } = callShowUsageNotice({ NON_INTERACTIVE: "1" });
    expect(result.status).toBe(0);
    expect(args).toMatch(/--non-interactive/);
    expect(args).not.toMatch(/--yes-i-accept-third-party-software/);
  });

  it("errors with the friendly hint when neither flag is set in non-TTY mode", () => {
    const { result } = callShowUsageNotice({});
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/Interactive third-party software acceptance requires a TTY/);
    expect(output).toMatch(/--yes-i-accept-third-party-software/);
    // No raw /dev/tty shell noise should leak (e.g. "exec 3</dev/tty")
    // — the friendly hint is the only TTY-related output we expect.
    expect(output).not.toMatch(/\/dev\/tty/);
  });

  it("#3058: error message includes a working curl|bash example users can copy-paste", () => {
    // The reporter on #3058 hit this error with `curl ... | bash` on a
    // non-TTY box and was left guessing how to combine the env var with
    // the documented one-liner. The fix surfaces the exact invocations
    // (terminal, env-var-in-pipe, flag-via-bash-s) so users can resolve
    // the failure without leaving the terminal output.
    const { result } = callShowUsageNotice({});
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash/);
    expect(output).toMatch(/bash -s -- --yes-i-accept-third-party-software/);
    expect(output).toMatch(/bash <\(curl/);
  });
});

describe("installer express install prompt (sourced)", () => {
  function runExpressPromptWithTty(answer: string, stdinMode: "pipe" | "tty") {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-prompt-"));
    const python =
      spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v python3"], { encoding: "utf-8" }).stdout.trim() ||
      "python3";
    const ptyRunner = `
import os
import pty
import select
import signal
import sys
import time

installer = sys.argv[1]
answer = sys.argv[2].encode()
stdin_mode = sys.argv[3]
script = r'''
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "DGX Spark"; }
NON_INTERACTIVE=""
NEMOCLAW_PROVIDER=""
NEMOCLAW_NO_EXPRESS=""
maybe_offer_express_install
printf "RESULT NON_INTERACTIVE=%s PROVIDER=%s MODEL=%s POLICY=%s YES=%s\\n" \\
  "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \\
  "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}"
'''
env = dict(os.environ)
env["INSTALLER_UNDER_TEST"] = installer
pid, fd = pty.fork()
if pid == 0:
    if stdin_mode == "pipe":
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.close(devnull)
    os.execvpe("bash", ["bash", "-c", script], env)

output = bytearray()
os.set_blocking(fd, False)
sent = False
exit_code = 124
deadline = time.time() + 10
while True:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except BlockingIOError:
            chunk = b""
        except OSError:
            chunk = b""
        if chunk:
            output.extend(chunk)
        if (not sent) and b"[Y/n]" in output:
            os.write(fd, answer)
            sent = True
    waited = os.waitpid(pid, os.WNOHANG)
    if waited[0] == pid:
        exit_code = os.waitstatus_to_exitcode(waited[1])
        break
    if time.time() > deadline:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        break

try:
    os.close(fd)
except OSError:
    pass
sys.stdout.buffer.write(output)
sys.exit(exit_code)
`;
    return spawnSync(python, ["-c", ptyRunner, INSTALLER_PAYLOAD, answer, stdinMode], {
      cwd: tmp,
      encoding: "utf-8",
      timeout: 15_000,
      killSignal: "SIGKILL",
      env: {
        HOME: tmp,
        PATH: TEST_SYSTEM_PATH,
      },
    });
  }

  it("offers express install when curl-piped stdin still has a controlling TTY", () => {
    const result = runExpressPromptWithTty("y\n", "pipe");
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected DGX Spark/);
    expect(output).toMatch(/Run express install/);
    expect(output).toMatch(/Using express install for DGX Spark/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 PROVIDER=install-ollama MODEL=qwen3\.6:35b POLICY=suggested YES=1/,
    );
  });

  it("skips express install without a controlling TTY", () => {
    if (process.platform === "darwin") {
      return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-no-tty-"));
    const result = spawnSync(
      "setsid",
      [
        "bash",
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "DGX Spark"; }
NON_INTERACTIVE=""
NEMOCLAW_PROVIDER=""
NEMOCLAW_NO_EXPRESS=""
maybe_offer_express_install
printf "RESULT NON_INTERACTIVE=%s PROVIDER=%s MODEL=%s POLICY=%s YES=%s\\n" \\
  "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \\
  "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}"
`,
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        input: "",
        env: {
          HOME: tmp,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected DGX Spark/);
    expect(output).toMatch(/Skipping express prompt \(no TTY\)/);
    expect(output).not.toMatch(/Run express install/);
    expect(output).toMatch(/RESULT NON_INTERACTIVE= PROVIDER= MODEL= POLICY= YES=/);
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
  function buildCurlPipeEnv(
    tmp: string,
    { curlStub, gitStub }: { curlStub: string; gitStub: string },
  ) {
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

  it("piped root installer does not source a local payload from the caller cwd", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-piped-root-cwd-"));
    const repoLike = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repoLike, "scripts"), { recursive: true });
    const rootInstaller = path.join(repoLike, "install.sh");
    fs.copyFileSync(CURL_PIPE_INSTALLER, rootInstaller);
    writeExecutable(
      path.join(repoLike, "scripts", "install.sh"),
      `#!/usr/bin/env bash
# NEMOCLAW_VERSIONED_INSTALLER_PAYLOAD=1
main() {
  printf 'LOCAL_PAYLOAD_USED\\n'
}`,
    );

    const result = spawnSync("bash", ["-s", "--", "--version"], {
      cwd: repoLike,
      input: fs.readFileSync(rootInstaller, "utf-8"),
      encoding: "utf-8",
      env: {
        ...process.env,
        NEMOCLAW_INSTALL_TAG: "v0.0.29",
      },
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/^nemoclaw-installer\s*$/m);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/LOCAL_PAYLOAD_USED/);
  });

  it("falls back to the legacy root installer when the selected ref only has the old scripts/install.sh wrapper", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-pipe-legacy-ref-"));
    const legacyLog = path.join(tmp, "legacy.log");
    const { fakeBin, prefix } = buildCurlPipeEnv(tmp, {
      curlStub: `#!/usr/bin/env bash
/usr/bin/curl "$@"`,
      gitStub: `#!/usr/bin/env bash
repo=""
if [ "\${1:-}" = "-c" ]; then
  shift 2
fi
if [ "\${1:-}" = "-C" ]; then
  repo="$2"
  shift 2
fi
if [ "$1" = "init" ]; then
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
if [ "$1" = "remote" ] || [ "$1" = "fetch" ] || [ "$1" = "checkout" ]; then
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
repo=""
if [ "\${1:-}" = "-c" ]; then
  shift 2
fi
if [ "\${1:-}" = "-C" ]; then
  repo="$2"
  shift 2
fi
if [ "$1" = "init" ]; then
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
if [ "$1" = "remote" ] || [ "$1" = "fetch" ] || [ "$1" = "checkout" ]; then
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

describe("installer atomicity (#2671)", () => {
  /**
   * Run scripts/install.sh main() with stubbed phase-1 and phase-2 binaries
   * that record invocation to a marker file. Tests assert whether install
   * reaches phase 1/2 or short-circuits at the fail-fast license gate.
   */
  function runInstaller(env: Record<string, string | undefined>, options: { stdinIsTty?: boolean } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-2671-"));
    const fakeBin = path.join(tmp, "bin");
    const phaseLog = path.join(tmp, "phases.log");
    fs.mkdirSync(fakeBin);

    // Stub node + npm — both record their own invocation so we can detect
    // whether phase 1 (install_nodejs) or phase 2 (install_nemoclaw) ran.
    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
echo "node $*" >> ${JSON.stringify(phaseLog)}
if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then echo "v22.16.0"; exit 0; fi
if [ -n "\${1:-}" ] && [ -f "$1" ]; then exit 0; fi
exit 0`,
    );
    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
echo "npm $*" >> ${JSON.stringify(phaseLog)}
if [ "$1" = "--version" ]; then echo "10.9.2"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then echo "${path.join(tmp, "prefix")}"; exit 0; fi
exit 0`,
    );
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
echo "docker $*" >> ${JSON.stringify(phaseLog)}
exit 0`,
    );

    // Run main() directly via the bash entrypoint check. We force stdin to a
    // non-TTY pipe when stdinIsTty is false (default — simulates curl|bash).
    // On Linux/WSL, spawnSync children can still inherit a controlling terminal
    // even with pipe stdin, which leaves /dev/tty openable and correctly lets
    // the installer prompt instead of fail fast. Use setsid to exercise the
    // headless curl-pipe path where both stdin and /dev/tty are unavailable.
    const useSetsid = !options.stdinIsTty && process.platform !== "darwin";
    const result = spawnSync(
      useSetsid ? "setsid" : "bash",
      useSetsid ? ["bash", INSTALLER_PAYLOAD] : [INSTALLER_PAYLOAD],
      {
        cwd: tmp,
        encoding: "utf-8",
        // input: "" makes spawnSync attach a non-TTY stdin pipe. setsid above
        // additionally removes /dev/tty on Linux/WSL.
        input: options.stdinIsTty ? undefined : "",
        env: {
          HOME: tmp,
          PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
          ...env,
        },
      },
    );
    const phases = fs.existsSync(phaseLog) ? fs.readFileSync(phaseLog, "utf-8") : "";
    return { result, phases, tmp };
  }

  function runInstallerWithTty(
    answer: string,
    stdinMode: "pipe" | "tty" = "pipe",
    env: Record<string, string | undefined> = {},
  ) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-tty-pipe-"));
    const fakeBin = path.join(tmp, "bin");
    const phaseLog = path.join(tmp, "phases.log");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash
echo "node $*" >> ${JSON.stringify(phaseLog)}
if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then echo "v22.16.0"; exit 0; fi
if [ -n "\${1:-}" ] && [ -f "$1" ]; then exit 0; fi
exit 0`,
    );
    writeExecutable(
      path.join(fakeBin, "npm"),
      `#!/usr/bin/env bash
echo "npm $*" >> ${JSON.stringify(phaseLog)}
if [ "$1" = "--version" ]; then echo "10.9.2"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then echo "${path.join(tmp, "prefix")}"; exit 0; fi
exit 0`,
    );
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
echo "docker $*" >> ${JSON.stringify(phaseLog)}
exit 0`,
    );
    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
echo "openshell $*" >> ${JSON.stringify(phaseLog)}
if [ "$1" = "--version" ] || [ "$1" = "version" ]; then echo "openshell 0.0.37"; fi
exit 0`,
    );
    writeExecutable(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
echo "nemoclaw $*" >> ${JSON.stringify(phaseLog)}
if [ "$1" = "--version" ] || [ "$1" = "version" ]; then echo "nemoclaw v0.5.0"; fi
exit 0`,
    );

    const python =
      spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v python3"], { encoding: "utf-8" }).stdout.trim() ||
      "python3";
    const ptyRunner = `
import os
import pty
import select
import signal
import sys
import time

installer = sys.argv[1]
answer = sys.argv[2].encode()
stdin_mode = sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    if stdin_mode == "pipe":
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.close(devnull)
    os.execvpe("bash", ["bash", installer], os.environ)

output = bytearray()
os.set_blocking(fd, False)
deadline = time.time() + 20
sent = False
exit_code = 124
timed_out = False
while True:
    if not sent:
        os.write(fd, answer)
        sent = True
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except BlockingIOError:
            chunk = b""
        except OSError:
            chunk = b""
        if chunk:
            output.extend(chunk)
    waited = os.waitpid(pid, os.WNOHANG)
    if waited[0] == pid:
        status = waited[1]
        exit_code = os.waitstatus_to_exitcode(status)
        break
    if time.time() > deadline:
        timed_out = True
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        break

try:
    if timed_out:
        for _ in range(20):
            waited = os.waitpid(pid, os.WNOHANG)
            if waited[0] == pid:
                exit_code = os.waitstatus_to_exitcode(waited[1])
                break
            time.sleep(0.05)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
            exit_code = 124

    for _ in range(100):
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        output.extend(chunk)
except BlockingIOError:
    pass
except OSError:
    pass
finally:
    try:
        os.close(fd)
    except OSError:
        pass

sys.stdout.buffer.write(output)
sys.exit(exit_code)
`;
    const result = spawnSync(python, ["-c", ptyRunner, INSTALLER_PAYLOAD, answer, stdinMode], {
      cwd: tmp,
      encoding: "utf-8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: {
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        // These tests verify the third-party-license flow on non-Spark
        // hardware. On real DGX Spark/Station the express prompt would
        // also fire and consume the test's input. Skip it explicitly
        // so the tests stay focused on what they're verifying.
        NEMOCLAW_NO_EXPRESS: "1",
        ...env,
      },
    });
    const phases = fs.existsSync(phaseLog) ? fs.readFileSync(phaseLog, "utf-8") : "";
    const stateFile = path.join(tmp, ".nemoclaw", "usage-notice.json");
    const state = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf-8") : "";
    return { result, phases, state };
  }

  function runInstallerWithPipedStdinAndTty(answer: string) {
    return runInstallerWithTty(answer, "pipe");
  }

  function runInstallerWithInteractiveStdin(answer: string) {
    return runInstallerWithTty(answer, "tty");
  }

  it("#2671: headless curl|bash with no flags exits 1 BEFORE phase 1 (atomic — no Node/CLI install)", () => {
    const { result, phases } = runInstaller({});
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/Interactive third-party software acceptance requires a TTY/);
    expect(output).toMatch(/--yes-i-accept-third-party-software/);
    // Phase 1 (Node.js install) and phase 2 (CLI install) must NOT have run —
    // the whole point of the fix is that a license-fail leaves no half-install behind.
    expect(output).not.toMatch(/\[1\/3\] Node\.js/);
    expect(output).not.toMatch(/\[2\/3\] NemoClaw CLI/);
    // Stub binaries record every invocation; if phase 1 or 2 ran, node and/or
    // npm would have been called. The fail-fast check runs before either.
    expect(phases).toBe("");
  });

  it("piped installs with a controlling TTY prompt before phase 1 and continue after acceptance", () => {
    const { result, phases, state } = runInstallerWithPipedStdinAndTty("yes\n");
    const output = `${result.stdout}${result.stderr}`;
    const noticeVersion = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "..", "bin", "lib", "usage-notice.json"), "utf-8"),
    ).version;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/prompting for the third-party software notice on \/dev\/tty/);
    expect(output).toMatch(/Third-Party Software Notice - NemoClaw Installer/);
    expect(output).not.toMatch(/Interactive third-party software acceptance requires a TTY/);
    expect(output.indexOf("Third-Party Software Notice - NemoClaw Installer")).toBeGreaterThanOrEqual(0);
    expect(output.indexOf("Node.js")).toBeGreaterThan(
      output.indexOf("Third-Party Software Notice - NemoClaw Installer"),
    );
    expect(phases).not.toBe("");
    expect(state).toContain(`"acceptedVersion": "${noticeVersion}"`);
  }, 15_000);

  it("interactive installs with stdin on a TTY prompt before phase 1 and continue after acceptance", () => {
    const { result, phases, state } = runInstallerWithInteractiveStdin("yes\n");
    const output = `${result.stdout}${result.stderr}`;
    const noticeVersion = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "..", "bin", "lib", "usage-notice.json"), "utf-8"),
    ).version;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Third-Party Software Notice - NemoClaw Installer/);
    expect(output).toMatch(/Type 'yes'/);
    expect(output).not.toMatch(/Interactive third-party software acceptance requires a TTY/);
    expect(output.indexOf("Third-Party Software Notice - NemoClaw Installer")).toBeGreaterThanOrEqual(0);
    expect(output.indexOf("Node.js")).toBeGreaterThan(
      output.indexOf("Third-Party Software Notice - NemoClaw Installer"),
    );
    expect(phases).not.toBe("");
    expect(state).toContain(`"acceptedVersion": "${noticeVersion}"`);
  }, 15_000);

  it("piped installs with a controlling TTY still stop before phase 1 when acceptance is declined", () => {
    const { result, phases, state } = runInstallerWithPipedStdinAndTty("\n");
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/Third-Party Software Notice - NemoClaw Installer/);
    expect(output).toMatch(/Installation cancelled/);
    expect(output).not.toMatch(/\[1\/3\] Node\.js/);
    expect(phases).toBe("");
    expect(state).toBe("");
  });

  it("interactive installs with stdin on a TTY still stop before phase 1 when acceptance is declined", () => {
    const { result, phases, state } = runInstallerWithInteractiveStdin("\n");
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/Third-Party Software Notice - NemoClaw Installer/);
    expect(output).toMatch(/Installation cancelled/);
    expect(output).not.toMatch(/\[1\/3\] Node\.js/);
    expect(phases).toBe("");
    expect(state).toBe("");
  });

  it("--non-interactive alone with a controlling TTY still stops before phase 1", () => {
    const { result, phases, state } = runInstallerWithTty("yes\n", "pipe", {
      NEMOCLAW_NON_INTERACTIVE: "1",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(
      /Non-interactive installation requires explicit third-party software acceptance/,
    );
    expect(output).toMatch(/--yes-i-accept-third-party-software/);
    expect(output).not.toMatch(/Third-Party Software Notice - NemoClaw Installer/);
    expect(output).not.toMatch(/\[1\/3\] Node\.js/);
    expect(phases).toBe("");
    expect(state).toBe("");
  });

  it("--yes-i-accept-third-party-software alone is sufficient to clear the fail-fast gate", () => {
    // The flag implies non-interactive intent (set by main() before the
    // preflight check), so it must clear the gate AND let the install
    // progress past preflight into phase 1 — assert phases is non-empty
    // so the test doesn't false-pass if the install bailed for some other
    // reason while the TTY error happened to be absent from output.
    const { result, phases } = runInstaller({ NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toMatch(/Interactive third-party software acceptance requires a TTY/);
    expect(phases).not.toBe("");
  });

  it("--non-interactive alone does not clear the fail-fast gate", () => {
    const { result, phases } = runInstaller({ NEMOCLAW_NON_INTERACTIVE: "1" });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(
      /Non-interactive installation requires explicit third-party software acceptance/,
    );
    expect(output).toMatch(/--yes-i-accept-third-party-software/);
    expect(phases).toBe("");
  });
});
