// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");

type EnsureDockerOutcome = {
  status: number | null;
  stdout: string;
  stderr: string;
  sgArgs: string[];
};

function runEnsureDocker(env: Record<string, string>, installerArgs: string[]): EnsureDockerOutcome {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-docker-group-"));
  const sgLog = path.join(tmp, "sg-args.txt");
  const sgStub = path.join(tmp, "sg");

  // Stub `sg`: record the args the installer asked us to execute, then exit 0.
  // Without this stub, `exec sg docker -c …` would replace the test process
  // with a real group switch — flaky and platform-dependent.
  fs.writeFileSync(
    sgStub,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${sgLog}"\nexit 0\n`,
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
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true

    # Force the slow path through ensure_docker:
    #   - docker info fails (group not yet active in this shell)
    #   - docker binary exists, so the install step is skipped
    #   - systemctl exits cleanly so the daemon-start branch is a no-op
    #   - user is non-root, not in docker group via NSS, not in active group list
    #   - sudo is a no-op so usermod doesn't actually run
    #   - is_wsl_host returns 1 so we don't bail out early
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
    verify_downloaded_script() { :; }

    _NEMOCLAW_INSTALLER_ARGS=(${argsArrayLiteral})
    export PATH="${tmp}:$PATH"

    ensure_docker
  `;

  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });

  const sgArgs = fs.existsSync(sgLog)
    ? fs.readFileSync(sgLog, "utf-8").split("\n").filter((line) => line.length > 0)
    : [];

  return { status: result.status, stdout: result.stdout, stderr: result.stderr, sgArgs };
}

describe("install.sh ensure_docker — #4414 non-interactive self re-exec", () => {
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
