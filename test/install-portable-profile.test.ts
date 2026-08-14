// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");

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
