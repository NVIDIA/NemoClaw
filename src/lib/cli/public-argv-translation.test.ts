// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type PublicTranslationResult,
  translatePublicGlobalArgv,
  translatePublicSandboxArgv,
} from "./public-argv-translation";
import { SANDBOX_ROUTE_OVERRIDES, sandboxRouteTokens } from "./public-route-metadata";

function expectNative(
  result: PublicTranslationResult,
  commandId: string,
  args: string[],
  argv = [...commandId.split(":"), ...args],
): void {
  expect(result).toEqual({
    kind: "nativeArgv",
    commandId,
    args,
    argv,
  });
}

describe("public route/display separation", () => {
  afterEach(() => {
    vi.doUnmock("./oclif-metadata");
    vi.resetModules();
  });

  it("keeps dispatch token selection independent from public display usage text", async () => {
    vi.resetModules();
    vi.doMock("./oclif-metadata", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./oclif-metadata")>();
      const realMetadata = actual.getRegisteredOclifCommandsMetadata();
      const withUsage = (commandId: string, usage: string) => {
        const metadata = realMetadata[commandId];
        const displayEntry = metadata.publicDisplay?.[0];
        return {
          ...metadata,
          publicDisplay: displayEntry ? [{ ...displayEntry, usage }] : [],
        };
      };
      const metadata: ReturnType<typeof actual.getRegisteredOclifCommandsMetadata> = {
        ...realMetadata,
        list: withUsage("list", "nemoclaw renamed-list"),
        "sandbox:status": withUsage("sandbox:status", "nemoclaw <name> renamed-status"),
      };
      return {
        ...actual,
        getRegisteredOclifCommandMetadata: (commandId: string) => metadata[commandId] ?? null,
        getRegisteredOclifCommandSummary: (commandId: string) =>
          metadata[commandId]?.summary ?? null,
        getRegisteredOclifCommandsMetadata: () => metadata,
      };
    });

    const dispatch = await import("./public-argv-translation");
    const registry = await import("./command-registry");

    expectNative(dispatch.translatePublicGlobalArgv("list", []), "list", []);
    expect(dispatch.translatePublicGlobalArgv("renamed-list", [])).toEqual({
      kind: "publicUsageError",
      lines: [],
    });
    expectNative(dispatch.translatePublicSandboxArgv("alpha", "status", []), "sandbox:status", [
      "alpha",
    ]);
    expect(dispatch.translatePublicSandboxArgv("alpha", "renamed-status", [])).toEqual({
      kind: "unknownPublicAction",
      action: "renamed-status",
    });

    expect(registry.globalCommandTokens()).toContain("list");
    expect(registry.globalCommandTokens()).not.toContain("renamed-list");
    expect(registry.sandboxActionTokens()).toContain("status");
    expect(registry.sandboxActionTokens()).not.toContain("renamed-status");
  });

  it("keeps explicit compatibility route overrides limited to non-derivable public spellings", () => {
    expect(Object.keys(SANDBOX_ROUTE_OVERRIDES).sort()).toEqual([
      "sandbox:gateway:token",
      "sandbox:hosts:add",
      "sandbox:hosts:list",
      "sandbox:hosts:remove",
      "sandbox:policy:add",
      "sandbox:policy:explain",
      "sandbox:policy:list",
      "sandbox:policy:remove",
    ]);
    expect(sandboxRouteTokens("sandbox:gateway:token")).toEqual(["gateway-token"]);
    expect(sandboxRouteTokens("sandbox:config:rotate-token")).toEqual(["config", "rotate-token"]);
  });
});

