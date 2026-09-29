// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOOL_DISCLOSURE,
  defaultToolDisclosureForRoute,
  isLocalToolDisclosureRoute,
  readToolDisclosureEnv,
  resolveGeneratedToolDisclosure,
  resolveSandboxToolDisclosure,
  resolveSessionToolDisclosureForRoute,
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

  it("defaults local routes to direct and remote routes to progressive", () => {
    expect(isLocalToolDisclosureRoute("ollama-local")).toBe(true);
    expect(isLocalToolDisclosureRoute("vllm-local")).toBe(true);
    expect(isLocalToolDisclosureRoute(" llama-cpp-local ")).toBe(false);
    expect(isLocalToolDisclosureRoute("nvidia-prod")).toBe(false);
    expect(defaultToolDisclosureForRoute("ollama-local")).toBe("direct");
    expect(defaultToolDisclosureForRoute("vllm-local")).toBe("direct");
    expect(defaultToolDisclosureForRoute("llama-cpp-local")).toBe("progressive");
    expect(defaultToolDisclosureForRoute("nvidia-prod")).toBe("progressive");
    expect(defaultToolDisclosureForRoute(undefined)).toBe("progressive");
  });

  it("does not let a fresh progressive session override the local-route default", () => {
    expect(
      resolveSandboxToolDisclosure({
        requested: null,
        recorded: undefined,
        session: "progressive",
        sandboxExists: false,
        recreate: false,
        provider: "ollama-local",
      }),
    ).toBe("direct");
    expect(
      resolveSandboxToolDisclosure({
        requested: null,
        recorded: undefined,
        session: "progressive",
        sandboxExists: false,
        recreate: false,
        provider: "nvidia-prod",
      }),
    ).toBe("progressive");
    expect(resolveSessionToolDisclosureForRoute("progressive", "ollama-local")).toBe("direct");
    expect(resolveSessionToolDisclosureForRoute("direct", "ollama-local")).toBe("direct");
    expect(resolveSessionToolDisclosureForRoute("progressive", "nvidia-prod")).toBe("progressive");
  });

  it("keeps generated local-route config on direct when env still says progressive", () => {
    expect(resolveGeneratedToolDisclosure("progressive", "ollama-local")).toBe("direct");
    expect(resolveGeneratedToolDisclosure("progressive", "inference", "vllm-local")).toBe("direct");
    expect(resolveGeneratedToolDisclosure("progressive", "nvidia-prod")).toBe("progressive");
    expect(resolveGeneratedToolDisclosure("progressive", "llama-cpp-local")).toBe("progressive");
    expect(resolveGeneratedToolDisclosure("direct", "nvidia-prod")).toBe("direct");
  });
});
