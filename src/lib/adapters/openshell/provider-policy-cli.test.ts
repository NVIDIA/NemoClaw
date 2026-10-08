// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createCliOpenShellProviderAdapter, type RunProviderCommand } from "./provider-adapter-cli";
import { namedOpenShellGateway } from "./sandbox-observer";

function captured(status: number | null, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

describe("native provider policy prerequisite", () => {
  const target = namedOpenShellGateway("brev");
  const settings = (value: string) =>
    captured(0, JSON.stringify({ scope: "global", settings: { providers_v2_enabled: value } }));

  it("enables the pinned runtime's unset default and confirms the named gateway", async () => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(settings("<unset>"))
      .mockReturnValueOnce(captured(0))
      .mockReturnValueOnce(settings("true"));
    await expect(
      createCliOpenShellProviderAdapter({ run }).ensureProviderPolicyComposition({ target }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["settings", "get", "-g", "brev", "--global", "--json"],
      [
        "settings",
        "set",
        "-g",
        "brev",
        "--global",
        "--key",
        "providers_v2_enabled",
        "--value",
        "true",
        "--yes",
      ],
      ["settings", "get", "-g", "brev", "--global", "--json"],
    ]);
  });

  it.each(["true", "false", "invalid"])(
    "preserves existing %s settings without mutation",
    async (value) => {
      const run = vi.fn<RunProviderCommand>().mockReturnValue(settings(value));
      const result = await createCliOpenShellProviderAdapter({
        run,
      }).ensureProviderPolicyComposition({ target });
      expect(result.ok).toBe(value === "true");
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry an ambiguous settings mutation", async () => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(settings("<unset>"))
      .mockReturnValueOnce(captured(null, "", "connection lost"));
    expect(
      (await createCliOpenShellProviderAdapter({ run }).ensureProviderPolicyComposition({ target }))
        .ok,
    ).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails when the gateway does not confirm activation", async () => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(settings("<unset>"))
      .mockReturnValueOnce(captured(0))
      .mockReturnValueOnce(settings("<unset>"));
    expect(
      await createCliOpenShellProviderAdapter({ run }).ensureProviderPolicyComposition({ target }),
    ).toMatchObject({ ok: false, error: { reason: "uncertain" } });
  });
});
