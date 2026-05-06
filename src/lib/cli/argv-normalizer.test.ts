// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { normalizeArgv, suggestCommand } from "./argv-normalizer";

const globalCommands = new Set(["list", "status", "onboard", "--version"]);
const isConnectFlag = (arg: string | undefined) => arg === "--probe-only" || arg === "--help";

describe("normalizeArgv", () => {
  it("normalizes root help aliases", () => {
    expect(normalizeArgv([], { globalCommands, isSandboxConnectFlag: isConnectFlag })).toEqual({
      kind: "rootHelp",
    });
    expect(normalizeArgv(["--help"], { globalCommands, isSandboxConnectFlag: isConnectFlag })).toEqual({
      kind: "rootHelp",
    });
  });

  it("normalizes internal dump commands", () => {
    expect(
      normalizeArgv(["--dump-commands"], { globalCommands, isSandboxConnectFlag: isConnectFlag }),
    ).toEqual({ kind: "dumpCommands" });
  });

  it("normalizes global commands", () => {
    expect(
      normalizeArgv(["list", "--json"], { globalCommands, isSandboxConnectFlag: isConnectFlag }),
    ).toEqual({ kind: "global", command: "list", args: ["--json"] });
  });

  it("normalizes explicit sandbox actions", () => {
    expect(
      normalizeArgv(["alpha", "status"], { globalCommands, isSandboxConnectFlag: isConnectFlag }),
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
      normalizeArgv(["alpha"], { globalCommands, isSandboxConnectFlag: isConnectFlag }),
    ).toEqual({
      kind: "sandbox",
      sandboxName: "alpha",
      action: "connect",
      actionArgs: [],
      connectHelpRequested: false,
    });
    expect(
      normalizeArgv(["alpha", "--probe-only"], {
        globalCommands,
        isSandboxConnectFlag: isConnectFlag,
      }),
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
      normalizeArgv(["alpha", "connect", "--help"], {
        globalCommands,
        isSandboxConnectFlag: isConnectFlag,
      }),
    ).toMatchObject({
      kind: "sandbox",
      sandboxName: "alpha",
      action: "connect",
      actionArgs: ["--help"],
      connectHelpRequested: true,
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