describe("translatePublicGlobalArgv", () => {
  it("translates simple and nested global commands to native oclif argv", () => {
    expectNative(translatePublicGlobalArgv("list", ["--json"]), "list", ["--json"]);
    expectNative(translatePublicGlobalArgv("update", ["--check"]), "update", ["--check"]);
    expectNative(translatePublicGlobalArgv("tunnel", ["start"]), "tunnel:start", []);
    expectNative(
      translatePublicGlobalArgv("inference", ["set", "--provider", "nvidia-prod"]),
      "inference:set",
      ["--provider", "nvidia-prod"],
    );
    expectNative(translatePublicGlobalArgv("inference", ["get", "--json"]), "inference:get", [
      "--json",
    ]);
    expectNative(translatePublicGlobalArgv("--version", []), "root:version", []);
    expectNative(translatePublicGlobalArgv("version", []), "root:version", []);
  });

  it("translates global parent help and errors to native oclif argv", () => {
    expectNative(
      translatePublicGlobalArgv("credentials", []),
      "credentials",
      ["--help"],
      ["credentials", "--help"],
    );
    expectNative(
      translatePublicGlobalArgv("tunnel", ["help"]),
      "tunnel",
      ["--help"],
      ["tunnel", "--help"],
    );
    expectNative(
      translatePublicGlobalArgv("inference", ["bogus"]),
      "inference:bogus",
      [],
      ["inference", "bogus"],
    );
    expect(translatePublicGlobalArgv("bogus", [])).toEqual({ kind: "publicUsageError", lines: [] });
  });
});

