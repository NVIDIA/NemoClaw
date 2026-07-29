// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isSupportedGatewayDockerHost } from "./docker-host";

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
