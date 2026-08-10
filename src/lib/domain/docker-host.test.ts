// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  isDockerDaemonReachable,
  isSupportedGatewayDockerHost,
  parseDockerDaemonObservation,
} from "./docker-host";

describe("parseDockerDaemonObservation", () => {
  it("requires positive daemon evidence from Docker JSON", () => {
    expect(
      parseDockerDaemonObservation(
        JSON.stringify({ ServerVersion: "29.3.1", OperatingSystem: "Ubuntu 24.04" }),
      ),
    ).toEqual({ reachable: true, serverVersion: "29.3.1" });

    expect(
      parseDockerDaemonObservation(
        JSON.stringify({
          ServerVersion: "",
          ServerErrors: ["Cannot connect to the Docker daemon"],
        }),
      ),
    ).toEqual({ reachable: false });
    expect(isDockerDaemonReachable(JSON.stringify({ ServerVersion: "" }))).toBe(false);
  });

  it("recognizes native Podman version evidence used by a docker alias", () => {
    expect(
      parseDockerDaemonObservation(
        JSON.stringify({ version: { APIVersion: "5.3.1", Version: "5.3.1" } }),
      ),
    ).toEqual({ reachable: true, serverVersion: "5.3.1" });
  });

  it("keeps the plain-text compatibility path without accepting connection errors", () => {
    expect(parseDockerDaemonObservation("25.0.0")).toEqual({
      reachable: true,
      serverVersion: "25.0.0",
    });
    expect(
      isDockerDaemonReachable(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      ),
    ).toBe(false);
  });
});

describe("isSupportedGatewayDockerHost (#7731)", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["absolute unix socket", "unix:///var/run/docker.sock"],
    ["absolute unix socket with surrounding whitespace", "  unix:///var/run/docker.sock  "],
  ])("accepts %s DOCKER_HOST", (_case, value) => {
    expect(isSupportedGatewayDockerHost(value)).toBe(true);
  });

  it.each([
    ["a TCP endpoint", "tcp://203.0.113.10:2375"],
    ["an ssh endpoint", "ssh://user@host"],
    ["an fd endpoint", "fd://"],
    ["a bare socket path without a scheme", "/var/run/docker.sock"],
    ["a relative unix path", "unix://relative/docker.sock"],
    ["a unix socket path with a quote", "unix:///var/run/dock'er.sock"],
    ["a unix socket path with an embedded newline", "unix:///var/run/\ndocker.sock"],
    ["a unix socket with a trailing newline", "unix:///var/run/docker.sock\n"],
    ["a unix socket with a trailing carriage return", "unix:///var/run/docker.sock\r"],
    ["a value with a null byte", "unix:///var/run/docker.sock\0"],
  ])("rejects %s", (_case, value) => {
    expect(isSupportedGatewayDockerHost(value)).toBe(false);
  });
});
