// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveGlobalOclifDispatch, resolveSandboxOclifDispatch } from "./oclif-dispatch";

describe("resolveGlobalOclifDispatch", () => {
  it("routes simple and nested global commands through oclif", () => {
    expect(resolveGlobalOclifDispatch("list", ["--json"])).toEqual({
      kind: "oclif",
      commandId: "list",
      args: ["--json"],
    });
    expect(resolveGlobalOclifDispatch("tunnel", ["start"])).toEqual({
      kind: "oclif",
      commandId: "tunnel:start",
      args: [],
    });
    expect(resolveGlobalOclifDispatch("--version", [])).toEqual({
      kind: "oclif",
      commandId: "root:version",
      args: [],
    });
  });

  it("returns usage and unknown-subcommand dispatches for unsupported global forms", () => {
    expect(resolveGlobalOclifDispatch("tunnel", ["restart"])).toEqual({
      kind: "usageError",
      lines: ["tunnel <start|stop>"],
    });
    expect(resolveGlobalOclifDispatch("credentials", ["bogus"])).toEqual({
      kind: "unknownSubcommand",
      command: "credentials",
      subcommand: "bogus",
    });
    expect(resolveGlobalOclifDispatch("bogus", [])).toEqual({ kind: "usageError", lines: [] });
  });
});

describe("resolveSandboxOclifDispatch", () => {
  it("routes sandbox status through oclif", () => {
    expect(resolveSandboxOclifDispatch("alpha", "status", [])).toEqual({
      kind: "oclif",
      commandId: "sandbox:status",
      args: ["alpha"],
    });
  });

  it("keeps sandbox status help public", () => {
    expect(resolveSandboxOclifDispatch("alpha", "status", ["--help"])).toMatchObject({
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
    expect(resolveSandboxOclifDispatch("alpha", "doctor", ["--help"])).toMatchObject({
      kind: "help",
      usage: "doctor [--json]",
    });
  });

  it("keeps sandbox logs help public with supported filters", () => {
    expect(resolveSandboxOclifDispatch("alpha", "logs", ["--help"])).toMatchObject({
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
    expect(resolveSandboxOclifDispatch("alpha", "recover", ["--help"])).toMatchObject({
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
      commandId: "sandbox:policy:add",
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

  it("routes nested sandbox defaults, help, and usage errors", () => {
    expect(resolveSandboxOclifDispatch("alpha", "channels", [])).toEqual({
      kind: "oclif",
      commandId: "sandbox:channels:list",
      args: ["alpha"],
    });
    expect(resolveSandboxOclifDispatch("alpha", "channels", ["add", "slack"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:channels:add",
      args: ["alpha", "slack"],
    });
    expect(resolveSandboxOclifDispatch("alpha", "config", ["bogus"])).toEqual({
      kind: "usageError",
      lines: [
        "config <get|set>",
        "get [--key dotpath] [--format json|yaml]",
        "set --key <dotpath> --value <value> [--restart] [--config-accept-new-path]",
      ],
    });
    expect(resolveSandboxOclifDispatch("alpha", "shields", ["bogus"])).toEqual({
      kind: "usageError",
      lines: [
        "shields <down|up|status>",
        "  down  [--timeout 5m] [--reason 'text'] [--policy permissive]",
        "  up    Restore policy from snapshot",
        "  status  Show current shields state",
      ],
    });
  });

  it("routes snapshot unknown subcommands and unknown actions", () => {
    expect(resolveSandboxOclifDispatch("alpha", "snapshot", ["bogus"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:snapshot",
      args: ["alpha", "bogus"],
    });
    expect(resolveSandboxOclifDispatch("alpha", "bogus", [])).toEqual({
      kind: "unknownAction",
      action: "bogus",
    });
  });
});
