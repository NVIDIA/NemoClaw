// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import { GATEWAYS_SUBDIR, nemoclawStateRoot } from "./state-root";

const HOME = "/home/alice";

describe("nemoclawStateRoot", () => {
  it("resolves the default gateway port to ~/.nemoclaw byte-identically (#3053)", () => {
    expect(nemoclawStateRoot(HOME, DEFAULT_GATEWAY_PORT)).toBe(path.join(HOME, ".nemoclaw"));
  });

  it("segregates a non-default gateway port under ~/.nemoclaw/gateways/<port> (#3053)", () => {
    expect(nemoclawStateRoot(HOME, 8091)).toBe(
      path.join(HOME, ".nemoclaw", GATEWAYS_SUBDIR, "8091"),
    );
    expect(nemoclawStateRoot(HOME, 9000)).toBe(
      path.join(HOME, ".nemoclaw", GATEWAYS_SUBDIR, "9000"),
    );
  });

  it("keeps each segregated root distinct and beneath the shared default root (#3053)", () => {
    const shared = nemoclawStateRoot(HOME, DEFAULT_GATEWAY_PORT);
    const portA = nemoclawStateRoot(HOME, 8091);
    const portB = nemoclawStateRoot(HOME, 8092);
    expect(portA).not.toBe(portB);
    expect(portA.startsWith(`${shared}${path.sep}`)).toBe(true);
    expect(portB.startsWith(`${shared}${path.sep}`)).toBe(true);
  });
});

describe("getNemoclawStateRoot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to the shared root when NEMOCLAW_GATEWAY_PORT is unset (#3053)", async () => {
    vi.resetModules();
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "");
    const { getNemoclawStateRoot: freshGetNemoclawStateRoot } = await import("./state-root");
    expect(freshGetNemoclawStateRoot(HOME)).toBe(path.join(HOME, ".nemoclaw"));
  });
});
