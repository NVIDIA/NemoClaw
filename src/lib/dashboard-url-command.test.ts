// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { buildDashboardUrl, runDashboardUrlCommand } from "./dashboard-url-command";

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

describe("dashboard-url command helpers", () => {
  it("builds a tokenized dashboard URL for a dashboard port", () => {
    expect(buildDashboardUrl("secret token", 18790)).toBe(
      "http://127.0.0.1:18790/#token=secret%20token",
    );
  });

  it("builds a tokenized dashboard URL for an alternate access URL", () => {
    expect(buildDashboardUrl("secret token", 18790, "http://172.22.1.1:18790")).toBe(
      "http://172.22.1.1:18790/#token=secret%20token",
    );
  });

  it("rejects empty tokens before building a URL", () => {
    expect(() => buildDashboardUrl("", 18790)).toThrow(/token is required/);
  });

  it("prints only the URL in quiet mode", () => {
    const sinks = makeSinks();
    const fetchToken = vi.fn(() => "secret-token");
    const getSandbox = vi.fn(() => ({ agent: "openclaw", dashboardPort: 19000 }));

    runDashboardUrlCommand(
      "alpha",
      { quiet: true },
      { fetchToken, getSandbox, log: sinks.log, error: sinks.error },
    );

    expect(fetchToken).toHaveBeenCalledWith("alpha");
    expect(getSandbox).toHaveBeenCalledWith("alpha");
    expect(sinks.out).toEqual(["http://127.0.0.1:19000/#token=secret-token"]);
    expect(sinks.err).toEqual([]);
  });

  it("prints the resolved access URL when provided", () => {
    const sinks = makeSinks();

    runDashboardUrlCommand(
      "alpha",
      { quiet: true },
      {
        fetchToken: () => "secret-token",
        getSandbox: () => ({ agent: "openclaw", dashboardPort: 19000 }),
        getAccessUrl: () => "http://172.22.1.1:19000",
        log: sinks.log,
        error: sinks.error,
      },
    );

    expect(sinks.out).toEqual(["http://172.22.1.1:19000/#token=secret-token"]);
  });

  it("prints a human label and warning outside quiet mode", () => {
    const sinks = makeSinks();
    runDashboardUrlCommand(
      "alpha",
      { quiet: false },
      {
        fetchToken: () => "secret-token",
        getSandbox: () => ({ agent: null, dashboardPort: 18789 }),
        log: sinks.log,
        error: sinks.error,
      },
    );

    expect(sinks.out).toEqual(["  Dashboard URL:", "  http://127.0.0.1:18789/#token=secret-token"]);
    expect(sinks.err.join("\n")).toContain("Treat this URL like a password");
  });

  it("prints a plain dashboard URL for session-auth non-OpenClaw agents without fetching a token", () => {
    const sinks = makeSinks();
    const fetchToken = vi.fn(() => "should-not-fetch");

    runDashboardUrlCommand(
      "hermes",
      { quiet: true },
      {
        fetchToken,
        getSandbox: () => ({ agent: "hermes", dashboardPort: 18789 }),
        getAgentDashboardAuth: () => "session",
        log: sinks.log,
        error: sinks.error,
      },
    );

    expect(fetchToken).not.toHaveBeenCalled();
    expect(sinks.out).toEqual(["http://127.0.0.1:18789/"]);
    expect(sinks.err).toEqual([]);
  });

  it("fetches a token for non-OpenClaw agents with token-auth dashboards", () => {
    const sinks = makeSinks();
    const fetchToken = vi.fn(() => "agent-token");

    runDashboardUrlCommand(
      "agent-ui",
      { quiet: true },
      {
        fetchToken,
        getSandbox: () => ({ agent: "agent-ui", dashboardPort: 19001 }),
        getAgentDashboardAuth: () => "url_token",
        log: sinks.log,
        error: sinks.error,
      },
    );

    expect(fetchToken).toHaveBeenCalledWith("agent-ui");
    expect(sinks.out).toEqual(["http://127.0.0.1:19001/#token=agent-token"]);
  });

  it("fails when non-OpenClaw agent dashboard metadata cannot be resolved", () => {
    const sinks = makeSinks();

    expect(() =>
      runDashboardUrlCommand(
        "agent-ui",
        { quiet: true },
        {
          fetchToken: () => "agent-token",
          getSandbox: () => ({ agent: "agent-ui", dashboardPort: 19001 }),
          getAgentDashboardAuth: () => null,
          log: sinks.log,
          error: sinks.error,
        },
      ),
    ).toThrow(/Could not resolve dashboard metadata/);
    expect(sinks.out).toEqual([]);
  });

  it("fails when the token cannot be retrieved", () => {
    const sinks = makeSinks();
    expect(() =>
      runDashboardUrlCommand(
        "alpha",
        { quiet: false },
        {
          fetchToken: () => null,
          getSandbox: () => ({ agent: "openclaw", dashboardPort: 18789 }),
          log: sinks.log,
          error: sinks.error,
        },
      ),
    ).toThrow(/Could not retrieve/);
    expect(sinks.out).toEqual([]);
  });
});
