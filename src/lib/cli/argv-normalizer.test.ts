// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { normalizeArgv, suggestCommand } from "./argv-normalizer";

const globalCommands = new Set(["list", "status", "onboard", "doctor", "--version"]);
const isConnectFlag = (arg: string | undefined) => arg === "--probe-only" || arg === "--help";
const normalizerOptions = {
  globalCommands,
  isRegisteredSandbox: () => false,
  isSandboxAction: (arg: string | undefined) => ["status", "policy-add"].includes(arg ?? ""),
  isSandboxConnectFlag: isConnectFlag,
};

describe("normalizeArgv", () => {
  it("normalizes root help aliases", () => {
    expect(normalizeArgv([], normalizerOptions)).toEqual({
      kind: "rootHelp",
    });
    expect(normalizeArgv(["--help"], normalizerOptions)).toEqual({
      kind: "rootHelp",
    });
  });

  it("normalizes internal dump commands", () => {
    expect(
      normalizeArgv(["--dump-commands"], normalizerOptions),
    ).toEqual({ kind: "dumpCommands" });
    expect(
      normalizeArgv(["--dump-command-flags"], normalizerOptions),
    ).toEqual({ kind: "dumpCommandFlags" });
  });

  it("normalizes global commands", () => {
    expect(
      normalizeArgv(["list", "--json"], normalizerOptions),
    ).toEqual({ kind: "global", command: "list", args: ["--json"] });
  });

  it("normalizes explicit sandbox actions", () => {
    expect(
      normalizeArgv(["alpha", "status"], normalizerOptions),
    ).toEqual({
      kind: "sandbox",
      sandboxName: "alpha",
      action: "status",
      actionArgs: [],
      connectHelpRequested: false,
    });
  });

  it("normalizes bare and implicit connect invocations", () => {
    expect(
      normalizeArgv(["alpha"], normalizerOptions),
    ).toEqual({
      kind: "sandbox",
      sandboxName: "alpha",
      action: "connect",
      actionArgs: [],
      connectHelpRequested: false,
    });
    expect(
      normalizeArgv(["alpha", "--probe-only"], normalizerOptions),
    ).toEqual({
      kind: "sandbox",
      sandboxName: "alpha",
      action: "connect",
      actionArgs: ["--probe-only"],
      connectHelpRequested: false,
    });
  });

  it("tracks connect help requests", () => {
    expect(
      normalizeArgv(["alpha", "connect", "--help"], normalizerOptions),
    ).toMatchObject({
      kind: "sandbox",
      sandboxName: "alpha",
      action: "connect",
      actionArgs: ["--help"],
      connectHelpRequested: true,
    });
    expect(
      normalizeArgv(["alpha", "--help"], normalizerOptions),
    ).toMatchObject({
      kind: "sandbox",
      sandboxName: "alpha",
      action: "connect",
      actionArgs: ["--help"],
      connectHelpRequested: true,
    });
  });

  it.each([
    { argv: ["doctor"], kind: "global", action: undefined },
    { argv: ["doctor", "--help"], kind: "global", action: undefined },
    { argv: ["doctor", "--json"], kind: "global", action: undefined },
    { argv: ["doctor", "--text"], kind: "global", action: undefined },
    { argv: ["doctor", "--json"], kind: "global", action: undefined, registered: true },
    { argv: ["doctor", "--text"], kind: "global", action: undefined, registered: true },
    { argv: ["doctor", "--probe-only"], kind: "sandbox", action: "connect" },
    { argv: ["doctor", "status"], kind: "sandbox", action: "status" },
    { argv: ["doctor", "policy-add"], kind: "sandbox", action: "policy-add" },
  ])("classifies $argv from one doctor scope rule", ({ argv, kind, action, registered }) => {
    expect(
      normalizeArgv(argv, {
        ...normalizerOptions,
        isRegisteredSandbox: () => registered === true,
      }),
    ).toMatchObject({
      kind,
      ...(action ? { sandboxName: "doctor", action } : {}),
    });
  });

  it.each([
    { label: "bare", firstArg: undefined, connectHelpRequested: false },
    { label: "help", firstArg: "--help", connectHelpRequested: true },
    { label: "probe-only", firstArg: "--probe-only", connectHelpRequested: false },
  ])("preserves $label connect for a registered sandbox named doctor (#10212)", (testCase) => {
    const argv = testCase.firstArg ? ["doctor", testCase.firstArg] : ["doctor"];
    expect(
      normalizeArgv(argv, {
        ...normalizerOptions,
        isRegisteredSandbox: (name) => name === "doctor",
      }),
    ).toEqual({
      kind: "sandbox",
      sandboxName: "doctor",
      action: "connect",
      actionArgs: testCase.firstArg ? [testCase.firstArg] : [],
      connectHelpRequested: testCase.connectHelpRequested,
    });
  });
});

describe("suggestCommand", () => {
  it("suggests close global command typos", () => {
    expect(suggestCommand("liost", globalCommands)).toBe("list");
  });

  it("ignores flag-like commands", () => {
    expect(suggestCommand("version", globalCommands)).toBeNull();
  });
});
