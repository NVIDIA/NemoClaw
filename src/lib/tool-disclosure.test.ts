// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOOL_DISCLOSURE,
  readToolDisclosureEnv,
  resolveSandboxToolDisclosure,
  resolveToolDisclosureRequest,
  toolDisclosureOrDefault,
} from "./tool-disclosure";

describe("tool disclosure", () => {
  it("defaults missing legacy state to progressive", () => {
    expect(DEFAULT_TOOL_DISCLOSURE).toBe("progressive");
    expect(toolDisclosureOrDefault(undefined)).toBe("progressive");
  });

  it("resolves CLI before env and validates the closed enum", () => {
    expect(
      resolveToolDisclosureRequest("direct", { NEMOCLAW_TOOL_DISCLOSURE: "progressive" }),
    ).toBe("direct");
    expect(resolveToolDisclosureRequest(undefined, { NEMOCLAW_TOOL_DISCLOSURE: " DIRECT " })).toBe(
      "direct",
    );
    expect(resolveToolDisclosureRequest(undefined, {})).toBeNull();
    expect(() =>
      resolveToolDisclosureRequest(undefined, { NEMOCLAW_TOOL_DISCLOSURE: "sometimes" }),
    ).toThrow(/progressive, direct/);
  });

  it("shares the build-time environment parser across agent generators", () => {
    expect(readToolDisclosureEnv({})).toBe("progressive");
    expect(readToolDisclosureEnv({ NEMOCLAW_TOOL_DISCLOSURE: " DIRECT " })).toBe("direct");
    expect(() => readToolDisclosureEnv({ NEMOCLAW_TOOL_DISCLOSURE: "sometimes" })).toThrow(
      "NEMOCLAW_TOOL_DISCLOSURE must be progressive or direct",
    );
  });

  it("preserves recorded behavior on reuse and lets recreation override it", () => {
    expect(
      resolveSandboxToolDisclosure({
        requested: null,
        recorded: "direct",
        session: "progressive",
        sandboxExists: true,
        recreate: false,
      }),
    ).toBe("direct");
    expect(
      resolveSandboxToolDisclosure({
        requested: "progressive",
        recorded: "direct",
        session: "direct",
        sandboxExists: true,
        recreate: true,
      }),
    ).toBe("progressive");
    expect(() =>
      resolveSandboxToolDisclosure({
        requested: "direct",
        recorded: "progressive",
        session: "progressive",
        sandboxExists: true,
        recreate: false,
      }),
    ).toThrow(/recreate the sandbox/);
  });

  it("recovers interrupted creation from session state", () => {
    expect(
      resolveSandboxToolDisclosure({
        requested: null,
        recorded: undefined,
        session: "direct",
        sandboxExists: false,
        recreate: true,
      }),
    ).toBe("direct");
  });

  it("preserves an explicit mode while migrating missing live sandbox state", () => {
    expect(
      resolveSandboxToolDisclosure({
        requested: "direct",
        recorded: undefined,
        session: "progressive",
        sandboxExists: true,
        recreate: false,
      }),
    ).toBe("direct");
  });
});
