// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { PORTABLE_DOCKER_NETWORK_SUBNET, PORTABLE_HOST_GATEWAY_IP } from "./portable-profile";

function ipv4ToNumber(address: string): number {
  return address
    .split(".")
    .map((part) => Number(part))
    .reduce((value, part) => value * 256 + part, 0);
}

function cidrRange(cidr: string): { first: number; last: number } {
  const [baseAddress, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  const size = 2 ** (32 - prefix);
  const first = Math.floor(ipv4ToNumber(baseAddress) / size) * size;
  return { first, last: first + size - 1 };
}

describe("portable experimental profile network authority", () => {
  it("keeps the host gateway outside the sandbox network subnet (#9587)", () => {
    const gateway = ipv4ToNumber(PORTABLE_HOST_GATEWAY_IP);
    const sandboxSubnet = cidrRange(PORTABLE_DOCKER_NETWORK_SUBNET);

    expect(gateway >= sandboxSubnet.first && gateway <= sandboxSubnet.last).toBe(false);
  });
});
