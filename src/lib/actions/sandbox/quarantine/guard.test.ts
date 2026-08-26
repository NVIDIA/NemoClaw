// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxEntry, SandboxQuarantineFence } from "../../../state/registry/types";
import { assertSandboxActivationAllowed, assertSandboxCommandAllowedByQuarantine } from "./guard";

const fence: SandboxQuarantineFence = {
  schemaVersion: 1,
  fenceId: "00000000-0000-4000-8000-000000000001",
  requestIdentity: "a".repeat(64),
  reasonDigest: "e".repeat(64),
  createdAt: "2026-08-25T04:00:00.000Z",
  updatedAt: "2026-08-25T04:00:00.000Z",
  phase: "quarantined",
  target: {
    sandboxName: "alpha",
    providerId: "docker",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "registry-generation-1",
    liveIdentityFingerprint: "b".repeat(64),
    providerHandle: "c".repeat(64),
    providerLifecycleGeneration: "provider-generation-1",
    runtime: { kind: "docker-container", handle: "d".repeat(64) },
  },
  attempts: [],
};
const entry: SandboxEntry = { name: "alpha", quarantine: fence };
const getSandbox = () => entry;

describe("sandbox quarantine activation guard", () => {
  it("blocks direct activation with exact release guidance (#10140)", () => {
    expect(() => assertSandboxActivationAllowed("alpha", "start", getSandbox)).toThrow(
      /quarantined.*quarantine release --fence-id/u,
    );
  });

  it.each(["sandbox:status", "sandbox:logs", "sandbox:snapshot:list", "sandbox:destroy"])(
    "allows evidence or destruction command %s (#10140)",
    (commandId) => {
      expect(() =>
        assertSandboxCommandAllowedByQuarantine(commandId, "alpha", [], getSandbox),
      ).not.toThrow();
    },
  );

  it.each([
    "launch",
    "sandbox:start",
    "sandbox:connect",
    "sandbox:rebuild",
    "sandbox:snapshot:restore",
    "sandbox:channels:add",
    "sandbox:policy:set",
    "sandbox:shields:down",
  ])("blocks activation or mutation command %s (#10140)", (commandId) => {
    expect(() =>
      assertSandboxCommandAllowedByQuarantine(commandId, "alpha", [], getSandbox),
    ).toThrow(/quarantined/u);
  });

  it("blocks doctor repair while allowing read-only doctor (#10140)", () => {
    expect(() =>
      assertSandboxCommandAllowedByQuarantine("sandbox:doctor", "alpha", [], getSandbox),
    ).not.toThrow();
    expect(() =>
      assertSandboxCommandAllowedByQuarantine("sandbox:doctor", "alpha", ["--fix"], getSandbox),
    ).toThrow(/quarantined/u);
  });
});
