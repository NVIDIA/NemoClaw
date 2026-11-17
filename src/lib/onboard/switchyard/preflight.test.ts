// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createSwitchyardReadinessFixture } from "../../../../test/helpers/native-launch-readiness-switchyard";
import { switchyardStateForEntry, verifySwitchyardRequest } from "./preflight";
import { requireLaunchSemanticHealth } from "../../actions/sandbox/launch-readiness/health";
import { loadAgent } from "../../agent/defs";
import { collectSandboxStatusSnapshot } from "../../actions/sandbox/status-snapshot";
import {
  onboardInferenceVerificationContext,
  probeOnboardInferenceInvocation,
} from "../../verify-deployment";

describe("Switchyard verification gate", () => {
  it.each([true, false])(
    "gates status without a shared-route or upstream probe, ready=%s (#13864)",
    async (ready) => {
      const { routedEntry, observe, f } = await createSwitchyardReadinessFixture(
        "nemoclaw",
        "sandbox",
      );
      f.names.length *= Number(ready);
      const direct = vi.fn();
      const shared = vi.fn();
      const request = vi.fn(async () => ({ ok: true as const }));
      const snapshot = await collectSandboxStatusSnapshot("sandbox", {
        suppressInferenceProbe: false,
        deps: {
          getSandbox: () => routedEntry,
          reconcile: async () => ({ state: "present", output: "Phase: Ready" }),
          listPublishedSandboxesAcrossGatewayRoots: () => [routedEntry],
          switchyardPreflight: observe,
          inferenceRouteObserver: { observeInferenceRoute: shared },
          probeSandboxInferenceGatewayHealthImpl: shared,
          probeProviderHealthImpl: direct,
          probeSandboxInferenceInvocationImpl: request,
        },
      });
      expect(snapshot.inferenceHealth).toMatchObject({
        ok: ready,
        probed: ready,
        subprobes: [expect.objectContaining({ ok: ready, probeLabel: "routing preflight" })],
      });
      expect(direct).not.toHaveBeenCalled();
      expect(shared).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(Number(ready));
    },
  );
  it.each([true, false])(
    "carries routing intent into the onboarding request gate, ready=%s (#13864)",
    async (ready) => {
      const { routedEntry, observe, f } = await createSwitchyardReadinessFixture(
        "gateway",
        "sandbox",
      );
      f.names.length *= Number(ready);
      const context = onboardInferenceVerificationContext(
        "sandbox",
        "gateway",
        "hermes",
        {
          provider: routedEntry.provider,
          model: routedEntry.model,
          preferredInferenceApi: "openai-completions",
        },
        routedEntry,
      );
      expect(context.route.switchyardEntry).toEqual(context.invocation.switchyardEntry);
      const request = vi.fn(async () => ({ ok: true as const }));
      await expect(
        probeOnboardInferenceInvocation(context.invocation, request, observe),
      ).resolves.toMatchObject({ ok: ready });
      expect(request).toHaveBeenCalledTimes(Number(ready));
    },
  );
  it("withholds status observations and requests for conflicting gateway identity (#13864)", async () => {
    const { routedEntry, observe } = await createSwitchyardReadinessFixture("gateway", "sandbox");
    const observed = vi.fn(observe);
    const request = vi.fn(async () => ({ ok: true as const }));
    const snapshot = await collectSandboxStatusSnapshot("sandbox", {
      deps: {
        getSandbox: () => ({ ...routedEntry, gatewayPort: 9123 }),
        reconcile: async () => ({ state: "present", output: "Phase: Ready" }),
        listPublishedSandboxesAcrossGatewayRoots: () => [routedEntry],
        switchyardPreflight: observed,
        probeSandboxInferenceInvocationImpl: request,
      },
    });
    expect(snapshot.inferenceHealth?.ok).toBe(false);
    expect(observed).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "rechecks evidence after a request exception, changed=%s (#13864)",
    async (changed) => {
      const { routedEntry } = await createSwitchyardReadinessFixture("gateway", "sandbox");
      const observe = vi
        .fn()
        .mockResolvedValueOnce("before")
        .mockResolvedValueOnce(changed ? "after" : "before");
      const request = vi.fn(async () => {
        throw new Error("private-request-error");
      });
      const result = await verifySwitchyardRequest(routedEntry, "sandbox", request, observe);
      expect(result).toMatchObject({ ok: false, preflightOk: !changed, requestSent: true });
      expect(observe).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledOnce();
      expect(result.detail).not.toContain("private-request-error");
    },
  );
  it("keeps routing-disabled entries out of preflight (#13864)", () => {
    expect(switchyardStateForEntry({ agent: "hermes" })).toBeNull();
  });
  it("does not treat lost registry routing as disabled when the profile requests routing (#13864)", async () => {
    const { routedEntry } = await createSwitchyardReadinessFixture("gateway", "sandbox");
    expect(() => switchyardStateForEntry({ ...routedEntry, hermesSwitchyard: undefined })).toThrow(
      "configuration",
    );
  });
  it("accepts one capable request only with unchanged evidence (#13864)", async () => {
    const { routedEntry, observe, preflight } = await createSwitchyardReadinessFixture(
      "gateway",
      "sandbox",
    );
    const request = vi.fn(async () => ({ ok: true }));
    await expect(
      verifySwitchyardRequest(routedEntry, "sandbox", request, observe),
    ).resolves.toMatchObject({ ok: true, preflightOk: true, requestSent: true });
    expect(request).toHaveBeenCalledOnce();
    expect(preflight.execute).toHaveBeenCalledTimes(2);
  });
  it.each([
    "provider-removed",
    "provider-revised",
    "policy-missing",
    "policy-unavailable",
    "runtime-unavailable",
    "config-drift",
    "credentials-missing",
  ])("withholds every request when %s (#13864)", async (failure) => {
    const { routedEntry, observe, f, preflight } = await createSwitchyardReadinessFixture(
      "gateway",
      "sandbox",
    );
    const binding = routedEntry.hermesSwitchyard.bindings.providers[0]!;
    const fail = {
      "provider-removed": () => f.providers.delete(binding.providerName),
      "provider-revised": () =>
        f.providers.set(binding.providerName, {
          ...f.providers.get(binding.providerName)!,
          revision: { id: binding.providerId, resourceVersion: binding.resourceVersion + 1 },
        }),
      "policy-missing": () => {
        preflight.policy.effectivePolicy.network_policies = {};
      },
      "policy-unavailable": () =>
        preflight.inspectSandboxPolicy.mockRejectedValue(new Error("private-provider-error")),
      "runtime-unavailable": () =>
        preflight.execute.mockImplementation(() => {
          throw new Error("private-runtime-error");
        }),
      "config-drift": () => {
        preflight.runtime.configuration = "4".repeat(64);
      },
      "credentials-missing": () => {
        delete preflight.runtime.credentialReferences[binding.credentialEnv];
      },
    };
    fail[failure as keyof typeof fail]();
    const request = vi.fn(async () => ({ ok: true }));
    const result = await verifySwitchyardRequest(routedEntry, "sandbox", request, observe);
    expect(result).toMatchObject({ ok: false, preflightOk: false, requestSent: false });
    expect(result.detail).toContain("No inference request was sent");
    expect(result.detail).not.toContain("private-");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    "gateway-restart",
    "policy-change",
    "provider-change",
    "credential-change",
    "package-change",
  ])("invalidates an attempted request after %s (#13864)", async (change) => {
    const { routedEntry, observe, f, preflight } = await createSwitchyardReadinessFixture(
      "gateway",
      "sandbox",
    );
    const binding = routedEntry.hermesSwitchyard.bindings.providers[0]!;
    const result = await verifySwitchyardRequest(
      routedEntry,
      "sandbox",
      async () => {
        const mutate = {
          "gateway-restart": () => {
            preflight.runtime.gateway.startTime++;
          },
          "policy-change": () => {
            preflight.policy.policyIdentity.hash = "5".repeat(64);
          },
          "provider-change": () => f.providers.delete(binding.providerName),
          "credential-change": () => {
            preflight.runtime.credentialReferences[binding.credentialEnv] = "6".repeat(64);
          },
          "package-change": () => {
            preflight.runtime.package = "7".repeat(64);
          },
        };
        mutate[change as keyof typeof mutate]();
        return { ok: true };
      },
      observe,
    );
    expect(result).toMatchObject({ ok: false, preflightOk: false, requestSent: true });
    expect(result.detail).toContain("A request was attempted");
    expect(result.detail).not.toContain("No inference request");
  });
  it("does not retry or relabel a failed capable request as a preflight failure (#13864)", async () => {
    const { routedEntry, observe } = await createSwitchyardReadinessFixture("gateway", "sandbox");
    const request = vi.fn(async () => ({ ok: false, detail: "private-provider-response" }));
    const result = await verifySwitchyardRequest(routedEntry, "sandbox", request, observe);
    expect(result).toMatchObject({ ok: false, preflightOk: true, requestSent: true });
    expect(request).toHaveBeenCalledOnce();
    expect(result.detail).not.toContain("private-provider-response");
  });
  it("invalidates gateway health if the process restarts before launch readiness finishes (#13864)", async () => {
    const { routedEntry, observe, preflight } = await createSwitchyardReadinessFixture(
      "gateway",
      "sandbox",
    );
    await expect(
      requireLaunchSemanticHealth(
        "sandbox",
        "gateway",
        "hermes",
        routedEntry,
        loadAgent("hermes")!,
        true,
        {
          switchyardPreflight: observe,
          gatewayHealth: async () => {
            preflight.runtime.gateway.startTime++;
            return true;
          },
          forwardsHealthy: async () => true,
        },
      ),
    ).rejects.toMatchObject({ category: "identity" });
  });
});
