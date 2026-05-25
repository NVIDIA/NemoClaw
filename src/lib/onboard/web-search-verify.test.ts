// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { verifyWebSearchInsideSandbox, type WebSearchVerifyDeps } from "./web-search-verify";

function deps(output: string | null) {
  return {
    runCaptureOpenshell: vi.fn(() => output),
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

  it("reports active OpenClaw web search config", () => {
    const d = deps(JSON.stringify({ tools: { web: { search: { enabled: true } } } }));

    verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, d);

    expect(d.log).toHaveBeenCalledWith("  ✓ Web search is active inside sandbox");
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
