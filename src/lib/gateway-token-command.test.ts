// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
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
    const exitCode = runGatewayTokenCommand(
      "alpha",
      { quiet: false },
      { fetchToken, log: sinks.log, error: sinks.error },
    );
    expect(exitCode).toBe(0);
    expect(fetchToken).toHaveBeenCalledWith("alpha");
    expect(sinks.out).toEqual(["secret-token-abc"]);
    expect(sinks.err).toHaveLength(1);
    expect(sinks.err[0]).toMatch(/like a password/i);
  });

  it("suppresses the security warning when quiet is set", () => {
    const sinks = makeSinks();
    const exitCode = runGatewayTokenCommand(
      "alpha",
      { quiet: true },
      {
        fetchToken: () => "secret-token-abc",
        log: sinks.log,
        error: sinks.error,
      },
    );
    expect(exitCode).toBe(0);
    expect(sinks.out).toEqual(["secret-token-abc"]);
    expect(sinks.err).toEqual([]);
  });

  it("exits 1 with diagnostics when the token cannot be fetched", () => {
    const sinks = makeSinks();
    const exitCode = runGatewayTokenCommand(
      "alpha",
      { quiet: false },
      {
        fetchToken: () => null,
        log: sinks.log,
        error: sinks.error,
      },
    );
    expect(exitCode).toBe(1);
    expect(sinks.out).toEqual([]);
    expect(sinks.err.join("\n")).toMatch(/Could not retrieve/);
    expect(sinks.err.join("\n")).toMatch(/sandbox is running/);
  });

  it("exits 1 when fetchToken throws", () => {
    const sinks = makeSinks();
    const exitCode = runGatewayTokenCommand(
      "alpha",
      { quiet: true },
      {
        fetchToken: () => {
          throw new Error("openshell offline");
        },
        log: sinks.log,
        error: sinks.error,
      },
    );
    expect(exitCode).toBe(1);
    expect(sinks.out).toEqual([]);
    expect(sinks.err.join("\n")).toMatch(/Could not retrieve/);
  });

  it("treats an empty-string token as missing", () => {
    const sinks = makeSinks();
    const exitCode = runGatewayTokenCommand(
      "alpha",
      { quiet: false },
      {
        fetchToken: () => "",
        log: sinks.log,
        error: sinks.error,
      },
    );
    expect(exitCode).toBe(1);
    expect(sinks.out).toEqual([]);
  });
});
