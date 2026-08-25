// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";
import { TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "../..", "scripts", "install.sh");
const INSTALLER_SOURCE = fs.readFileSync(INSTALLER_PAYLOAD, "utf-8");
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const STATION_REVISION = "a".repeat(40);
const STATION_GENERATION = "0123456789abcdef0123456789abcdef";

function extractShellFunctionBefore(name: string, nextName: string): string {
  const start = INSTALLER_SOURCE.indexOf(`${name}() {`);
  const end = INSTALLER_SOURCE.indexOf(`\n${nextName}() {`, start);
  if (start === -1 || end === -1) {
    throw new Error(`expected ${name} before ${nextName} in scripts/install.sh`);
  }
  return INSTALLER_SOURCE.slice(start, end).trimEnd();
}

const ENSURE_DOCKER_FUNCTION = extractShellFunctionBefore("ensure_docker", "is_wsl_host");
const describeLinux = process.platform === "linux" ? describe : describe.skip;

type EnsureDockerOutcome = {
  status: number | null;
  stdout: string;
  stderr: string;
  sgArgs: string[];
  sgProvider: string | null;
};

function runEnsureDocker(
  env: Record<string, string>,
  installerArgs: string[],
): EnsureDockerOutcome {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-docker-group-"));
  const sgLog = path.join(tmp, "sg-args.txt");
  const sgProviderLog = path.join(tmp, "sg-provider.txt");
  const sgStub = path.join(tmp, "sg");
  const harnessDir = path.join(tmp, "scripts");
  const installHarness = path.join(harnessDir, "install.sh");
  fs.mkdirSync(harnessDir, { recursive: true });

  // Keep the harness focused on ensure_docker so macOS platform tests do not
  // depend on sourcing the installer's top-level Bash state with /bin/bash 3.
  fs.writeFileSync(
    installHarness,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'installer_non_interactive() { [[ "${NON_INTERACTIVE:-}" == "1" || "${NEMOCLAW_NON_INTERACTIVE:-}" == "1" ]]; }',
      ENSURE_DOCKER_FUNCTION,
    ].join("\n"),
    { mode: 0o755 },
  );

  // Stub `sg`: record the args the installer asked us to execute, then exit 0.
  // Without this stub, `exec sg docker -c …` would replace the test process
  // with a real group switch — flaky and platform-dependent.
  fs.writeFileSync(
    sgStub,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${sgLog}"\nprintf '%s\\n' "$NEMOCLAW_PROVIDER" > "${sgProviderLog}"\nexit 0\n`,
    { mode: 0o755 },
  );

  // Backslashes must be escaped before quotes — otherwise a literal `\` in
  // an installer arg would slip through unescaped (CodeQL: incomplete string
  // escaping).
  const argsArrayLiteral = installerArgs
    .map((a) => `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(" ");

  const snippet = `
    set -e
    source "${installHarness}"

    # Force the slow path through ensure_docker:
    #   - docker info fails (group not yet active in this shell)
    #   - docker binary exists, so the install step is skipped
    #   - systemctl exits cleanly so the daemon-start branch is a no-op
    #   - user is non-root, not in docker group via NSS, not in active group list
    #   - sudo is a no-op so usermod doesn't actually run
    #   - uname reports Linux and is_wsl_host returns 1 so platform guards
    #     do not bail out early in the Linux CI job
    uname() { printf 'Linux\n'; }
    docker() { return 1; }
    systemctl() { return 0; }
    sudo() { return 0; }
    id() {
      case "$1" in
        -u) printf '1000\\n' ;;
        -un) printf 'testuser\\n' ;;
        -nG)
          if [ -n "\${2:-}" ]; then
            printf 'testuser sudo\\n'
          else
            printf 'testuser sudo\\n'
          fi
          ;;
        *) ;;
      esac
    }
    # Surface info() output on stdout so tests can pin the user-facing
    # guidance text emitted by the legacy fallback path.
    info() { printf '%s\n' "$*"; }
    warn() { :; }
    error() { return 1; }
    is_wsl_host() { return 1; }
    uname() { printf 'Linux\n'; }
    verify_downloaded_script() { :; }

    _NEMOCLAW_INSTALLER_ARGS=(${argsArrayLiteral})
    _STATION_INSTALL_MODE="$NEMOCLAW_TEST_STATION_INSTALL_MODE"
    NEMOCLAW_INSTALLER_STAGED="${installHarness}"
    export PATH="${tmp}:$PATH"

    ensure_docker
  `;

  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: { ...process.env, NEMOCLAW_TEST_STATION_INSTALL_MODE: "", ...env },
  });

  const sgArgs = fs.existsSync(sgLog)
    ? fs
        .readFileSync(sgLog, "utf-8")
        .split("\n")
        .filter((line) => line.length > 0)
    : [];
  const sgProvider = fs.existsSync(sgProviderLog)
    ? fs.readFileSync(sgProviderLog, "utf-8").trim()
    : null;

  try {
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      sgArgs,
      sgProvider,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runSourcedInstaller(body: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-resume-mode-"));
  try {
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-c", `source "$INSTALLER_UNDER_TEST" >/dev/null\n${body}`],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          HOME: home,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        },
        timeout: 10_000,
        killSignal: "SIGKILL",
      },
    );
    return { result, output: `${result.stdout}${result.stderr}` };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describeLinux("install.sh ensure_docker — #4414 non-interactive self re-exec", () => {
  it("re-execs through 'sg docker' instead of exiting 0 when NEMOCLAW_NON_INTERACTIVE=1", () => {
    // Repro of #4414: on a clean Ubuntu VM, the non-interactive curl|bash
    // installer adds the user to the docker group, then exits and asks the
    // user to run `newgrp docker` and re-curl. A truly non-interactive flow
    // must self-reactivate group membership so a single `curl … | bash`
    // finishes the install.
    const outcome = runEnsureDocker(
      { NEMOCLAW_NON_INTERACTIVE: "1", NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" },
      ["--non-interactive", "--yes-i-accept-third-party-software"],
    );

    expect(outcome.sgArgs.length).toBeGreaterThan(0);
    // sg(1) usage: `sg <group> -c <command>`
    expect(outcome.sgArgs[0]).toBe("docker");
    expect(outcome.sgArgs).toContain("-c");

    // The command sg should run must re-execute the installer with the
    // original flags preserved so phases 1-3 complete in the new shell.
    const cmdString = outcome.sgArgs.find((a) => a.includes("bash")) ?? "";
    expect(cmdString).toContain("scripts/install.sh");
    expect(cmdString).toContain("--non-interactive");
    expect(cmdString).toContain("--yes-i-accept-third-party-software");
  });

  it("falls back to the legacy exit-0 path in interactive mode (no regression)", () => {
    // In interactive mode the existing behavior — print instructions and
    // exit 0 — is still correct: a human can run `newgrp docker` themselves.
    const outcome = runEnsureDocker({}, []);
    expect(outcome.sgArgs.length).toBe(0);
    expect(outcome.status).toBe(0);
  });

  it("does not re-exec a second time when NEMOCLAW_DOCKER_GROUP_REACTIVATED=1 is already set (one-shot loop guard)", () => {
    // Failure mode we are guarding against: sg(1) re-exec succeeded but
    // /var/run/docker.sock is still unreachable (daemon down, AppArmor,
    // unusual mount). Without the env-var guard, the re-entered installer
    // would loop into another `exec sg docker -c …`, swallow stderr, and
    // burn CPU. The guard must demote the second pass to the legacy
    // "newgrp docker / re-curl" path with a clean exit 0 so the user sees
    // an actionable instruction instead of a hang.
    const outcome = runEnsureDocker(
      {
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_DOCKER_GROUP_REACTIVATED: "1",
      },
      ["--non-interactive", "--yes-i-accept-third-party-software"],
    );
    expect(outcome.sgArgs.length).toBe(0);
    expect(outcome.status).toBe(0);
    // The user-facing fallback instructions are the actionable signal a
    // human gets when the automated re-exec didn't restore docker access.
    // Pin them here so a future copy-edit can't silently drop them.
    expect(outcome.stdout).toContain("Run: newgrp docker");
    expect(outcome.stdout).toContain(
      "Re-run: curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash",
    );
  });
});

describeLinux("install.sh ensure_docker — Station intent across self re-exec", () => {
  it("unsets the derived provider before the Station Express Docker-group re-exec (#9900)", () => {
    const outcome = runEnsureDocker(
      {
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_PROVIDER: "install-vllm",
        NEMOCLAW_TEST_STATION_INSTALL_MODE: "express",
      },
      ["--non-interactive", "--yes-i-accept-third-party-software"],
    );

    expect(outcome.status, outcome.stderr).toBe(0);
    expect(outcome.sgArgs.length).toBeGreaterThan(0);
    expect(outcome.sgProvider).toBe("");
  });

  it("preserves an explicitly selected Station provider after re-exec", () => {
    const outcome = runEnsureDocker(
      {
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_PROVIDER: "install-vllm",
        NEMOCLAW_TEST_STATION_INSTALL_MODE: "provider",
      },
      ["--non-interactive", "--yes-i-accept-third-party-software"],
    );

    expect(outcome.status, outcome.stderr).toBe(0);
    expect(outcome.sgArgs.length).toBeGreaterThan(0);
    expect(outcome.sgProvider).toBe("install-vllm");
  });

  it("rejects an explicit managed-vLLM provider against an Express receipt (#9900)", () => {
    const { result, output } = runSourcedInstaller(`
