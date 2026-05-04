// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveSandboxOclifDispatch } from "./legacy-oclif-dispatch";

describe("resolveSandboxOclifDispatch", () => {
  it("routes sandbox status through oclif", () => {
    expect(resolveSandboxOclifDispatch("alpha", "status", [])).toEqual({
      kind: "oclif",
      commandId: "sandbox:status",
      args: ["alpha"],
    });
  });

  it("keeps sandbox status help public", () => {
    expect(resolveSandboxOclifDispatch("alpha", "status", ["--help"])).toEqual({
      kind: "help",
      usage: "status",
    });
  });

  it("keeps sandbox logs help public with supported filters", () => {
    expect(resolveSandboxOclifDispatch("alpha", "logs", ["--help"])).toEqual({
      kind: "help",
      usage: "logs [--follow] [--tail <lines>|-n <lines>] [--since <duration>]",
    });
  });

  it("routes sandbox recover through oclif", () => {
    expect(resolveSandboxOclifDispatch("alpha", "recover", [])).toEqual({
      kind: "oclif",
      commandId: "sandbox:recover",
      args: ["alpha"],
    });
  });

  it("returns help for sandbox recover", () => {
    expect(resolveSandboxOclifDispatch("alpha", "recover", ["--help"])).toEqual({
      kind: "help",
      usage: "recover",
    });
  });
});
