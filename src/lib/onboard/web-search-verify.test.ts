// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { verifyWebSearchInsideSandbox, type WebSearchVerifyDeps } from "./web-search-verify";

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
  it("reports active Hermes web backend", () => {
    const d = deps("web.backend: brave\n");

    verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, d);

    expect(d.log).toHaveBeenCalledWith("  ✓ Web search is active inside sandbox");
    expect(d.warn).not.toHaveBeenCalled();
  });

  it("warns when Hermes does not report active web backend", () => {
    const d = deps("active toolsets: shell\n");

    verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, d);

    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Web search was configured but Hermes does not report an active web backend.",
    );
    expect(d.warn).toHaveBeenCalledWith("    Check: nemoclaw alpha exec hermes dump");
  });

  it("verifies OpenClaw Brave Search egress through the subscription-token header", () => {
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
      JSON.stringify({ web: { results: [{ title: "NVIDIA" }] } }) + "\nHTTP_STATUS:200\n",
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, d);

    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(2);
    expect(d.runCaptureOpenshell.mock.calls[1][0]).toEqual([
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
    ]);

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, d);

    // Only the openclaw.json read happens — no curl probe with the raw key.
    expect(d.runCaptureOpenshell).toHaveBeenCalledTimes(1);
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
    expect(throwing.warn).toHaveBeenCalledWith("  ⚠ Web search verification probe failed (non-fatal).");
  });
});
