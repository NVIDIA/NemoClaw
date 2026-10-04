// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLocalDualStationDockerEnv,
  buildRemoteVllmDockerEnv,
  buildVllmDockerEnv,
} from "./vllm-docker-env";
import {
  clearDualStationSshBinding,
  stationKnownHostsDigest,
  writeDualStationSshBinding,
} from "./vllm-station-ssh-binding";
import {
  createDualStationSshBindingFixture,
  type DualStationSshBindingFixture,
} from "./vllm-station-ssh-binding.test-support";

let sshFixture: DualStationSshBindingFixture;

beforeEach(() => {
  sshFixture = createDualStationSshBindingFixture("station@dgx-peer.example.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  sshFixture.cleanup();
});

describe("managed vLLM Docker client environment", () => {
  it("forwards one Docker context while retaining subprocess secret filtering (#6757)", () => {
    vi.stubEnv("DOCKER_CONFIG", "/tmp/nemoclaw-docker-config");
    vi.stubEnv("DOCKER_CONTEXT", "remote-builder");
    vi.stubEnv("DOCKER_HOST", "ssh://fallback.example.test");
    vi.stubEnv("DOCKER_TLS", "1");
    vi.stubEnv("UNRELATED_SECRET", "do-not-forward");

    const env = buildVllmDockerEnv({ HF_TOKEN: "hf_test" });

    expect(env).toEqual(
      expect.objectContaining({
        DOCKER_CONFIG: "/tmp/nemoclaw-docker-config",
        DOCKER_CONTEXT: "remote-builder",
        DOCKER_HOST: "ssh://fallback.example.test",
        DOCKER_TLS: "1",
        HF_TOKEN: "hf_test",
      }),
    );
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });

  it("does not inherit Docker selectors omitted from an explicit source (#6757)", () => {
    vi.stubEnv("DOCKER_HOST", "ssh://ambient.example.test");

    const env = buildVllmDockerEnv({}, { DOCKER_CONTEXT: "requested-context" });

    expect(env.DOCKER_CONTEXT).toBe("requested-context");
    expect(env.DOCKER_HOST).toBeUndefined();
  });

  it("pins a canonical SSH daemon and strips incompatible ambient Docker selectors", () => {
    vi.stubEnv("DOCKER_API_VERSION", "1.48");
    vi.stubEnv("DOCKER_CERT_PATH", "/tmp/ambient-docker-certs");
    vi.stubEnv("DOCKER_CONFIG", "/tmp/nemoclaw-docker-config");
    vi.stubEnv("DOCKER_CONTEXT", "ambient-context");
    vi.stubEnv("DOCKER_HOST", "tcp://ambient.example.test:2376");
    vi.stubEnv("DOCKER_TLS", "1");
    vi.stubEnv("DOCKER_TLS_VERIFY", "1");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/ssh-agent.sock");
    vi.stubEnv("OPENSHELL_GATEWAY_AUTH_TOKEN", "must-not-cross-ssh");
    vi.stubEnv("UNRELATED_SECRET", "do-not-forward");

    const env = buildRemoteVllmDockerEnv(sshFixture.binding);

    expect(env).toEqual(
      expect.objectContaining({
        DOCKER_HOST: "ssh://station@192.168.50.20",
        SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      }),
    );
    expect(env.PATH).toBe(sshFixture.binding.sshWrapperDirectory);
    expect(env.DOCKER_API_VERSION).toBeUndefined();
    expect(env.DOCKER_CERT_PATH).toBeUndefined();
    expect(env.DOCKER_CONFIG).toBeUndefined();
    expect(env.DOCKER_CONTEXT).toBeUndefined();
    expect(env.DOCKER_TLS).toBeUndefined();
    expect(env.DOCKER_TLS_VERIFY).toBeUndefined();
    expect(env.UNRELATED_SECRET).toBeUndefined();
    expect(env.OPENSHELL_GATEWAY_AUTH_TOKEN).toBeUndefined();
  });

  it("pins the dual-Station head to the physical host default Docker daemon", () => {
    const env = buildLocalDualStationDockerEnv(
      { SAFE_MARKER: "kept" },
      {
        DOCKER_HOST: "ssh://wrong-daemon",
        DOCKER_CONTEXT: "wrong-context",
        DOCKER_CONFIG: "/tmp/wrong-config",
      },
    );

    expect(env.SAFE_MARKER).toBe("kept");
    expect(env.DOCKER_HOST).toBeUndefined();
    expect(env.DOCKER_CONTEXT).toBe("default");
    expect(env.DOCKER_CONFIG).toBeUndefined();
  });

  it("rejects a changed qualified host-key pin before constructing a Docker environment", () => {
    fs.appendFileSync(sshFixture.binding.knownHostsFile, "changed\n");

    expect(() => buildRemoteVllmDockerEnv(sshFixture.binding)).toThrow(
      "Station SSH known-hosts binding changed after qualification",
    );
  });

  it("keeps an existing environment pinned when a later qualification writes a new version", () => {
    const first = sshFixture.binding;
    const firstEnv = buildRemoteVllmDockerEnv(first);
    const replacementHost = "192.168.50.21";
    const replacementLines = [
      `${replacementHost} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIcmVwbGFjZW1lbnQ=`,
    ];
    const second = writeDualStationSshBinding(
      sshFixture.resumeStatePath,
      {
        ...sshFixture.identity,
        resolvedHost: replacementHost,
        lookupHost: replacementHost,
        hostKeyDigest: stationKnownHostsDigest(`${replacementLines.join("\n")}\n`),
        knownHostsLines: replacementLines,
      },
      { dockerCliFile: sshFixture.dockerCliFile },
    );
    const secondEnv = buildRemoteVllmDockerEnv(second);

    expect(second.sshWrapperDirectory).not.toBe(first.sshWrapperDirectory);
    expect(firstEnv.PATH).toBe(first.sshWrapperDirectory);
    expect(secondEnv.PATH).toBe(second.sshWrapperDirectory);
    expect(firstEnv.DOCKER_HOST).toBe("ssh://station@192.168.50.20");
    expect(secondEnv.DOCKER_HOST).toBe(`ssh://station@${replacementHost}`);
    expect(buildRemoteVllmDockerEnv(first)).toEqual(firstEnv);
    expect(fs.existsSync(first.dockerShimFile)).toBe(true);
    expect(fs.existsSync(second.dockerShimFile)).toBe(true);
  });

  it("fails closed instead of falling through to ambient Docker after cleanup", () => {
    const env = buildRemoteVllmDockerEnv(sshFixture.binding);

    clearDualStationSshBinding(sshFixture.resumeStatePath);

    const result = spawnSync("docker", ["version"], { env, encoding: "utf8" });
    expect(result.status).toBeNull();
    expect(result.error).toMatchObject({ code: "ENOENT" });
    expect(() => buildRemoteVllmDockerEnv(sshFixture.binding)).toThrow();
  });
});
