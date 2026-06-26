// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GatewayTokenCommandError,
  parseGatewayTokenArgs,
  runGatewayTokenCommand,
} from "../../dist/lib/gateway-token-command";

function makeSinks() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (m: string) => out.push(m),
    error: (m: string) => err.push(m),
  };
}

describe("parseGatewayTokenArgs", () => {
  it("defaults quiet to false when no flags are given", () => {
    expect(parseGatewayTokenArgs([])).toEqual({ options: { quiet: false }, unknown: [] });
  });

  it("parses --quiet", () => {
    expect(parseGatewayTokenArgs(["--quiet"])).toEqual({
      options: { quiet: true },
      unknown: [],
    });
  });

  it("parses -q", () => {
    expect(parseGatewayTokenArgs(["-q"])).toEqual({
      options: { quiet: true },
      unknown: [],
    });
  });

  it("collects unknown flags without throwing", () => {
    const { options, unknown } = parseGatewayTokenArgs(["--bogus", "-q", "extra"]);
    expect(options).toEqual({ quiet: true });
    expect(unknown).toEqual(["--bogus", "extra"]);
  });
});

describe("runGatewayTokenCommand", () => {
  it("prints the token to stdout and warns on stderr", () => {
    const sinks = makeSinks();
    const fetchToken = vi.fn(() => "secret-token-abc");
    runGatewayTokenCommand(
      "alpha",
      { quiet: false },
      { fetchToken, log: sinks.log, error: sinks.error },
    );
    expect(fetchToken).toHaveBeenCalledWith("alpha");
    expect(sinks.out).toEqual(["secret-token-abc"]);
    expect(sinks.err).toHaveLength(1);
    expect(sinks.err[0]).toMatch(/like a password/i);
  });

  it("suppresses the security warning when quiet is set", () => {
    const sinks = makeSinks();
    runGatewayTokenCommand(
      "alpha",
      { quiet: true },
      {
        fetchToken: () => "secret-token-abc",
        log: sinks.log,
        error: sinks.error,
      },
    );
    expect(sinks.out).toEqual(["secret-token-abc"]);
    expect(sinks.err).toEqual([]);
  });

  it("throws diagnostics when the token cannot be fetched", () => {
    const sinks = makeSinks();
    expect(() =>
      runGatewayTokenCommand(
        "alpha",
        { quiet: false },
        {
          fetchToken: () => null,
          log: sinks.log,
          error: sinks.error,
        },
      ),
    ).toThrow(GatewayTokenCommandError);
    expect(sinks.out).toEqual([]);
    try {
      runGatewayTokenCommand("alpha", { quiet: false }, { fetchToken: () => null });
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayTokenCommandError);
      expect((error as GatewayTokenCommandError).exitCode).toBe(1);
      expect((error as GatewayTokenCommandError).lines.join("\n")).toMatch(/Could not retrieve/);
      expect((error as GatewayTokenCommandError).lines.join("\n")).toMatch(/sandbox is running/);
    }
  });

  it("throws when fetchToken throws", () => {
    const sinks = makeSinks();
    expect(() =>
      runGatewayTokenCommand(
        "alpha",
        { quiet: true },
        {
          fetchToken: () => {
            throw new Error("openshell offline");
          },
          log: sinks.log,
          error: sinks.error,
        },
      ),
    ).toThrow(/Could not retrieve/);
    expect(sinks.out).toEqual([]);
    expect(sinks.err).toEqual([]);
  });

  it("treats an empty-string token as missing", () => {
    const sinks = makeSinks();
    expect(() =>
      runGatewayTokenCommand(
        "alpha",
        { quiet: false },
        {
          fetchToken: () => "",
          log: sinks.log,
          error: sinks.error,
        },
      ),
    ).toThrow(/Could not retrieve/);
    expect(sinks.out).toEqual([]);
  });

  // NCQ #3180: gateway-token is OpenClaw-specific. On non-OpenClaw agents
  // (e.g. Hermes) the misleading "make sure the sandbox is running" message
  // and the @oclif/core stack trace must NOT appear.
  it("prints an agent-aware not-applicable message on hermes without invoking fetchToken", () => {
    const sinks = makeSinks();
    const fetchToken = vi.fn(() => "should-not-be-called");
    const getSandboxAgent = vi.fn(() => "hermes");
    let thrown: GatewayTokenCommandError | null = null;
    try {
      runGatewayTokenCommand(
        "hermes",
        { quiet: false },
        { fetchToken, getSandboxAgent, log: sinks.log, error: sinks.error },
      );
    } catch (error) {
      thrown = error as GatewayTokenCommandError;
    }
    expect(thrown).toBeInstanceOf(GatewayTokenCommandError);
    expect(getSandboxAgent).toHaveBeenCalledWith("hermes");
    expect(fetchToken).not.toHaveBeenCalled();
    expect(sinks.out).toEqual([]);
    // Nothing is written to the live stderr sink; diagnostics travel on the
    // thrown error's `lines` so the caller renders them.
    expect(sinks.err).toEqual([]);
    const stderr = thrown?.lines.join("\n") ?? "";
    // Issue #3180 contract: an agent-aware "not applicable" lead line.
    expect(stderr).toMatch(/hermes/);
    expect(stderr).toMatch(/OpenClaw/);
    expect(stderr).toMatch(/not applicable/i);
    expect(stderr).not.toMatch(/sandbox is running/i);
    expect(stderr).not.toMatch(/ExitError|@oclif\/core|at Object\.exit/);
    // Issue #5249: the Hermes message must direct users to the supported
    // dashboard auth path instead of dead-ending on the OpenClaw-only note.
    expect(stderr).toMatch(/dashboard-url/);
    expect(stderr).toMatch(/\.hermes\/config\.yaml/);
  });

  // PRA-2 on #5252: the Hermes diagnostic must reflect the invoked CLI alias
  // so users who type `nemohermes` see `nemohermes` in the next-step hint,
  // not the hardcoded `nemoclaw`. The launcher binaries set
  // `NEMOCLAW_INVOKED_AS` so `getAgentBranding().cli` resolves to the right
  // command at runtime. `vi.stubEnv` + `vi.unstubAllEnvs` keep the test
  // deterministic without conditional state restoration in a `finally`.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Hermes diagnostic uses nemohermes when invoked through the NemoHermes alias", () => {
    vi.stubEnv("NEMOCLAW_INVOKED_AS", "nemohermes");
    const sinks = makeSinks();
    let thrown: GatewayTokenCommandError | null = null;
    try {
      runGatewayTokenCommand(
        "hermes",
        { quiet: false },
        {
          fetchToken: () => "should-not-be-called",
          getSandboxAgent: () => "hermes",
          log: sinks.log,
          error: sinks.error,
        },
      );
    } catch (error) {
      thrown = error as GatewayTokenCommandError;
    }
    expect(thrown).toBeInstanceOf(GatewayTokenCommandError);
    const stderr = thrown?.lines.join("\n") ?? "";
    expect(stderr).toContain("For Hermes dashboard access, run: nemohermes hermes dashboard-url");
    expect(stderr).not.toContain("nemoclaw hermes dashboard-url");
  });

  it("Hermes diagnostic uses nemoclaw when Hermes is selected through the nemoclaw binary", () => {
    vi.stubEnv("NEMOCLAW_INVOKED_AS", "nemoclaw");
    const sinks = makeSinks();
    let thrown: GatewayTokenCommandError | null = null;
    try {
      runGatewayTokenCommand(
        "hermes",
        { quiet: false },
        {
          fetchToken: () => "should-not-be-called",
          getSandboxAgent: () => "hermes",
          log: sinks.log,
          error: sinks.error,
        },
      );
    } catch (error) {
      thrown = error as GatewayTokenCommandError;
    }
    expect(thrown).toBeInstanceOf(GatewayTokenCommandError);
    const stderr = thrown?.lines.join("\n") ?? "";
    expect(stderr).toContain("For Hermes dashboard access, run: nemoclaw hermes dashboard-url");
    expect(stderr).not.toContain("nemohermes hermes dashboard-url");
  });

  it("keeps a single explanatory line for non-Hermes, non-OpenClaw agents", () => {
    const sinks = makeSinks();
    let thrown: GatewayTokenCommandError | null = null;
    try {
      runGatewayTokenCommand(
        "beta",
        { quiet: false },
        {
          fetchToken: () => "unused",
          getSandboxAgent: () => "someother",
          log: sinks.log,
          error: sinks.error,
        },
      );
    } catch (error) {
      thrown = error as GatewayTokenCommandError;
    }
    expect(thrown).toBeInstanceOf(GatewayTokenCommandError);
    expect(thrown?.lines).toHaveLength(1);
    expect(thrown?.lines[0]).toMatch(/not applicable/i);
    expect(thrown?.lines[0]).not.toMatch(/dashboard-url/);
  });

  it("fetches and prints the token for a bearer_token agent that exposes one (e.g. hermes)", () => {
    const sinks = makeSinks();
    const fetchToken = vi.fn(() => "hermes-api-server-key");
    const getSandboxAgent = vi.fn(() => "hermes");
    const agentExposesToken = vi.fn(() => true);
    runGatewayTokenCommand(
      "hermes",
      { quiet: true },
      { fetchToken, getSandboxAgent, agentExposesToken, log: sinks.log, error: sinks.error },
    );
    expect(agentExposesToken).toHaveBeenCalledWith("hermes");
    expect(fetchToken).toHaveBeenCalledWith("hermes");
    expect(sinks.out).toEqual(["hermes-api-server-key"]);
    expect(sinks.err).toEqual([]);
  });

  it("falls back to fetchToken when the agent lookup throws", () => {
    const sinks = makeSinks();
    runGatewayTokenCommand(
      "alpha",
      { quiet: true },
      {
        fetchToken: () => "openclaw-token",
        getSandboxAgent: () => {
          throw new Error("registry unavailable");
        },
        log: sinks.log,
        error: sinks.error,
      },
    );
    expect(sinks.out).toEqual(["openclaw-token"]);
  });

  it("uses the OpenClaw control path when the resolved agent is openclaw", () => {
    const sinks = makeSinks();
    const fetchToken = vi.fn(() => "openclaw-token");
    runGatewayTokenCommand(
      "alpha",
      { quiet: true },
      {
        fetchToken,
        getSandboxAgent: () => "openclaw",
        log: sinks.log,
        error: sinks.error,
      },
    );
    expect(fetchToken).toHaveBeenCalledWith("alpha");
    expect(sinks.out).toEqual(["openclaw-token"]);
  });

  it("uses the OpenClaw control path when getSandboxAgent returns null", () => {
    // Sandbox registry pre-dates the agent field — treat as OpenClaw.
    const sinks = makeSinks();
    runGatewayTokenCommand(
      "alpha",
      { quiet: true },
      {
        fetchToken: () => "openclaw-token",
        getSandboxAgent: () => null,
        log: sinks.log,
        error: sinks.error,
      },
    );
    expect(sinks.out).toEqual(["openclaw-token"]);
  });
});
