// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createCliOpenShellProviderAdapter } from "./provider-adapter-cli";
import { selectedOpenShellGateway } from "./sandbox-observer";

function captured(status: number | null, stderr: string) {
  return { status, stdout: "", stderr };
}

describe("CLI OpenShell provider adapter uncertain mutations", () => {
  it("captures delete diagnostics without printing raw command output", async () => {
    const run = vi.fn(() => captured(1, "provider remains attached"));
    const adapter = createCliOpenShellProviderAdapter({ run });
    const result = await adapter.deleteProvider({
      target: selectedOpenShellGateway(),
      providerName: "search-prod",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "command", reason: "failed" },
    });
    expect(run).toHaveBeenCalledWith(
      ["provider", "delete", "search-prod"],
      expect.objectContaining({
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });
  it.each([
    [
      "connection reset; sandbox 'alpha' not found",
      { kind: "transport", reason: "connection_loss" },
    ],
    ["unauthorized; sandbox 'alpha' not found", { kind: "authentication" }],
  ])(
    "does not turn a transport or authentication failure into sandbox absence: %s",
    async (stderr, error) => {
      const adapter = createCliOpenShellProviderAdapter({ run: () => captured(1, stderr) });
      const result = await adapter.detachProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
        sandboxName: "alpha",
      });
      expect(result).toMatchObject({
        ok: false,
        error,
      });
    },
  );
  it.each([
    ["sandbox 'alpha' not found", "sandbox_not_found"],
    ["sandbox 'other-box' not found", "failed"],
    ["status: NotFound, code: PermissionDenied, message: \"sandbox 'alpha' not found\"", "failed"],
    ["sandbox 'other' not found, message: \"sandbox 'alpha' not found\"", "failed"],
    ["status: NotFound, message: \"sandbox 'alpha' not found\"", "sandbox_not_found"],
    ["sandbox not found", "failed"],
    ["sandbox alpha not found", "failed"],
    ["sandbox 'alpha' not found\nsandbox 'other-box' not found", "failed"],
    ["provider 'search-prod' not found", "not_found"],
    ["provider 'sandbox-telegram' not found", "failed"],
    ["provider 'other-provider' not found", "failed"],
    ["provider search-prod not found", "failed"],
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
    "provider other-provider is not attached",
    "Provider other-provider was not attached to sandbox alpha.",
    "Provider search-prod was not attached to sandbox other-sandbox.",
    "unauthorized; Provider search-prod was not attached to sandbox alpha.",
    "status: NotAttached, provider 'other-provider' is not bound",
    "unauthorized; provider search-prod is not attached",
    "connection reset; NotAttached",
    "internal gateway error: shield 'sentry' is not attached to its expected anchor",
  ])("rejects an unrelated or contradictory detach diagnostic: %s", async (stderr) => {
    const adapter = createCliOpenShellProviderAdapter({ run: () => captured(1, stderr) });
    await expect(
      adapter.detachProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
        sandboxName: "alpha",
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("recognizes the requested sandbox-prefixed provider as missing", async () => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => captured(1, "provider 'sandbox-telegram' not found"),
    });
    await expect(
      adapter.detachProvider({
        target: selectedOpenShellGateway(),
        providerName: "sandbox-telegram",
        sandboxName: "alpha",
      }),
    ).resolves.toMatchObject({ ok: false, error: { kind: "command", reason: "not_found" } });
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
