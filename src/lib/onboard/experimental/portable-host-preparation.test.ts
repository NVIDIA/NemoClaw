// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePortableExperimentalHost } from "./portable-host-preparation";

type SpawnResult = ReturnType<typeof spawnSync>;

function result(status = 0, stdout = ""): SpawnResult {
  return { status, stdout, stderr: "" } as SpawnResult;
}

describe("preparePortableExperimentalHost", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does nothing unless the portable profile is explicit", () => {
    const systemctl = vi.fn();
    const docker = vi.fn();
    const env: NodeJS.ProcessEnv = {};

    preparePortableExperimentalHost(env, { docker, systemctl });

    expect(env.DOCKER_HOST).toBeUndefined();
    expect(systemctl).not.toHaveBeenCalled();
    expect(docker).not.toHaveBeenCalled();
  });

  it("prepares the rootless socket and managed loopback registry deterministically", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const systemctl = vi.fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>(() =>
      result(),
    );
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result(1))
      .mockReturnValueOnce(result());
    const env: NodeJS.ProcessEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };

    preparePortableExperimentalHost(env, {
      platform: "linux",
      home,
      uid: 1001,
      systemctl,
      docker,
    });

    expect(env).toMatchObject({
      DOCKER_HOST: "unix:///run/user/1001/podman/podman.sock",
      NETAVARK_FW: "iptables",
    });
    expect(systemctl.mock.calls.map(([args]) => args)).toEqual([
      ["--user", "set-environment", "NETAVARK_FW=iptables"],
      ["--user", "try-restart", "podman.service"],
      ["--user", "enable", "--now", "podman.socket"],
    ]);
    expect(docker.mock.calls[1]?.[0]).toEqual([
      "run",
      "-d",
      "--name",
      "nemoclaw-portable-registry",
      "--label",
      "com.nvidia.nemoclaw.portable=1",
      "-p",
      "127.0.0.1:5000:5000",
      "--restart=always",
      "docker.io/library/registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373",
    ]);
    const registryConfig = path.join(
      home,
      ".config/containers/registries.conf.d/99-nemoclaw-portable.conf",
    );
    expect(fs.readFileSync(registryConfig, "utf-8")).toContain('location = "localhost:5000"');
    expect(fs.statSync(registryConfig).mode & 0o777).toBe(0o600);
  });

  it("refuses to replace an unmanaged registry container", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const env: NodeJS.ProcessEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };

    expect(() =>
      preparePortableExperimentalHost(env, {
        platform: "linux",
        home,
        uid: 1001,
        systemctl: () => result(),
        docker: () => result(0, "unexpected-owner"),
      }),
    ).toThrow(/unmanaged container/);
  });
});
