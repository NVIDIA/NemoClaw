// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveGlobalOclifDispatch, resolveLegacySandboxDispatch } from "./oclif-dispatch";

describe("resolveGlobalOclifDispatch", () => {
  it("routes simple and nested global commands through oclif", () => {
    expect(resolveGlobalOclifDispatch("list", ["--json"])).toEqual({
      kind: "oclif",
      commandId: "list",
      args: ["--json"],
    });
    expect(resolveGlobalOclifDispatch("update", ["--check"])).toEqual({
      kind: "oclif",
      commandId: "update",
      args: ["--check"],
    });
    expect(resolveGlobalOclifDispatch("tunnel", ["start"])).toEqual({
      kind: "oclif",
      commandId: "tunnel:start",
      args: [],
    });
    expect(resolveGlobalOclifDispatch("inference", ["set", "--provider", "nvidia-prod"])).toEqual({
      kind: "oclif",
      commandId: "inference:set",
      args: ["--provider", "nvidia-prod"],
    });
    expect(resolveGlobalOclifDispatch("inference", ["get", "--json"])).toEqual({
      kind: "oclif",
      commandId: "inference:get",
      args: ["--json"],
    });
    expect(resolveGlobalOclifDispatch("--version", [])).toEqual({
      kind: "oclif",
      commandId: "root:version",
      args: [],
    });
    expect(resolveGlobalOclifDispatch("version", [])).toEqual({
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
    expect(resolveGlobalOclifDispatch("inference", ["bogus"])).toEqual({
      kind: "usageError",
      lines: [
        "inference get [--json]",
        "inference set --provider <provider> --model <model> [--sandbox <name>] [--no-verify]",
      ],
    });
    expect(resolveGlobalOclifDispatch("credentials", ["bogus"])).toEqual({
      kind: "unknownSubcommand",
      command: "credentials",
      subcommand: "bogus",
    });
    expect(resolveGlobalOclifDispatch("bogus", [])).toEqual({ kind: "usageError", lines: [] });
  });
});

describe("resolveLegacySandboxDispatch", () => {
  it("rewrites simple legacy sandbox actions to oclif command dispatches", () => {
    expect(resolveLegacySandboxDispatch("alpha", "status", [])).toEqual({
      kind: "oclif",
      commandId: "sandbox:status",
      args: ["alpha"],
    });
    expect(resolveLegacySandboxDispatch("alpha", "doctor", ["--json"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:doctor",
      args: ["alpha", "--json"],
    });
  });

  it("rewrites legacy hyphenated actions to oclif-native command ids", () => {
    expect(resolveLegacySandboxDispatch("alpha", "policy-add", ["--from-file"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:policy:add",
      args: ["alpha", "--from-file"],
    });
    expect(resolveLegacySandboxDispatch("alpha", "gateway-token", ["--quiet"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:gateway:token",
      args: ["alpha", "--quiet"],
    });
  });

  it("keeps legacy public help usage for sandbox-scoped commands", () => {
    expect(resolveLegacySandboxDispatch("alpha", "status", ["--help"])).toEqual({
      kind: "help",
      commandId: "sandbox:status",
      publicUsage: "<name> status",
    });
    expect(resolveLegacySandboxDispatch("alpha", "logs", ["--help"])).toEqual({
      kind: "help",
      commandId: "sandbox:logs",
      publicUsage: "<name> logs [--follow] [--tail <lines>|-n <lines>] [--since <duration>]",
    });
  });

  it("rewrites sandbox recover through metadata-derived dispatch", () => {
    expect(resolveLegacySandboxDispatch("alpha", "recover", [])).toEqual({
      kind: "oclif",
      commandId: "sandbox:recover",
      args: ["alpha"],
    });
    expect(resolveLegacySandboxDispatch("alpha", "recover", ["--help"])).toEqual({
      kind: "help",
      commandId: "sandbox:recover",
      publicUsage: "<name> recover",
    });
  });

  it("rewrites config set through metadata-derived dispatch", () => {
    expect(
      resolveLegacySandboxDispatch("alpha", "config", [
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

  it("rewrites nested sandbox subcommands and defaults", () => {
    expect(resolveLegacySandboxDispatch("alpha", "channels", [])).toEqual({
      kind: "oclif",
      commandId: "sandbox:channels:list",
      args: ["alpha"],
    });
    expect(resolveLegacySandboxDispatch("alpha", "channels", ["add", "slack"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:channels:add",
      args: ["alpha", "slack"],
    });
    expect(resolveLegacySandboxDispatch("alpha", "snapshot", ["restore", "latest"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:snapshot:restore",
      args: ["alpha", "latest"],
    });
  });

  it("keeps share parent help public", () => {
    expect(resolveLegacySandboxDispatch("alpha", "share", ["--help"])).toEqual({
      kind: "help",
      commandId: "sandbox:share",
      publicUsage: "<name> share <mount|unmount|status>",
    });
  });

  it("falls back to parent commands that intentionally own unknown subcommands and custom help", () => {
    expect(resolveLegacySandboxDispatch("alpha", "skill", ["install", "--help"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:skill",
      args: ["alpha", "install", "--help"],
    });
    expect(resolveLegacySandboxDispatch("alpha", "skill", ["bogus"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:skill",
      args: ["alpha", "bogus"],
    });
    expect(resolveLegacySandboxDispatch("alpha", "snapshot", ["bogus"])).toEqual({
      kind: "oclif",
      commandId: "sandbox:snapshot",
      args: ["alpha", "bogus"],
    });
  });

  it("preserves legacy usage errors for config and shields groups", () => {
    expect(resolveLegacySandboxDispatch("alpha", "config", ["bogus"])).toEqual({
      kind: "usageError",
      lines: ["config get [--key dotpath] [--format json|yaml]"],
    });
    expect(resolveLegacySandboxDispatch("alpha", "shields", ["bogus"])).toEqual({
      kind: "usageError",
      lines: [
        "shields <down|up|status>",
        "  down  [--timeout 5m] [--reason 'text'] [--policy permissive]",
        "  up    Restore policy from snapshot",
        "  status  Show current shields state",
      ],
    });
  });

  it("reports channel subcommand and action errors", () => {
    expect(resolveLegacySandboxDispatch("alpha", "channels", ["bogus"])).toEqual({
      kind: "unknownSubcommand",
      command: "channels",
      subcommand: "bogus",
    });
    expect(resolveLegacySandboxDispatch("alpha", "bogus", [])).toEqual({
      kind: "unknownAction",
      action: "bogus",
    });
  });
});
