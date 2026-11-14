// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeNativeProviderPolicy, requireNativeProviderPolicy } from "./provider-policy";
import type { OpenShellProviderAdapter, OpenShellProviderMetadata } from "./provider-adapter";
import { ensureNativeLocalProvider } from "../../inference/native-local/profile";
import { absentPolicy, fixture } from "./provider-policy.test-support";

afterEach(() => vi.unstubAllEnvs());
describe("native provider policy prerequisites", () => {
  it.each([requireNativeProviderPolicy, initializeNativeProviderPolicy])(
    "verifies the named gateway without changing settings",
    async (check) => {
      const run = fixture();
      await check("selected", run);
      expect(run.mock.calls.map(([args]) => args)).toEqual([
        ["policy", "list", "-g", "selected", "--global", "--page-size", "1", "--output", "json"],
      ]);
    },
  );
  it.each(["loaded", "pending", "failed", "unspecified"])(
    "refuses a global override with status %s",
    async (status) => {
      const run = fixture({
        status: 0,
        stdout: JSON.stringify({ scope: "global", status }),
        stderr: "",
      });
      await expect(requireNativeProviderPolicy("selected", run)).rejects.toThrow(
        /global policy override/,
      );
      expect(run.mock.calls.map(([args]) => args[1])).toEqual(["list", "get"]);
    },
  );
  it("accepts deleted global policy history", async () => {
    const run = fixture({
      status: 0,
      stdout: JSON.stringify({ scope: "global", status: "superseded" }),
      stderr: "",
    });
    await expect(requireNativeProviderPolicy("selected", run)).resolves.toBeUndefined();
  });
  it.each([
    { status: 1, stdout: "", stderr: "No global policy history found" },
    {
      status: 1,
      stdout: "",
      stderr: 'status: NotFound, message: "no global policy revision found"',
    },
    { status: 1, stdout: "", stderr: "permission denied" },
    { status: null, stdout: "", stderr: "connection lost" },
    { status: 0, stdout: "{broken", stderr: "" },
    { status: 0, stdout: "[]", stderr: "" },
    { status: 0, stdout: "{}", stderr: "" },
    { status: 0, stdout: JSON.stringify({ revisions: [], next_page_token: "next" }), stderr: "" },
    { status: 0, stdout: " ".repeat(65_537), stderr: "" },
  ])("rejects unverified global policy history", async (response) => {
    const run = vi.fn(async () => response);
    await expect(requireNativeProviderPolicy("selected", run)).rejects.toThrow(
      /prerequisites|policy history|response exceeded/,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not accept history without a verified current revision", async () => {
    const run = fixture({ status: 1, stdout: "", stderr: "permission denied" });
    await expect(requireNativeProviderPolicy("selected", run)).rejects.toThrow(/prerequisites/);
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(["list", "get"]);
  });
  it("rejects a superseded revision from another scope", async () => {
    const run = fixture({
      status: 0,
      stdout: JSON.stringify({ scope: "sandbox", status: "superseded" }),
      stderr: "",
    });
    await expect(requireNativeProviderPolicy("selected", run)).rejects.toThrow(
      /global policy override/,
    );
  });
  it("requires successful transport even when the history payload appears empty", async () => {
    await expect(
      requireNativeProviderPolicy("selected", async () => ({
        ...absentPolicy,
        error: new Error("lost response"),
      })),
    ).rejects.toThrow(/prerequisites/);
  });
  it("rejects an ambient endpoint override before any command", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://another.example:443");
    const run = fixture();
    await expect(requireNativeProviderPolicy("selected", run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

// Native local callers verify policy prerequisites without taking ownership of settings.
function nativeLocalPolicyFixture(override: boolean) {
  const policyCommand = override
    ? fixture({
        status: 0,
        stdout: JSON.stringify({ scope: "global", status: "loaded" }),
        stderr: "",
      })
    : fixture();
  let provider: OpenShellProviderMetadata | undefined;
  const providerAdapter = {
    importProviderProfile: vi.fn(async () => ({ ok: true })),
    getProvider: vi.fn(async () =>
      provider
        ? { ok: true, value: provider }
        : { ok: false, error: { kind: "command", reason: "not_found", message: "absent" } },
    ),
    ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
    createProvider: vi.fn<OpenShellProviderAdapter["createProvider"]>(async (request) => {
      provider = {
        name: request.name,
        type: request.type,
        credentialKeys: request.credentials.map((credential) => credential.name),
        configKeys: [],
        revision: { id: "owned", resourceVersion: 1 },
      };
      return { ok: true };
    }),
  };
  const action = ensureNativeLocalProvider({
    adapter: providerAdapter as unknown as OpenShellProviderAdapter,
    binding: {
      provider: "vllm-local",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
      authMode: "sentinel",
      gatewayName: "selected",
      sandboxName: "alice",
    },
    credentialValue: "test-key",
    policyCommand,
    readAuthority: () => undefined,
    writeAuthority: vi.fn(),
  });
  return { action, providerAdapter, policyCommand };
}

it("keeps native-local composition read-only (#12558)", async () => {
  const { action, providerAdapter, policyCommand } = nativeLocalPolicyFixture(false);
  await expect(action).resolves.toMatchObject({ sandboxName: "alice" });
  expect(providerAdapter.ensureProviderPolicyComposition).not.toHaveBeenCalled();
  expect(policyCommand.mock.calls.some(([args]) => args.includes("set"))).toBe(false);
});

it("rejects global policy override before native-local provider mutation (#12558)", async () => {
  const { action, providerAdapter, policyCommand } = nativeLocalPolicyFixture(true);
  await expect(action).rejects.toThrow("administrator");
  expect(providerAdapter.ensureProviderPolicyComposition).not.toHaveBeenCalled();
  expect(policyCommand.mock.calls.some(([args]) => args.includes("set"))).toBe(false);
});