state_dir="$(ensure_nemoclaw_state_dir)"
receipt="$state_dir/station-express-resume"
printf 'revision=${STATION_REVISION}\\nmodel=nemotron-3-ultra-550b-a55b\\ngeneration=${STATION_GENERATION}\\nagent=openclaw\\nsandbox=my-assistant\\npolicy_tier=balanced\\ngateway_port=8080\\ndashboard_port=18789\\nvllm_port=8000\\nmode=express\\n' >"$receipt"
chmod 0600 "$receipt"
detect_express_platform() { printf 'DGX Station'; }
station_installer_revision() { printf '${STATION_REVISION}'; }
NON_INTERACTIVE=''
NEMOCLAW_PROVIDER='install-vllm'
NEMOCLAW_NO_EXPRESS=''
maybe_offer_express_install
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toContain(
      "resume state was accepted in express mode; refusing to resume it in provider mode",
    );
  });

  it("resumes the saved Station Express receipt after Docker-group re-exec (#9900)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-docker-reexec-"));
    const home = path.join(tmp, "home");
    const fakeBin = path.join(tmp, "bin");
    const stagedInstaller = path.join(tmp, "staged-install.sh");
    const stateRoot = path.join(home, ".nemoclaw");
    const gatewaysRoot = path.join(stateRoot, "gateways");
    const stateDir = path.join(gatewaysRoot, "18081");
    const receipt = path.join(stateDir, "station-express-resume");
    const receiptContents =
      `revision=${STATION_REVISION}\nmodel=nemotron-3-ultra-550b-a55b\n` +
      `generation=${STATION_GENERATION}\nagent=openclaw\nsandbox=my-assistant\n` +
      "policy_tier=balanced\ngateway_port=18081\ndashboard_port=18790\n" +
      "vllm_port=18000\nmode=express\n";

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
    fs.chmodSync(stateRoot, 0o700);
    fs.chmodSync(gatewaysRoot, 0o700);
    fs.chmodSync(stateDir, 0o700);
    fs.writeFileSync(receipt, receiptContents, { mode: 0o600 });
    fs.writeFileSync(
      path.join(fakeBin, "sg"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        '[[ "${1:-}" == "docker" ]] || exit 91',
        '[[ "${2:-}" == "-c" ]] || exit 92',
        'exec bash -c "$3"',
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      stagedInstaller,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'source "$INSTALLER_UNDER_TEST" >/dev/null',
        "uname() { printf 'Linux\\n'; }",
        "docker() {",
        '  [[ "${NEMOCLAW_DOCKER_GROUP_REACTIVATED:-}" == "1" ]]',
        "}",
        "systemctl() { return 0; }",
        "sudo() { return 0; }",
        "id() {",
        '  case "$1" in',
        "    -u) printf '1000\\n' ;;",
        "    -un) printf 'testuser\\n' ;;",
        "    -nG) printf 'testuser sudo\\n' ;;",
        "  esac",
        "}",
        "is_wsl_host() { return 1; }",
        "verify_downloaded_script() { :; }",
        "detect_express_platform() { printf 'DGX Station'; }",
        `station_installer_revision() { printf '${STATION_REVISION}'; }`,
        `station_express_resume_generation() { printf '${STATION_GENERATION}'; }`,
        "NON_INTERACTIVE=''",
        "NEMOCLAW_NO_EXPRESS=''",
        "_NEMOCLAW_INSTALLER_ARGS=()",
        'NEMOCLAW_INSTALLER_STAGED="$0"',
        "maybe_offer_express_install",
        '[[ "${NEMOCLAW_DOCKER_GROUP_REACTIVATED:-}" != "1" ]] && printf \'RESUME_COMMAND=%s\\n\' "$(station_express_resume_command)"',
        "phase=parent",
        '[[ "${NEMOCLAW_DOCKER_GROUP_REACTIVATED:-}" == "1" ]] && phase=child',
        'printf \'PHASE=%s MODE=%s PROVIDER=%s\\n\' "$phase" "$_STATION_INSTALL_MODE" "$NEMOCLAW_PROVIDER"',
        "ensure_docker",
        '[[ "$phase" == "child" ]] && printf "CHILD_CONTINUED\\n"',
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", [stagedInstaller], {
        cwd: tmp,
        encoding: "utf-8",
        env: {
          HOME: home,
          PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          NEMOCLAW_AGENT: "openclaw",
          NEMOCLAW_SANDBOX_NAME: "my-assistant",
          NEMOCLAW_POLICY_TIER: "balanced",
          NEMOCLAW_GATEWAY_PORT: "18081",
          NEMOCLAW_DASHBOARD_PORT: "18790",
          NEMOCLAW_VLLM_PORT: "18000",
        },
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(0);
      const resumeCommand = output
        .split("\n")
        .find((line) => line.startsWith("RESUME_COMMAND="));
      expect(resumeCommand).toContain("NEMOCLAW_AGENT=openclaw");
      expect(resumeCommand).not.toContain("NEMOCLAW_PROVIDER");
      expect(output).toContain("PHASE=parent MODE=express PROVIDER=install-vllm");
      expect(output).toContain("PHASE=child MODE=express PROVIDER=install-vllm");
      expect(output).toContain("CHILD_CONTINUED");
      expect(output).not.toContain("refusing to resume it in provider mode");
      expect(fs.readFileSync(receipt, "utf-8")).toBe(receiptContents);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
