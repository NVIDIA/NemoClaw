// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "../..", "scripts", "install.sh");

function runPortableOverride(profile = "portable", dockerHost = ""): ReturnType<typeof spawnSync> {
  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    NEMOCLAW_EXPERIMENTAL_PROFILE="${profile}"
    export NEMOCLAW_EXPERIMENTAL_PROFILE
    command_exists() { return 0; }
    uname() { printf 'Linux\\n'; }
    systemctl() { printf 'SYSTEMCTL=%s\\n' "$*" >&2; }
    podman() {
      printf 'PODMAN=%s\\n' "$*" >&2
      printf '/run/user/4242/selected/podman.sock\\n'
    }
    info() { printf 'INFO=%s\\n' "$*"; }
    error() { printf 'ERROR=%s\\n' "$*" >&2; return 1; }
    prepare_portable_experimental_runtime_override
    printf 'DOCKER_HOST=%s\\n' "\${DOCKER_HOST:-}"
  `;
  return spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: { ...process.env, DOCKER_HOST: dockerHost },
  });
}

function runPortableOnboard(
  agent: "hermes" | "openclaw",
  options: {
    readonly childEnv?: Readonly<Record<string, string>>;
    readonly replaceDockerHost?: boolean;
  } = {},
): { readonly child: Readonly<Record<string, string>>; readonly stdout: string } {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-onboard-"));
  const stubBin = path.join(fixture, "stub-cli");
  const childLog = path.join(fixture, "child.env");
  fs.writeFileSync(
    stubBin,
    `#!/usr/bin/env bash
{
  printf 'DOCKER_HOST_SET=%s\\n' "\${DOCKER_HOST+x}"
  printf 'DOCKER_HOST=%s\\n' "\${DOCKER_HOST-}"
  printf 'CONTAINER_HOST=%s\\n' "\${CONTAINER_HOST-}"
  printf 'DOCKER_CONTEXT=%s\\n' "\${DOCKER_CONTEXT-}"
  printf 'ARGS=%s\\n' "$*"
} > "${childLog}"
`,
    { mode: 0o755 },
  );

  const replaceDockerHost = options.replaceDockerHost
    ? 'DOCKER_HOST="tcp://replacement.invalid:2375"; export DOCKER_HOST'
    : ":";
  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    _CLI_BIN="${stubBin}"
    _CLI_PATH="${stubBin}"
    command_exists() { return 0; }
    uname() { printf 'Linux\\n'; }
    systemctl() { :; }
    podman() { printf '/run/user/4242/podman/podman.sock\\n'; }
    info() { :; }
    warn() { :; }
    error() { printf 'ERROR=%s\\n' "$*" >&2; exit 1; }
    show_usage_notice() { :; }
    prepare_portable_experimental_runtime_override
    printf 'INSTALLER_DOCKER_HOST=%s\\n' "$DOCKER_HOST"
    ${replaceDockerHost}
    run_onboard
  `;

  try {
    const result = spawnSync("bash", ["-c", snippet], {
      encoding: "utf-8",
      env: {
        ...process.env,
        ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        HOME: fixture,
        NEMOCLAW_AGENT: agent,
        NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
        NON_INTERACTIVE: "1",
        ...options.childEnv,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const child = Object.fromEntries(
      fs
        .readFileSync(childLog, "utf-8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return { child, stdout: result.stdout };
  } finally {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
}

describe("installer portable profile runtime override", () => {
  it("selects the Podman-reported rootless socket before installer preflight", () => {
    const result = runPortableOverride();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("SYSTEMCTL=--user enable --now podman.socket");
    expect(result.stdout).toContain("DOCKER_HOST=unix:///run/user/4242/selected/podman.sock");
  });

  it("does not touch the runtime without the explicit portable profile", () => {
    const result = runPortableOverride("", "unix:///preexisting.sock");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("DOCKER_HOST=unix:///preexisting.sock\n");
    expect(result.stderr).toBe("");
  });

  it("unsets only its exact Podman DOCKER_HOST selector for the portable Hermes onboarding child", () => {
    const result = runPortableOnboard("hermes", {
      childEnv: {
        CONTAINER_HOST: "ssh://remote.invalid/run/podman.sock",
        DOCKER_CONTEXT: "remote-context",
      },
    });

    expect(result.stdout).toContain(
      "INSTALLER_DOCKER_HOST=unix:///run/user/4242/podman/podman.sock",
    );
    expect(result.child).toMatchObject({
      ARGS: expect.stringContaining("onboard --experimental-profile portable"),
      CONTAINER_HOST: "ssh://remote.invalid/run/podman.sock",
      DOCKER_CONTEXT: "remote-context",
      DOCKER_HOST: "",
      DOCKER_HOST_SET: "",
    });
  });

  it("keeps a replaced DOCKER_HOST for strict Hermes rejection", () => {
    const result = runPortableOnboard("hermes", { replaceDockerHost: true });

    expect(result.child).toMatchObject({
      DOCKER_HOST: "tcp://replacement.invalid:2375",
      DOCKER_HOST_SET: "x",
    });
  });

  it("preserves the portable OpenClaw Docker CLI selector", () => {
    const result = runPortableOnboard("openclaw");

    expect(result.child).toMatchObject({
      DOCKER_HOST: "unix:///run/user/4242/podman/podman.sock",
      DOCKER_HOST_SET: "x",
    });
  });

  it("rejects an unknown experimental profile before install effects (#9007)", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-invalid-profile-"));
    const processTemp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-invalid-profile-tmp-"));
    try {
      const marker = path.join(fixture, "existing-state");
      fs.writeFileSync(marker, "unchanged\n");
      const stateBefore = fs.readdirSync(fixture);

      const result = spawnSync(
        "bash",
        [INSTALLER_PAYLOAD, "--experimental-profile", "not-portable"],
        {
          cwd: fixture,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: fixture,
            NEMOCLAW_EXPERIMENTAL_PROFILE: "",
            TMPDIR: processTemp,
            XDG_CONFIG_HOME: path.join(fixture, "config"),
          },
        },
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Unknown experimental profile: not-portable (expected: portable).",
      );
      expect(fs.readdirSync(fixture)).toEqual(stateBefore);
      expect(fs.readFileSync(marker, "utf-8")).toBe("unchanged\n");
    } finally {
      fs.rmSync(processTemp, { force: true, recursive: true });
      fs.rmSync(fixture, { force: true, recursive: true });
    }
  });
});
