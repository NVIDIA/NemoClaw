// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createCliOpenShellProviderAdapter, type RunProviderCommand } from "./provider-adapter-cli";
import { namedOpenShellGateway } from "./sandbox-observer";
import { absentPolicy } from "./provider-policy.test-support";

describe("native provider policy prerequisite", () => {
  const target = namedOpenShellGateway("brev");
  it("verifies sandbox policy authority without mutating the named gateway", async () => {
    const run = vi.fn<RunProviderCommand>().mockReturnValue(absentPolicy);
    await expect(
      createCliOpenShellProviderAdapter({ run }).ensureProviderPolicyComposition({ target }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["policy", "list", "-g", "brev", "--global", "--page-size", "1", "--output", "json"],
    ]);
  });
  it.each(["loaded", "superseded"])("checks the current %s global revision", async (status) => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ revisions: [{}], next_page_token: "" }),
      })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ scope: "global", status }) });
    const result = await createCliOpenShellProviderAdapter({ run }).ensureProviderPolicyComposition(
      { target },
    );
    expect(result.ok).toBe(status === "superseded");
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(["list", "get"]);
  });
  it.each([
    { status: null, stdout: "", stderr: "connection lost" },
    { status: 1, stdout: "", stderr: "permission denied" },
    { status: 0, stdout: "{}", stderr: "" },
  ])("stops on an unverified response without changing gateway state", async (result) => {
    const run = vi.fn<RunProviderCommand>().mockReturnValue(result);
    expect(
      (await createCliOpenShellProviderAdapter({ run }).ensureProviderPolicyComposition({ target }))
        .ok,
    ).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
