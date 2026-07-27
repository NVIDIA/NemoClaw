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
    log: vi.fn(),
    warn: vi.fn(),
  } satisfies WebSearchVerifyDeps;
}

describe("verifyWebSearchInsideSandbox", () => {
  it("verifies Hermes Tavily egress through JSON body credential rewriting", () => {
    // Between the config read and the egress probe the secret-boundary check
    // classifies the env var in-sandbox; a null/absent sentinel means no raw
    // key is exposed.
    const d = deps([
      "web:\n  backend: tavily\n",
      "absent",
      JSON.stringify({ results: [{ title: "NVIDIA" }] }) + "\nHTTP_STATUS:200\n",
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, d);

    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(3);
    expect(d.runCaptureOpenshell.mock.calls[0][0]).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "cat",
      "/sandbox/.hermes/config.yaml",
    ]);
    // The boundary probe classifies in-sandbox and returns only a sentinel.
    expect(d.runCaptureOpenshell.mock.calls[1][0].slice(0, 7)).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "sh",
      "-lc",
    ]);
    expect(d.runCaptureOpenshell.mock.calls[1][0][7]).toContain("printenv TAVILY_API_KEY");
    expect(d.runCaptureOpenshell.mock.calls[1][0][7]).not.toContain("cat ");
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

  it("does not treat pinned Hermes dump-shaped output as an active Tavily backend", () => {
    const d = deps("active toolsets: web, shell\n");

    verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, d);

    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Tavily Search was configured but Hermes config does not select web.backend=tavily.",
    );
    expect(d.warn).toHaveBeenCalledWith(
      "    Check: nemoclaw alpha exec -- cat /sandbox/.hermes/config.yaml",
    );
    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(1);
  });

  it("warns when the Hermes config is missing or malformed", () => {
    const missing = deps(null);
    verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, missing);
    expect(missing.warn).toHaveBeenCalledWith(
      "  ⚠ Could not read Hermes config to verify Tavily Search.",
    );

    const malformed = deps("web: [\n");
    verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, malformed);
    expect(malformed.warn).toHaveBeenCalledWith(
      "  ⚠ Could not parse Hermes config to verify Tavily Search.",
    );
  });

  it("verifies OpenClaw Brave Search egress through the subscription-token header", () => {
    // Current schema: the provider-owned apiKey lives under
    // plugins.entries.brave.config.webSearch, not inline on tools.web.search.
    const d = deps([
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
      "absent",
      JSON.stringify({ web: { results: [{ title: "NVIDIA" }] } }) + "\nHTTP_STATUS:200\n",
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, d);

    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(3);
    expect(d.runCaptureOpenshell.mock.calls[1][0].slice(0, 7)).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "sh",
      "-lc",
    ]);
    expect(d.runCaptureOpenshell.mock.calls[1][0][7]).toContain("printenv BRAVE_API_KEY");
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
      null,
      JSON.stringify({ results: [{ title: "NVIDIA" }] }) + "\nHTTP_STATUS:200\n",
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, d);

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
      null,
      JSON.stringify({ results: [] }) + "\nHTTP_STATUS:200\n",
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, d);

    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Tavily Search config exists, but egress verification returned HTTP 200.",
    );
    expect(d.log).not.toHaveBeenCalled();
  });

  it("still probes legacy configs that carry the apiKey inline on tools.web.search", () => {
    const d = deps([
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
      null,
      JSON.stringify({ web: { results: [{ title: "NVIDIA" }] } }) + "\nHTTP_STATUS:200\n",
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, d);

    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(3);
    expect(d.log).toHaveBeenCalledWith("  ✓ Brave Search egress verified inside sandbox");
  });

  it("warns when OpenClaw Brave Search egress rejects the placeholder", () => {
    const d = deps([
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
      null,
      '{"message":"Unauthorized"}\nHTTP_STATUS:401\n',
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, d);

    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Brave Search config exists, but egress verification returned HTTP 401.",
    );
    expect(d.warn).toHaveBeenCalledWith(
      "    Re-run onboarding with --recreate-sandbox to migrate the Brave provider to the new profile.",
    );
  });

  it("refuses to probe when the apiKey is a literal secret rather than a placeholder", () => {
    const d = deps([
      JSON.stringify({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
              apiKey: "BSA-real-looking-secret-do-not-interpolate",
            },
          },
        },
      }),
      null,
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, d);

    // The config read and the sentinel-only boundary probe run, but no curl
    // probe interpolates the raw key.
    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(2);
    expect(d.runCaptureOpenshell.mock.calls[1][0].slice(0, 7)).toEqual([
      "sandbox",
      "exec",
      "-n",
      "alpha",
      "--",
      "sh",
      "-lc",
    ]);
    for (const call of d.runCaptureOpenshell.mock.calls) {
      expect(call[0]).not.toContain("BSA-real-looking-secret-do-not-interpolate");
    }
    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Brave Search apiKey in openclaw.json is not an OpenShell placeholder; skipping egress probe.",
    );
  });

  it("warns when OpenClaw config is malformed or disabled", () => {
    const malformed = deps("not-json");
    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, malformed);
    expect(malformed.warn).toHaveBeenCalledWith(
      "  ⚠ Could not parse openclaw.json to verify web search config.",
    );

    const disabled = deps(JSON.stringify({ tools: { web: { search: { enabled: false } } } }));
    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, disabled);
    expect(disabled.warn).toHaveBeenCalledWith(
      "  ⚠ Web search was configured but tools.web.search is not enabled in openclaw.json.",
    );
  });

  it("warns for unknown agents and catches probe errors", () => {
    const unknown = deps(null);
    verifyWebSearchInsideSandbox("alpha", { name: "other" }, unknown);
    expect(unknown.warn).toHaveBeenCalledWith(
      "  ⚠ Web search verification is not implemented for agent 'other'.",
    );

    const throwing = deps(null);
    throwing.runCaptureOpenshell = vi.fn(() => {
      throw new Error("boom");
    });
    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, throwing);
    expect(throwing.warn).toHaveBeenCalledWith(
      "  ⚠ Web search verification probe failed (non-fatal).",
    );
  });

  it("raises a security alert when the sandbox env exposes a raw Brave key (#7425)", () => {
    // The in-sandbox probe returns only the `raw-secret` sentinel — never the
    // key itself — so the guard does not pull the credential across the boundary.
    const d = deps([
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
      "raw-secret",
      JSON.stringify({ web: { results: [{ title: "NVIDIA" }] } }) + "\nHTTP_STATUS:200\n",
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, d);

    expect(d.warn).toHaveBeenCalledWith(
      "  ✗ SECURITY: the Brave Search credential is exposed in the sandbox environment.",
    );
    expect(d.warn).toHaveBeenCalledWith("      nemoclaw onboard --recreate-sandbox");
    // Non-fatal: egress verification still runs after the alert.
    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(3);
  });

  it("accepts a resolve:env placeholder sentinel without a security alert", () => {
    const d = deps([
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
      "placeholder",
      JSON.stringify({ web: { results: [{ title: "NVIDIA" }] } }) + "\nHTTP_STATUS:200\n",
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, d);

    for (const call of d.warn.mock.calls) {
      expect(String(call[0] ?? "")).not.toContain("SECURITY");
    }
    expect(d.log).toHaveBeenCalledWith("  ✓ Brave Search egress verified inside sandbox");
  });
});

describe("classifyWebSearchEnvBoundary", () => {
  it("maps in-sandbox sentinels and treats anything else as absent", () => {
    expect(classifyWebSearchEnvBoundary("absent")).toBe("absent");
    expect(classifyWebSearchEnvBoundary("placeholder")).toBe("placeholder");
    expect(classifyWebSearchEnvBoundary("raw-secret")).toBe("raw-secret");
    expect(classifyWebSearchEnvBoundary(" raw-secret\n")).toBe("raw-secret");
    // A failed probe (null) or unexpected output must never raise a false alarm.
    expect(classifyWebSearchEnvBoundary(null)).toBe("absent");
    expect(classifyWebSearchEnvBoundary(undefined)).toBe("absent");
    expect(classifyWebSearchEnvBoundary("")).toBe("absent");
    expect(classifyWebSearchEnvBoundary("BSAabcdefghijklmnopqrstuvwxyz012345")).toBe("absent");
  });
});
