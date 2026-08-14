// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createDefaultResumeProfileEnvironmentScope,
  createPortableOnboardEnvironmentScope,
  PORTABLE_RUNTIME_ENV_KEYS,
} from "./session-bootstrap";

const CLEARED_PORTABLE_RUNTIME_ENV_KEYS = PORTABLE_RUNTIME_ENV_KEYS.filter(
  (key) => key !== "NEMOCLAW_EXPERIMENTAL_PROFILE",
);

describe("portable onboarding environment scope", () => {
  it("restores default checkpoint classification over hostile ambient portable intent", () => {
    const env: NodeJS.ProcessEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };
    const scope = createDefaultResumeProfileEnvironmentScope(env);
    expect(env.NEMOCLAW_EXPERIMENTAL_PROFILE).toBeUndefined();
    scope.restore();
    expect(env.NEMOCLAW_EXPERIMENTAL_PROFILE).toBe("portable");
  });

  it("clears hostile runtime selectors and installs only canonical derived authority", () => {
    const env: NodeJS.ProcessEnv = {
      DOCKER_HOST: "tcp://attacker.test:2375",
      DOCKER_CONTEXT: "hostile-context",
      DOCKER_CONFIG: "/tmp/hostile-docker-config",
      DOCKER_TLS: "1",
      DOCKER_TLS_VERIFY: "1",
      DOCKER_CERT_PATH: "/tmp/hostile-docker-certs",
      XDG_CONFIG_HOME: "/tmp/hostile-xdg-config",
      CONTAINERS_CONF: "/tmp/hostile-containers.conf",
      NETAVARK_FW: "firewalld",
      CONTAINER_HOST: "ssh://attacker.test",
      CONTAINER_CONNECTION: "attacker",
      CONTAINER_SSHKEY: "/tmp/attacker-key",
    };

    const scope = createPortableOnboardEnvironmentScope(env, null);

    for (const key of CLEARED_PORTABLE_RUNTIME_ENV_KEYS) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.NEMOCLAW_EXPERIMENTAL_PROFILE).toBe("portable");
    scope.installRuntime({
      containersConf: "/home/alice/.config/nemoclaw/portable/containers.conf",
      socketPath: "/run/user/1000/podman/podman.sock",
    });
    expect(env).toMatchObject({
      DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock",
      CONTAINERS_CONF: "/home/alice/.config/nemoclaw/portable/containers.conf",
      NETAVARK_FW: "iptables",
    });
    expect(env.CONTAINER_HOST).toBeUndefined();
    expect(env.CONTAINER_CONNECTION).toBeUndefined();
    expect(env.CONTAINER_SSHKEY).toBeUndefined();
  });

  it("restores absent, empty, and valued keys exactly after success or failure", () => {
    const env: NodeJS.ProcessEnv = {
      DOCKER_HOST: "",
      DOCKER_TLS: "",
      DOCKER_TLS_VERIFY: "1",
      DOCKER_CERT_PATH: "/previous/docker-certs",
      HOME: "/hostile/home",
      XDG_CONFIG_HOME: "",
      CONTAINERS_CONF: "/previous/containers.conf",
      NEMOCLAW_EXPERIMENTAL_PROFILE: "previous",
      NEMOCLAW_POLICY_PRESETS: "weather,github",
    };
    const before = { ...env };
    const scope = createPortableOnboardEnvironmentScope(env, {
      schemaVersion: 1,
      baseUrl: "https://inference.example.test/v1",
      model: "vendor/model",
      expiresAt: "2026-08-13T20:00:00.000Z",
    });

    try {
      scope.installRuntime({
        containersConf: "/canonical/containers.conf",
        socketPath: "/run/user/1000/podman/podman.sock",
      });
      throw new Error("controlled failure");
    } catch (error) {
      expect(error).toMatchObject({ message: "controlled failure" });
    } finally {
      scope.restore();
    }

    expect(env).toEqual(before);
    expect(Object.prototype.hasOwnProperty.call(env, "DOCKER_HOST")).toBe(true);
    expect(env.DOCKER_HOST).toBe("");
    expect(Object.prototype.hasOwnProperty.call(env, "CONTAINER_HOST")).toBe(false);
    scope.restore();
    expect(env).toEqual(before);
  });

  it("clears ambient inference selectors while preserving an explicit resume policy list (#9035)", () => {
    const env: NodeJS.ProcessEnv = {
      NEMOCLAW_PROVIDER: "ollama",
      NEMOCLAW_MODEL: "hostile-model",
      NEMOCLAW_ENDPOINT_URL: "https://attacker.test/v1",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_POLICY_MODE: "custom",
      NEMOCLAW_POLICY_PRESETS: "github,npm,pypi,public-reference,weather",
      NEMOCLAW_POLICY_TIER: "personal",
      NEMOCLAW_TOOL_DISCLOSURE: "progressive",
    };
    const before = { ...env };
    const scope = createPortableOnboardEnvironmentScope(env, null, { resume: true });

    expect(env).toMatchObject({
      NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
      NEMOCLAW_OLLAMA_NO_AUTOSTART: "1",
      NEMOCLAW_POLICY_MODE: "custom",
      NEMOCLAW_POLICY_PRESETS: "github,npm,pypi,public-reference,weather",
    });
    for (const key of [
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_MODEL",
      "NEMOCLAW_ENDPOINT_URL",
      "NEMOCLAW_PREFERRED_API",
      "NEMOCLAW_POLICY_TIER",
      "NEMOCLAW_TOOL_DISCLOSURE",
    ]) {
      expect(env).not.toHaveProperty(key);
    }

    scope.restore();
    expect(env).toEqual(before);
  });
});
