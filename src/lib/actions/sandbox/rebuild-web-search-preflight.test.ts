// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildRebuildBraveSearchProbeCommand,
  preflightRebuildBraveSearchRoute,
} from "./rebuild-web-search-preflight";

describe("atomic rebuild Brave Search preflight", () => {
  it("probes through the retained OpenShell placeholder without embedding a credential", () => {
    const command = buildRebuildBraveSearchProbeCommand();
    expect(command).toContain("https://api.search.brave.com/res/v1/web/search");
    expect(command).toContain("openshell:resolve:env:BRAVE_API_KEY");
    expect(command).not.toMatch(/brv-[A-Za-z0-9]/);
  });

  it("accepts a successful request through the gateway-held credential", () => {
    const execute = vi.fn(() => ({ status: 0, stdout: '200\n{"web":{}}', stderr: "" }));
    expect(preflightRebuildBraveSearchRoute("alpha", { execute })).toEqual({ ok: true });
  });

  it("fails closed and redacts a rejected gateway-held credential", () => {
    const execute = vi.fn(() => ({
      status: 1,
      stdout: "401",
      stderr: "rejected brv-secret-value-that-is-long-enough",
    }));
    const result = preflightRebuildBraveSearchRoute("alpha", { execute });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("401");
      expect(result.detail).not.toContain("brv-secret-value-that-is-long-enough");
    }
  });
});
