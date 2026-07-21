// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");

function runSourced(body: string, extraEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-docker-repository-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$SCRIPT_UNDER_TEST" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        SCRIPT_UNDER_TEST: STATION_PREPARE,
        ...extraEnv,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { result, output: `${result.stdout}${result.stderr}` };
}

const DOCKER_REPOSITORY_FIXTURE = `
prepare_docker_repository_fixture() {
  mkdir -p "$HOME/root/etc/apt/keyrings" "$HOME/root/etc/apt/sources.list.d"
  printf 'verified ascii key\n' >"$HOME/docker.asc"
  printf 'verified dearmored key\n' >"$HOME/docker.gpg"
  printf '%s\n' \\
    'deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable' \\
    >"$HOME/docker-gpg.list"
  printf '%s\n' \\
    'deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable' \\
    >"$HOME/docker-asc.list"
}
assert_root_regular_file_safe() { printf 'ASSERT_SAFE %s\n' "$1"; }
sudo() {
  if [[ "$*" == 'test ! -L /etc/apt/sources.list.d/docker.list' ]]; then
    test ! -L "$HOME/root/etc/apt/sources.list.d/docker.list"
    return
  fi
  if [[ "$*" == 'test -e /etc/apt/sources.list.d/docker.list' ]]; then
    test -e "$HOME/root/etc/apt/sources.list.d/docker.list"
    return
  fi
  if [[ "$1" == 'cmp' && "$2" == '-s' ]]; then
    case "$4" in
      /etc/apt/sources.list.d/docker.list)
        cmp -s "$3" "$HOME/root/etc/apt/sources.list.d/docker.list"
        ;;
      /etc/apt/keyrings/docker.gpg)
        cmp -s "$3" "$HOME/root/etc/apt/keyrings/docker.gpg"
        ;;
      /etc/apt/keyrings/docker.asc)
        cmp -s "$3" "$HOME/root/etc/apt/keyrings/docker.asc"
        ;;
      *) return 1 ;;
    esac
    return
  fi
  return 1
}
`;

const VERIFY_REPOSITORY = `
ensure_docker_repository_source \
  "$HOME/docker.asc" \
  "$HOME/docker.gpg" \
  "$HOME/docker-gpg.list" \
  "$HOME/docker-asc.list"
`;

describe("DGX Station Docker repository compatibility", () => {
  it("reuses the exact .gpg source with its verified key", () => {
    const { result, output } = runSourced(`
${DOCKER_REPOSITORY_FIXTURE}
prepare_docker_repository_fixture
cp "$HOME/docker.gpg" "$HOME/root/etc/apt/keyrings/docker.gpg"
cp "$HOME/docker-gpg.list" "$HOME/root/etc/apt/sources.list.d/docker.list"
${VERIFY_REPOSITORY}
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("ASSERT_SAFE /etc/apt/sources.list.d/docker.list");
    expect(output).toContain("ASSERT_SAFE /etc/apt/keyrings/docker.gpg");
    expect(output).toContain("docker_repository_source=exact");
  });

  it("reuses the equivalent .asc source with its verified key", () => {
    const { result, output } = runSourced(`
${DOCKER_REPOSITORY_FIXTURE}
prepare_docker_repository_fixture
cp "$HOME/docker.asc" "$HOME/root/etc/apt/keyrings/docker.asc"
cp "$HOME/docker-asc.list" "$HOME/root/etc/apt/sources.list.d/docker.list"
${VERIFY_REPOSITORY}
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("ASSERT_SAFE /etc/apt/sources.list.d/docker.list");
    expect(output).toContain("ASSERT_SAFE /etc/apt/keyrings/docker.asc");
    expect(output).toContain("docker_repository_source=verified_compatible");
  });

  it("rejects an .asc source when its installed key differs", () => {
    const { result, output } = runSourced(`
${DOCKER_REPOSITORY_FIXTURE}
prepare_docker_repository_fixture
printf 'different ascii key\n' >"$HOME/root/etc/apt/keyrings/docker.asc"
cp "$HOME/docker-asc.list" "$HOME/root/etc/apt/sources.list.d/docker.list"
${VERIFY_REPOSITORY}
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/ASCII key differs from the verified key/);
    expect(output).not.toContain("docker_repository_source=verified_compatible");
  });

  it.each([
    [
      "a changed URL",
      "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://mirror.invalid/linux/ubuntu noble stable\n",
    ],
    [
      "an extra source line",
      "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\ndeb https://mirror.invalid/linux/ubuntu noble stable\n",
    ],
  ])("rejects a source with %s", (_case, sourceContent) => {
    const { result, output } = runSourced(
      `
${DOCKER_REPOSITORY_FIXTURE}
prepare_docker_repository_fixture
cp "$HOME/docker.asc" "$HOME/root/etc/apt/keyrings/docker.asc"
printf '%s' "$SOURCE_CONTENT" >"$HOME/root/etc/apt/sources.list.d/docker.list"
${VERIFY_REPOSITORY}
`,
      { SOURCE_CONTENT: sourceContent },
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/differs from the validated \.gpg and \.asc forms/);
  });

  it("rejects a symlinked source", () => {
    const { result, output } = runSourced(`
${DOCKER_REPOSITORY_FIXTURE}
prepare_docker_repository_fixture
cp "$HOME/docker.asc" "$HOME/root/etc/apt/keyrings/docker.asc"
ln -s "$HOME/docker-asc.list" "$HOME/root/etc/apt/sources.list.d/docker.list"
${VERIFY_REPOSITORY}
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/Docker repository source must not be a symbolic link/);
  });

  it("uses the dearmored key for a new source", () => {
    const { result, output } = runSourced(`
${DOCKER_REPOSITORY_FIXTURE}
prepare_docker_repository_fixture
install_exact_file_or_reuse() { printf 'INSTALL %s -> %s\n' "$1" "$2"; }
${VERIFY_REPOSITORY}
`);

    expect(result.status, output).toBe(0);
    expect(output).toMatch(/INSTALL .+\/docker\.gpg -> \/etc\/apt\/keyrings\/docker\.gpg/);
    expect(output).toMatch(
      /INSTALL .+\/docker-gpg\.list -> \/etc\/apt\/sources\.list\.d\/docker\.list/,
    );
    expect(output).not.toContain("docker.asc -> /etc/apt/keyrings");
  });
});
