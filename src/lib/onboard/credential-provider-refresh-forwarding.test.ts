// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  credentialKey,
  plan,
  privateKey,
  providerName,
  refreshLifecycle,
} from "../../../test/support/credential-provider-refresh";
import { MessagingSetupApplier } from "../messaging/applier/setup-applier";

const providerRequest = {
  target: { kind: "named" as const, gatewayName: "test-gateway" },
  providerName,
};

describe("onboarding provider refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("registers once across staging and creation when refresh status precedes the provider write", async () => {
    const flow = refreshLifecycle();
    await flow.stage();
    await expect(flow.materialize()).resolves.toEqual([providerName]);

    expect(flow.adapter.createProvider).toHaveBeenCalledOnce();
    expect(flow.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(flow.adapter.configureProviderRefresh).toHaveBeenCalledExactlyOnceWith({
      ...providerRequest,
      credentialKey,
      strategy: "google_service_account_jwt",
      material: [
        { key: "client_email", value: "bot@example.test" },
        { key: "scope", value: "https://www.googleapis.com/auth/chat.bot" },
      ],
      secretMaterial: [{ key: "private_key", value: privateKey }],
    });
    expect(flow.session.stagedCredentialProviders).toEqual([providerName]);
    expect([...flow.options().refreshReceipts!.values()]).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    ]);
    expect(
      JSON.stringify([
        plan,
        flow.session,
        flow.log.mock.calls,
        [...flow.options().refreshReceipts!],
        flow.options().definitions,
        flow.options().refreshes![0].material,
      ]),
    ).not.toContain(privateKey);
  });

  it.each([
    ["secretMaterial", { key: "private_key", value: "replacement-key" }],
    ["material", { key: "scope", value: "changed-scope" }],
  ] as const)("reconfigures refresh when %s changes", async (field, entry) => {
    const flow = refreshLifecycle();
    await flow.stage();
    const options = flow.options();

    await expect(
      MessagingSetupApplier.applyCredentialsAtOpenShell(plan, {
        ...options,
        refreshes: [{ ...options.refreshes![0], [field]: [entry] }],
      }),
    ).rejects.toThrow("last status 'configured'");
    expect(flow.adapter.configureProviderRefresh).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a staged refresh on another gateway", async () => {
    const flow = refreshLifecycle();
    await flow.stage();

    await expect(
      MessagingSetupApplier.applyCredentialsAtOpenShell(plan, {
        ...flow.options(),
        target: { kind: "named", gatewayName: "other-gateway" },
      }),
    ).rejects.toThrow("last status 'configured'");
    expect(flow.adapter.configureProviderRefresh).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a staged refresh after the provider revision changes", async () => {
    const flow = refreshLifecycle();
    await flow.stage();
    await flow.adapter.updateProvider({ ...providerRequest, credentials: [], config: [] });

    await expect(flow.materialize()).rejects.toThrow("last status 'configured'");
    expect(flow.adapter.configureProviderRefresh).toHaveBeenCalledTimes(2);
  });

  it("rejects provider revision changes during reuse verification", async () => {
    const flow = refreshLifecycle();
    await flow.stage();
    vi.mocked(flow.adapter.getProviderRefreshStatus).mockImplementationOnce(async () => {
      await flow.adapter.updateProvider({ ...providerRequest, credentials: [], config: [] });
      return { ok: true, value: { status: "refreshed" } };
    });

    await expect(flow.materialize()).rejects.toThrow(
      "changed while confirming its refresh registration",
    );
    expect(flow.adapter.configureProviderRefresh).toHaveBeenCalledOnce();
  });

  it("cleans up an initial pending mint without retaining a receipt", async () => {
    const flow = refreshLifecycle();
    vi.mocked(flow.adapter.getProviderRefreshStatus).mockResolvedValue({
      ok: true,
      value: { status: "configured" },
    });

    await expect(flow.stage()).rejects.toMatchObject({
      message: expect.stringContaining("last status 'configured'"),
      mutatedProviderNames: [],
    });
    expect(flow.options().refreshReceipts?.size).toBe(0);
    expect(flow.adapter.configureProviderRefresh).toHaveBeenCalledOnce();
    expect(flow.adapter.deleteProvider).toHaveBeenCalledOnce();
  });

  it("rejects a pending reused mint without deleting its provider", async () => {
    const flow = refreshLifecycle();
    await flow.stage();
    vi.mocked(flow.adapter.getProviderRefreshStatus).mockResolvedValue({
      ok: true,
      value: { status: "configured" },
    });

    await expect(flow.materialize()).rejects.toMatchObject({
      message: expect.stringContaining("last status 'configured'"),
      mutatedProviderNames: [],
    });
    expect(flow.options().refreshReceipts?.size).toBe(0);
    expect(flow.adapter.configureProviderRefresh).toHaveBeenCalledOnce();
    expect(flow.adapter.deleteProvider).not.toHaveBeenCalled();
  });

  it("rejects a lost refresh observation while waiting for token publication", async () => {
    const flow = refreshLifecycle();
    const status = vi.mocked(flow.adapter.getProviderRefreshStatus);
    const firstObservation = status.getMockImplementation()!;
    status.mockResolvedValue({
      ok: false,
      error: { kind: "transport", reason: "unreachable", message: "gateway unavailable" },
    });
    status.mockImplementationOnce(firstObservation);

    await expect(flow.stage()).rejects.toThrow("Could not observe gateway token minting");
    expect(flow.options().refreshReceipts?.size).toBe(0);
    expect(flow.adapter.configureProviderRefresh).toHaveBeenCalledOnce();
    expect(flow.adapter.deleteProvider).toHaveBeenCalledOnce();
  });

  it("rejects refreshed status when the token never reaches the provider", async () => {
    const flow = refreshLifecycle(false);
    await expect(flow.stage()).rejects.toThrow("without confirming a provider update");
    expect(flow.options().refreshReceipts?.size).toBe(0);
    expect(flow.session.stagedCredentialProviders).toEqual([]);
  });
});
