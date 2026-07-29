// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  classifyWebSearchEnvBoundary,
  verifyWebSearchInsideSandbox,
  type WebSearchVerifyDeps,
} from "./web-search-verify";

function deps(output: string | null | Array<string | null>) {
  const outputs = Array.isArray(output) ? [...output] : [output];
  return {
    runCaptureOpenshell: vi.fn<WebSearchVerifyDeps["runCaptureOpenshell"]>(
      () => outputs.shift() ?? null,
    ),
    cliName: vi.fn(() => "nemoclaw"),
    webSearchEnvFor: vi.fn((provider) =>
      provider === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY",
    ),
    webSearchLabelFor: vi.fn((provider) =>
      provider === "tavily" ? "Tavily Search" : "Brave Search",
    ),
    log: vi.fn(),
    warn: vi.fn(),
  } satisfies WebSearchVerifyDeps;
}

describe("verifyWebSearchInsideSandbox", () => {
  it("verifies Hermes Tavily egress through JSON body credential rewriting", () => {
    // Before config diagnostics and the egress probe, the secret-boundary check
    // classifies the selected env var in-sandbox.
    const d = deps([
      "__nemoclaw_wsenv__:absent",
      "web:\n  backend: tavily\n",
      JSON.stringify({ results: [{ title: "NVIDIA" }] }) + "\nHTTP_STATUS:200\n",
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, "tavily", d);

    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(3);
    expect(d.runCaptureOpenshell.mock.calls[1][0]).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "cat",
      "/sandbox/.hermes/config.yaml",
    ]);
    // The boundary probe classifies in-sandbox with `sh -c` (no login profiles)
    // and returns only a marked sentinel.
    expect(d.runCaptureOpenshell.mock.calls[0][0].slice(0, 7)).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "sh",
      "-c",
    ]);
    expect(d.runCaptureOpenshell.mock.calls[0][0][7]).toContain("printenv TAVILY_API_KEY");
    expect(d.runCaptureOpenshell.mock.calls[0][0][7]).not.toContain("cat ");
    expect(d.runCaptureOpenshell.mock.calls[2][0]).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "sh",
      "-lc",
      expect.stringContaining('"api_key":"openshell:resolve:env:TAVILY_API_KEY"'),
    ]);
    expect(d.log).toHaveBeenCalledWith("  ✓ Tavily Search egress verified inside sandbox");
    expect(d.warn).not.toHaveBeenCalled();
  });

  it("blocks Hermes handoff when the sandbox env exposes a raw Tavily key (#7425)", () => {
    const d = deps("__nemoclaw_wsenv__:raw-secret");

    const credentialBoundarySafe = verifyWebSearchInsideSandbox(
      "alpha",
      { name: "hermes" },
      "tavily",
      d,
    );

    expect(credentialBoundarySafe).toBe(false);
    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(1);
    expect(d.warn).toHaveBeenCalledWith(
      "  ✗ SECURITY: the Tavily Search credential is exposed in the sandbox environment.",
    );
  });

  it.each([
    {
      label: "unreadable Hermes config",
      agent: { name: "hermes" },
      provider: "tavily" as const,
      config: null,
      alert: "  ✗ SECURITY: the Tavily Search credential is exposed in the sandbox environment.",
    },
    {
      label: "malformed Hermes config",
      agent: { name: "hermes" },
      provider: "tavily" as const,
      config: "web: [\n",
      alert: "  ✗ SECURITY: the Tavily Search credential is exposed in the sandbox environment.",
    },
    {
      label: "disabled OpenClaw config",
      agent: { name: "openclaw" },
      provider: "brave" as const,
      config: JSON.stringify({ tools: { web: { search: { enabled: false } } } }),
      alert: "  ✗ SECURITY: the Brave Search credential is exposed in the sandbox environment.",
    },
    {
      label: "unsupported OpenClaw provider",
      agent: { name: "openclaw" },
      provider: "brave" as const,
      config: JSON.stringify({
        tools: { web: { search: { enabled: true, provider: "unsupported" } } },
      }),
      alert: "  ✗ SECURITY: the Brave Search credential is exposed in the sandbox environment.",
    },
  ])("blocks $label before configuration diagnostics (#7425)", ({
    agent,
    provider,
    config,
    alert,
  }) => {
    const d = deps(["__nemoclaw_wsenv__:raw-secret", config]);

    const credentialBoundarySafe = verifyWebSearchInsideSandbox("alpha", agent, provider, d);

    expect(credentialBoundarySafe).toBe(false);
    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(1);
    expect(d.warn).toHaveBeenCalledWith(alert);
  });

  it("does not treat pinned Hermes dump-shaped output as an active Tavily backend", () => {
    const d = deps(["__nemoclaw_wsenv__:absent", "active toolsets: web, shell\n"]);

    verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, "tavily", d);

    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Tavily Search was configured but Hermes config does not select web.backend=tavily.",
    );
    expect(d.warn).toHaveBeenCalledWith(
      "    Check: nemoclaw alpha exec -- cat /sandbox/.hermes/config.yaml",
    );
    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(2);
  });

  it("warns when the Hermes config is missing or malformed", () => {
    const missing = deps(["__nemoclaw_wsenv__:absent", null]);
    verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, "tavily", missing);
    expect(missing.warn).toHaveBeenCalledWith(
      "  ⚠ Could not read Hermes config to verify Tavily Search.",
    );

    const malformed = deps(["__nemoclaw_wsenv__:absent", "web: [\n"]);
    verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, "tavily", malformed);
    expect(malformed.warn).toHaveBeenCalledWith(
      "  ⚠ Could not parse Hermes config to verify Tavily Search.",
    );
  });

  it("verifies OpenClaw Brave Search egress through the subscription-token header", () => {
    // Current schema: the provider-owned apiKey lives under
    // plugins.entries.brave.config.webSearch, not inline on tools.web.search.
    const d = deps([
      "__nemoclaw_wsenv__:absent",
      JSON.stringify({
        tools: { web: { search: { enabled: true, provider: "brave" } } },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: { webSearch: { apiKey: "openshell:resolve:env:BRAVE_API_KEY" } },
            },
          },
        },
      }),
      JSON.stringify({ web: { results: [{ title: "NVIDIA" }] } }) + "\nHTTP_STATUS:200\n",
    ]);

    const credentialBoundarySafe = verifyWebSearchInsideSandbox(
      "alpha",
      { name: "openclaw" },
      "brave",
      d,
    );

    expect(credentialBoundarySafe).toBe(true);
    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(3);
    expect(d.runCaptureOpenshell.mock.calls[0][0].slice(0, 7)).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "sh",
      "-c",
    ]);
    expect(d.runCaptureOpenshell.mock.calls[0][0][7]).toContain("printenv BRAVE_API_KEY");
    expect(d.runCaptureOpenshell.mock.calls[2][0]).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "sh",
      "-lc",
      expect.stringContaining("X-Subscription-Token: openshell:resolve:env:BRAVE_API_KEY"),
    ]);
    expect(d.log).toHaveBeenCalledWith("  ✓ Brave Search egress verified inside sandbox");
  });

  it("verifies OpenClaw Tavily Search egress through the bearer header", () => {
    const d = deps([
      "__nemoclaw_wsenv__:placeholder",
      JSON.stringify({
        tools: { web: { search: { enabled: true, provider: "tavily" } } },
        plugins: {
          entries: {
            tavily: {
              enabled: true,
              config: { webSearch: { apiKey: "openshell:resolve:env:TAVILY_API_KEY" } },
            },
          },
        },
      }),
      JSON.stringify({ results: [{ title: "NVIDIA" }] }) + "\nHTTP_STATUS:200\n",
    ]);

    const credentialBoundarySafe = verifyWebSearchInsideSandbox(
      "alpha",
      { name: "openclaw" },
      "tavily",
      d,
    );

    expect(credentialBoundarySafe).toBe(true);
    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(3);
    expect(d.runCaptureOpenshell.mock.calls[2][0]).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "sh",
      "-lc",
      expect.stringContaining("Authorization: Bearer openshell:resolve:env:TAVILY_API_KEY"),
    ]);
    expect(d.runCaptureOpenshell.mock.calls[2][0][7]).toContain("https://api.tavily.com/search");
    expect(d.log).toHaveBeenCalledWith("  ✓ Tavily Search egress verified inside sandbox");
  });

  it("does not accept an empty Tavily results array as successful verification", () => {
    const d = deps([
      "__nemoclaw_wsenv__:absent",
      JSON.stringify({
        tools: { web: { search: { enabled: true, provider: "tavily" } } },
        plugins: {
          entries: {
            tavily: {
              enabled: true,
              config: { webSearch: { apiKey: "openshell:resolve:env:TAVILY_API_KEY" } },
            },
          },
        },
      }),
      JSON.stringify({ results: [] }) + "\nHTTP_STATUS:200\n",
    ]);

    const credentialBoundarySafe = verifyWebSearchInsideSandbox(
      "alpha",
      { name: "openclaw" },
      "tavily",
      d,
    );

    expect(credentialBoundarySafe).toBe(true);
    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Tavily Search config exists, but egress verification returned HTTP 200.",
    );
    expect(d.log).not.toHaveBeenCalled();
  });

  it("still probes legacy configs that carry the apiKey inline on tools.web.search", () => {
    const d = deps([
      "__nemoclaw_wsenv__:absent",
      JSON.stringify({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
              apiKey: "openshell:resolve:env:BRAVE_API_KEY",
            },
          },
        },
      }),
      JSON.stringify({ web: { results: [{ title: "NVIDIA" }] } }) + "\nHTTP_STATUS:200\n",
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, "brave", d);

    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(3);
    expect(d.log).toHaveBeenCalledWith("  ✓ Brave Search egress verified inside sandbox");
  });

  it("warns when OpenClaw Brave Search egress rejects the placeholder", () => {
    const d = deps([
      "__nemoclaw_wsenv__:placeholder",
      JSON.stringify({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
              apiKey: "openshell:resolve:env:BRAVE_API_KEY",
            },
          },
        },
      }),
      '{"message":"Unauthorized"}\nHTTP_STATUS:401\n',
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, "brave", d);

    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Brave Search config exists, but egress verification returned HTTP 401.",
    );
    expect(d.warn).toHaveBeenCalledWith(
      "    Re-run onboarding with --recreate-sandbox to migrate the Brave provider to the new profile.",
    );
  });

  it("refuses to probe when the apiKey is a literal secret rather than a placeholder", () => {
    const d = deps([
      "__nemoclaw_wsenv__:absent",
      JSON.stringify({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
              apiKey: "literal-secret-do-not-interpolate",
            },
          },
        },
      }),
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, "brave", d);

    // The config read and the sentinel-only boundary probe run, but no curl
    // probe interpolates the raw key.
    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(2);
    expect(d.runCaptureOpenshell.mock.calls[0][0].slice(0, 7)).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "sh",
      "-c",
    ]);
    for (const call of d.runCaptureOpenshell.mock.calls) {
      expect(call[0]).not.toContain("literal-secret-do-not-interpolate");
    }
    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Brave Search apiKey in openclaw.json is not an OpenShell placeholder; skipping egress probe.",
    );
  });

  it("warns when OpenClaw config is malformed or disabled", () => {
    const malformed = deps(["__nemoclaw_wsenv__:absent", "not-json"]);
    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, "brave", malformed);
    expect(malformed.warn).toHaveBeenCalledWith(
      "  ⚠ Could not parse openclaw.json to verify web search config.",
    );

    const disabled = deps([
      "__nemoclaw_wsenv__:absent",
      JSON.stringify({ tools: { web: { search: { enabled: false } } } }),
    ]);
    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, "brave", disabled);
    expect(disabled.warn).toHaveBeenCalledWith(
      "  ⚠ Web search was configured but tools.web.search is not enabled in openclaw.json.",
    );
  });

  it("warns for unknown agents after checking the selected credential boundary", () => {
    const unknown = deps("__nemoclaw_wsenv__:absent");
    verifyWebSearchInsideSandbox("alpha", { name: "other" }, "brave", unknown);
    expect(unknown.warn).toHaveBeenCalledWith(
      "  ⚠ Web search verification is not implemented for agent 'other'.",
    );
  });

  it("blocks handoff when the credential-boundary probe fails closed (#7425)", () => {
    const throwing = deps(null);
    throwing.runCaptureOpenshell = vi.fn(() => {
      throw new Error("boom");
    });
    const credentialBoundarySafe = verifyWebSearchInsideSandbox(
      "alpha",
      { name: "openclaw" },
      "brave",
      throwing,
    );
    expect(credentialBoundarySafe).toBe(false);
    expect(throwing.warn).toHaveBeenCalledWith(
      "  ✗ SECURITY: could not verify the Brave Search credential isolation boundary.",
    );
  });

  it("raises a security alert when the sandbox env exposes a raw Brave key (#7425)", () => {
    // The in-sandbox probe returns only the `raw-secret` sentinel — never the
    // key itself — so the guard does not pull the credential across the boundary.
    const d = deps("__nemoclaw_wsenv__:raw-secret");

    const credentialBoundarySafe = verifyWebSearchInsideSandbox(
      "alpha",
      { name: "openclaw" },
      "brave",
      d,
    );

    expect(d.warn).toHaveBeenCalledWith(
      "  ✗ SECURITY: the Brave Search credential is exposed in the sandbox environment.",
    );
    expect(d.warn).toHaveBeenCalledWith("      nemoclaw onboard --recreate-sandbox");
    expect(credentialBoundarySafe).toBe(false);
    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(1);
    expect(d.log).not.toHaveBeenCalledWith("  ✓ Brave Search egress verified inside sandbox");
  });

  it("accepts a resolve:env placeholder sentinel without a security alert", () => {
    const d = deps([
      "__nemoclaw_wsenv__:placeholder",
      JSON.stringify({
        tools: { web: { search: { enabled: true, provider: "brave" } } },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: { webSearch: { apiKey: "openshell:resolve:env:BRAVE_API_KEY" } },
            },
          },
        },
      }),
      JSON.stringify({ web: { results: [{ title: "NVIDIA" }] } }) + "\nHTTP_STATUS:200\n",
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, "brave", d);

    for (const call of d.warn.mock.calls) {
      expect(String(call[0] ?? "")).not.toContain("SECURITY");
    }
    expect(d.log).toHaveBeenCalledWith("  ✓ Brave Search egress verified inside sandbox");
  });
});

describe("classifyWebSearchEnvBoundary", () => {
  it("extracts the marked sentinel and tolerates surrounding shell noise", () => {
    expect(classifyWebSearchEnvBoundary("__nemoclaw_wsenv__:absent")).toBe("absent");
    expect(classifyWebSearchEnvBoundary("__nemoclaw_wsenv__:placeholder")).toBe("placeholder");
    expect(classifyWebSearchEnvBoundary("__nemoclaw_wsenv__:raw-secret")).toBe("raw-secret");
    // A login banner or MOTD before the marker must not mask a raw-secret result.
    expect(
      classifyWebSearchEnvBoundary("Welcome to the sandbox!\n__nemoclaw_wsenv__:raw-secret"),
    ).toBe("raw-secret");
    // A failed probe (null) or unmarked output cannot certify the boundary.
    expect(classifyWebSearchEnvBoundary(null)).toBe("unknown");
    expect(classifyWebSearchEnvBoundary(undefined)).toBe("unknown");
    expect(classifyWebSearchEnvBoundary("")).toBe("unknown");
    expect(classifyWebSearchEnvBoundary("raw-secret")).toBe("unknown");
    expect(classifyWebSearchEnvBoundary("unexpected output")).toBe("unknown");
  });
});
