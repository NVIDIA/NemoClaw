// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createCliOpenShellProviderAdapter } from "./provider-adapter-cli";
import { selectedOpenShellGateway } from "./sandbox-observer";

function captured(status: number | null, stderr: string) {
  return { status, stdout: "", stderr };
}

describe("CLI OpenShell provider adapter uncertain mutations", () => {
  it.each([
    "connection reset; sandbox 'alpha' not found",
    "unauthorized; sandbox 'alpha' not found",
  ])(
    "does not turn a transport or authentication failure into sandbox absence: %s",
    async (stderr) => {
      const adapter = createCliOpenShellProviderAdapter({ run: () => captured(1, stderr) });
      const result = await adapter.detachProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
        sandboxName: "alpha",
      });
      expect(result).toMatchObject({
        ok: false,
        error: { kind: expect.not.stringContaining("command") },
      });
    },
  );
  it.each([
    ["sandbox 'alpha' not found", "sandbox_not_found"],
    ["provider 'search-prod' not found", "not_found"],
    ["provider 'sandbox-telegram' not found", "not_found"],
    ["NotFound", "failed"],
  ])("distinguishes the missing detach resource: %s (#9806)", async (stderr, reason) => {
    const adapter = createCliOpenShellProviderAdapter({ run: () => captured(1, stderr) });
    await expect(
      adapter.detachProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
        sandboxName: "alpha",
      }),
    ).resolves.toMatchObject({ ok: false, error: { kind: "command", reason } });
  });

  it.each([
    ["status-less", captured(null, "NotAttached")],
    [
      "signaled",
      { ...captured(null, "provider search-prod is not attached"), signal: "SIGTERM" as const },
    ],
  ])("rejects an uncertain idempotent detach result: %s (#9806)", async (_case, result) => {
    const adapter = createCliOpenShellProviderAdapter({ run: () => result });

    await expect(
      adapter.detachProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
        sandboxName: "alpha",
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("preserves the provider-not-found compatibility diagnostic on delete (#9806)", async () => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => captured(1, "provider 'search-prod' not found"),
    });

    await expect(
      adapter.deleteProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
      }),
    ).resolves.toMatchObject({
      error: { reason: "not_found", message: "OpenShell provider not found: 'search-prod'." },
    });
  });
});