describe("translatePublicSandboxArgv", () => {
  it("translates simple legacy sandbox actions to native oclif argv", () => {
    expectNative(translatePublicSandboxArgv("alpha", "status", []), "sandbox:status", ["alpha"]);
    expectNative(translatePublicSandboxArgv("alpha", "doctor", ["--json"]), "sandbox:doctor", [
      "alpha",
      "--json",
    ]);
    expectNative(
      translatePublicSandboxArgv("alpha", "dashboard-url", ["--quiet"]),
      "sandbox:dashboard-url",
      ["alpha", "--quiet"],
    );
  });

  it("translates legacy hyphenated actions to native oclif argv", () => {
    expectNative(
      translatePublicSandboxArgv("alpha", "policy-add", ["--from-file"]),
      "sandbox:policy:add",
      ["alpha", "--from-file"],
    );
    expectNative(
      translatePublicSandboxArgv("alpha", "gateway-token", ["--quiet"]),
      "sandbox:gateway:token",
      ["alpha", "--quiet"],
    );
  });

  it("translates sandbox help to native oclif argv", () => {
    expectNative(translatePublicSandboxArgv("alpha", "status", ["--help"]), "sandbox:status", [
      "alpha",
      "--help",
    ]);
    expectNative(
      translatePublicSandboxArgv("alpha", "config", ["--help"]),
      "sandbox:config",
      ["--help"],
      ["sandbox", "config", "--help"],
    );
    expectNative(
      translatePublicSandboxArgv("alpha", "share", ["--help"]),
      "sandbox:share",
      ["--help"],
      ["sandbox", "share", "--help"],
    );
  });

  it("translates config actions through command-id-derived dispatch", () => {
    expectNative(
      translatePublicSandboxArgv("alpha", "config", [
        "set",
        "--key",
        "inference.endpoints",
        "--value",
        "HTTP://93.184.216.34/v1",
        "--config-accept-new-path",
      ]),
      "sandbox:config:set",
      [
        "alpha",
        "--key",
        "inference.endpoints",
        "--value",
        "HTTP://93.184.216.34/v1",
        "--config-accept-new-path",
      ],
    );
    expectNative(
      translatePublicSandboxArgv("alpha", "config", ["rotate-token", "--from-env", "TOKEN"]),
      "sandbox:config:rotate-token",
      ["alpha", "--from-env", "TOKEN"],
    );
  });

  it("translates nested sandbox subcommands and defaults", () => {
    expectNative(translatePublicSandboxArgv("alpha", "channels", []), "sandbox:channels:list", [
      "alpha",
    ]);
    expectNative(
      translatePublicSandboxArgv("alpha", "channels", ["add", "slack"]),
      "sandbox:channels:add",
      ["alpha", "slack"],
    );
    expectNative(
      translatePublicSandboxArgv("alpha", "snapshot", ["restore", "latest"]),
      "sandbox:snapshot:restore",
      ["alpha", "latest"],
    );
    expectNative(
      translatePublicSandboxArgv("alpha", "skill", ["remove", "my-skill"]),
      "sandbox:skill:remove",
      ["alpha", "my-skill"],
    );
  });

  it("translates unknown parent subcommands to native oclif argv for oclif-owned errors", () => {
    expectNative(
      translatePublicSandboxArgv("alpha", "channels", ["bogus"]),
      "sandbox:channels:bogus",
      ["alpha"],
      ["sandbox", "channels", "bogus", "alpha"],
    );
    expectNative(
      translatePublicSandboxArgv("alpha", "config", ["bogus"]),
      "sandbox:config:bogus",
      ["alpha"],
      ["sandbox", "config", "bogus", "alpha"],
    );
  });

  it("falls back to parent commands that intentionally own unknown subcommands", () => {
    expectNative(
      translatePublicSandboxArgv("alpha", "skill", ["bogus"]),
      "sandbox:skill:bogus",
      ["alpha"],
      ["sandbox", "skill", "bogus", "alpha"],
    );
    expectNative(
      translatePublicSandboxArgv("alpha", "snapshot", ["bogus"]),
      "sandbox:snapshot:bogus",
      ["alpha"],
      ["sandbox", "snapshot", "bogus", "alpha"],
    );
  });

  it("reports unknown public sandbox actions before oclif execution", () => {
    expect(translatePublicSandboxArgv("alpha", "bogus", [])).toEqual({
      kind: "unknownPublicAction",
      action: "bogus",
    });
  });

  it("routes the sessions passthrough parent for empty or flag-only args", () => {
    // sandbox:sessions is a non-strict passthrough; empty and flag-leading
    // actionArgs both belong to the parent, not to a fabricated
    // `sandbox:sessions:<flag>` dispatch that oclif cannot resolve.
    expectNative(translatePublicSandboxArgv("alpha", "sessions", []), "sandbox:sessions", [
      "alpha",
    ]);
    expectNative(translatePublicSandboxArgv("alpha", "sessions", ["--json"]), "sandbox:sessions", [
      "alpha",
      "--json",
    ]);
    expectNative(
      translatePublicSandboxArgv("alpha", "sessions", ["--all-agents"]),
      "sandbox:sessions",
      ["alpha", "--all-agents"],
    );
  });

  it("routes registered sessions subcommands to their native ids", () => {
    expectNative(
      translatePublicSandboxArgv("alpha", "sessions", ["list"]),
      "sandbox:sessions:list",
      ["alpha"],
    );
    expectNative(
      translatePublicSandboxArgv("alpha", "sessions", ["reset", "abc123"]),
      "sandbox:sessions:reset",
      ["alpha", "abc123"],
    );
  });

  it("routes sessions help tokens to parent help", () => {
    expectNative(
      translatePublicSandboxArgv("alpha", "sessions", ["--help"]),
      "sandbox:sessions",
      ["--help"],
      ["sandbox", "sessions", "--help"],
    );
    expectNative(
      translatePublicSandboxArgv("alpha", "sessions", ["help"]),
      "sandbox:sessions",
      ["--help"],
      ["sandbox", "sessions", "--help"],
    );
  });

  it("routes agents to the non-strict parent command for empty or flag-only args", () => {
    // sandbox:agents is a non-strict parent that owns the help screen itself;
    // the translator must dispatch to the registered parent command id rather
    // than synthesising a `sandbox:agents:--<flag>` subcommand that oclif
    // cannot resolve.
    expectNative(translatePublicSandboxArgv("alpha", "agents", []), "sandbox:agents", ["alpha"]);
    expectNative(translatePublicSandboxArgv("alpha", "agents", ["--json"]), "sandbox:agents", [
      "alpha",
      "--json",
    ]);
  });

  it("routes agents help tokens to parent help", () => {
    expectNative(
      translatePublicSandboxArgv("alpha", "agents", ["--help"]),
      "sandbox:agents",
      ["--help"],
      ["sandbox", "agents", "--help"],
    );
    expectNative(
      translatePublicSandboxArgv("alpha", "agents", ["help"]),
      "sandbox:agents",
      ["--help"],
      ["sandbox", "agents", "--help"],
    );
  });

  it("requires sandbox:agents to be a registered non-strict oclif parent", async () => {
    // Dispatch guard: translator returns `sandbox:agents` for parent
    // invocations; oclif must be able to resolve that id and run the parent
    // command. A regression that deletes `src/commands/sandbox/agents.ts`
    // would make every `nemoclaw <name> agents`/`agents --help` invocation
    // fail with an unknown-command error.
    const metadataModule = await import("./oclif-metadata");
    const metadata = metadataModule.getRegisteredOclifCommandMetadata("sandbox:agents");
    expect(metadata, "sandbox:agents must be a registered oclif command").not.toBeNull();
    expect(metadata?.strict).toBe(false);
  });
});
