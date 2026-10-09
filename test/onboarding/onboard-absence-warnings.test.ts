// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createCliOpenShellProviderAdapter } from "../../src/lib/adapters/openshell/provider-adapter-cli";
import { selectedOpenShellGateway } from "../../src/lib/adapters/openshell/sandbox-observer";
import { runAuthorityBoundProviderCleanup } from "../../src/lib/onboard/sandbox-create/orchestration";
import {
  runSandboxProviderPreDeleteCleanup,
  SANDBOX_PROVIDER_SUFFIXES,
} from "../../src/lib/onboard/sandbox-provider-cleanup";

function captured(status: number | null, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

function runResult(status: number, stderr: string): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, "", stderr],
    status,
    stdout: "",
    stderr,
    signal: null,
  };
}

const missingSandboxDiagnostic =
  "Error:   × code: 'Some requested entity was not found', message: \"sandbox not found\"";

describe("fresh onboarding absence warnings (#12740)", () => {
  it.each([
    { label: "OpenShell entity-not-found code", diagnostic: missingSandboxDiagnostic },
    {
      label: "NotFound code",
      diagnostic: 'Error: × code: NotFound, message: "sandbox not found"',
    },
    {
      label: "NotFound status",
      diagnostic: 'Error: × status: NotFound, message: "sandbox not found"',
    },
  ])("classifies exact structured missing-sandbox response: $label", async ({ diagnostic }) => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => captured(1, "", diagnostic),
    });

    await expect(
      adapter.detachProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
        sandboxName: "alpha",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "sandbox_not_found",
        message: "OpenShell sandbox not found: 'alpha'.",
      },
    });
  });

  it.each([
    {
      sandboxName: "alpha",
      diagnostic: "Error:   × code: NotFound, message: \"sandbox 'alpha' not found\"",
      reason: "sandbox_not_found",
    },
    {
      sandboxName: "alpha",
      diagnostic: "Error:   × code: NotFound, message: \"sandbox 'beta' not found\"",
      reason: "failed",
    },
    {
      sandboxName: "alpha",
      diagnostic: 'Error:   × code: NotFound, message: "Sandbox not found"',
      reason: "failed",
    },
  ])(
    "binds named absence to the requested sandbox and requires the exact unqualified message",
    async ({ sandboxName, diagnostic, reason }) => {
      const adapter = createCliOpenShellProviderAdapter({
        run: () => captured(1, "", diagnostic),
      });

      await expect(
        adapter.detachProvider({
          target: selectedOpenShellGateway(),
          providerName: "search-prod",
          sandboxName,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { kind: "command", reason },
      });
    },
  );

  it.each([
    {
      label: "an extra field after the exact message",
      diagnostic:
        'Error: × code: NotFound, message: "sandbox not found", extra_field: "unexpected"',
    },
    {
      label: "conflicting structured status and code",
      diagnostic: 'Error: × status: NotFound, code: PermissionDenied, message: "sandbox not found"',
    },
  ])("rejects non-exact structured absence diagnostic: $label", async ({ diagnostic }) => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => captured(1, "", diagnostic),
    });

    await expect(
      adapter.detachProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
        sandboxName: "alpha",
      }),
    ).resolves.toMatchObject({ ok: false, error: { kind: "command", reason: "failed" } });
  });

  it("does not treat an unstructured missing-sandbox phrase as authoritative absence", async () => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => captured(1, "", "sandbox not found"),
    });

    await expect(
      adapter.detachProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
        sandboxName: "alpha",
      }),
    ).resolves.toMatchObject({ ok: false, error: { kind: "command", reason: "failed" } });
  });

  it("tolerates absence only under verified and repeatedly revalidated authority", async () => {
    const revalidateSandboxIdentity = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runOpenshell = vi.fn(() => runResult(1, missingSandboxDiagnostic));

    await runAuthorityBoundProviderCleanup({
      sandboxName: "alpha",
      observeSandbox: () => ({ state: "missing", liveIdentityFingerprint: null }),
      revalidateSandboxIdentity,
      runProviderPreDeleteCleanup: runSandboxProviderPreDeleteCleanup,
      runOpenshell,
      redact: (value) => value,
      tolerateMissingSandbox: true,
    });

    expect(warning).not.toHaveBeenCalled();
    expect(runOpenshell).toHaveBeenCalledTimes(SANDBOX_PROVIDER_SUFFIXES.length);
    expect(revalidateSandboxIdentity).toHaveBeenCalledTimes(
      SANDBOX_PROVIDER_SUFFIXES.length * 2 + 1,
    );
    warning.mockRestore();
  });

  it("retains absence warnings when cleanup lacks verified-absence authorization", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runOpenshell = vi.fn(() => runResult(1, missingSandboxDiagnostic));

    await runSandboxProviderPreDeleteCleanup("alpha", { runOpenshell });

    expect(warning).toHaveBeenCalledTimes(SANDBOX_PROVIDER_SUFFIXES.length);
    warning.mockRestore();
  });

  it("retains genuine provider detach failures despite absence tolerance", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runOpenshell = vi.fn((args: string[]) =>
      args.at(-1) === "alpha-telegram-bridge"
        ? runResult(1, "Error: provider backend failed")
        : runResult(0, ""),
    );

    await runAuthorityBoundProviderCleanup({
      sandboxName: "alpha",
      observeSandbox: () => ({ state: "missing", liveIdentityFingerprint: null }),
      revalidateSandboxIdentity: vi.fn(),
      runProviderPreDeleteCleanup: runSandboxProviderPreDeleteCleanup,
      runOpenshell,
      redact: (value) => value,
      tolerateMissingSandbox: true,
    });

    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(/failed to detach provider 'alpha-telegram-bridge'.*backend failed/u),
    );
    warning.mockRestore();
  });
});
