// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import { resolveStopGatewayPort } from "./gateway-port-release";

describe("resolveStopGatewayPort (#5968)", () => {
  it("prefers an explicit port override", () => {
    expect(resolveStopGatewayPort({ port: 9090 }, () => null)).toBe(9090);
  });

  it("fails closed (null) for an explicit but invalid port override", () => {
    // An out-of-range override must not silently fall through to the sandbox
    // binding or the default port — it is a caller error, so skip.
    expect(resolveStopGatewayPort({ port: 70000 }, () => ({ gatewayPort: 8090 }))).toBe(null);
    expect(resolveStopGatewayPort({ port: 0, sandboxName: "alpha" }, () => null)).toBe(null);
  });

  it("derives the port from the sandbox's persisted gateway binding", () => {
    const port = resolveStopGatewayPort({ sandboxName: "alpha" }, () => ({ gatewayPort: 8090 }));
    expect(port).toBe(8090);
  });

  it("fails closed (null) when a named sandbox has no registry entry", () => {
    // A named stop whose registry entry is absent must not fall back to
    // default-port cleanup: an unknown name could otherwise tear down a
    // different sandbox's / worktree's default gateway.
    expect(resolveStopGatewayPort({ sandboxName: "alpha" }, () => null)).toBe(null);
  });

  it("falls back to the default gateway port for a call with no sandbox name", () => {
    // A direct "release the default gateway" request (no sandbox identity).
    expect(resolveStopGatewayPort({}, () => null)).toBe(DEFAULT_GATEWAY_PORT);
  });

  it("falls back to the default gateway port for a legacy entry with no gateway fields", () => {
    // A real legacy entry (e.g. `{}`) maps to the base `nemoclaw` name and
    // resolves to the default port, keeping single-sandbox deployments working.
    expect(resolveStopGatewayPort({ sandboxName: "alpha" }, () => ({}))).toBe(DEFAULT_GATEWAY_PORT);
  });

  it("fails closed (null) when the persisted gateway binding is invalid", () => {
    // An out-of-range gatewayPort is a corrupt/tampered binding;
    // resolveSandboxGatewayName throws and we must not coerce to the default.
    expect(resolveStopGatewayPort({ sandboxName: "alpha" }, () => ({ gatewayPort: 70000 }))).toBe(
      null,
    );
  });

  it("fails closed (null) when the registry lookup itself throws", () => {
    // A corrupt registry that throws on read must not be treated as a clean
    // "no entry" and fall back to the default port.
    const port = resolveStopGatewayPort({ sandboxName: "alpha" }, () => {
      throw new Error("corrupt registry");
    });
    expect(port).toBe(null);
  });
});
