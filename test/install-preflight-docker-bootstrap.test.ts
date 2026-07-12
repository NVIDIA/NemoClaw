// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTALLER_PAYLOAD,
  TEST_SYSTEM_PATH,
  writeExecutable,
} from "./helpers/installer-sourced-env";

describe("installer Docker bootstrap (sourced)", () => {
  function runEnsureDockerWithStubs({
    dockerScript,
    idScript,
    statScript,
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
    statScript?: string;
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
    if (statScript) writeExecutable(path.join(fakeBin, "stat"), statScript);
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
# These tests validate the Linux Docker bootstrap branches. On a real WSL
# runner the installer intentionally skips that bootstrap, so force the helper
# under test to behave as a non-WSL Linux host while keeping uname/id/docker
# stubbed through PATH.
is_wsl_host() { return 1; }
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

  it("reports when Docker is reachable for a non-docker-group Linux user", () => {
    const { result, sudoLog } = runEnsureDockerWithStubs({
      dockerScript: `#!/usr/bin/env bash
if [ "\${1:-}" = "info" ]; then exit 0; fi
exit 0
`,
      idScript: `#!/usr/bin/env bash
case "$*" in
  "-u") printf '1000\\n' ;;
  "-un") printf 'alice\\n' ;;
  "-nG alice") printf 'alice sudo\\n' ;;
  "-nG") printf 'alice sudo\\n' ;;
  *) printf 'unexpected id %s\\n' "$*" >&2; exit 99 ;;
esac
`,
      statScript: `#!/usr/bin/env bash
if [ "\${1:-}" = "-Lc" ]; then
  printf '660 root docker /var/run/docker.sock\\n'
  exit 0
fi
exit 99
`,
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(
      /Docker is reachable even though user 'alice' is not in the docker group/,
    );
    expect(output).toMatch(/DOCKER_HOST/);
    expect(output).toMatch(/660 root docker \/var\/run\/docker\.sock/);
    expect(output).not.toMatch(/newgrp docker/);
    expect(sudoLog).not.toMatch(/usermod/);
  });

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
