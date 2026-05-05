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

  it("routes sandbox doctor through oclif", () => {
    expect(resolveSandboxOclifDispatch("alpha", "doctor", ["--json"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:doctor",
      args: ["alpha", "--json"],
    });
  });

  it("keeps sandbox doctor help public", () => {
    expect(resolveSandboxOclifDispatch("alpha", "doctor", ["--help"])).toEqual({
      kind: "help",
      usage: "doctor [--json]",
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

  it("routes sandbox config set through oclif with security flags intact", () => {
    expect(
      resolveSandboxOclifDispatch("alpha", "config", [
        "set",
        "--key",
        "inference.endpoints",
        "--value",
        "HTTP://93.184.216.34/v1",
        "--config-accept-new-path",
      ]),
    ).toEqual({
      kind: "oclif",
      commandId: "sandbox:config:set",
      args: [
        "alpha",
        "--key",
        "inference.endpoints",
        "--value",
        "HTTP://93.184.216.34/v1",
        "--config-accept-new-path",
      ],
    });
  });

  it("routes policy-add missing-value errors through the strict oclif adapter", () => {
    expect(resolveSandboxOclifDispatch("alpha", "policy-add", ["--from-file"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:policy-add",
      args: ["alpha", "--from-file"],
    });
  });

  it("routes skill help and unknown subcommands through oclif", () => {
    expect(resolveSandboxOclifDispatch("alpha", "skill", ["--help"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:skill",
      args: ["alpha", "--help"],
    });
    expect(resolveSandboxOclifDispatch("alpha", "skill", ["bogus"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:skill",
      args: ["alpha", "bogus"],
    });
  });

  it("routes snapshot unknown subcommands through oclif", () => {
    expect(resolveSandboxOclifDispatch("alpha", "snapshot", ["bogus"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:snapshot",
      args: ["alpha", "bogus"],
    });
  });
});
