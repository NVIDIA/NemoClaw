// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { ProviderHealthStatus } from "../../inference/health";
import { collectInferenceChecks, collectManagedLlamaCppDoctorChecks } from "./doctor-inference";

const endpoint = "https://inference.local/v1/models";

function gateway(ok: boolean, httpStatus = ok ? 200 : 0) {
  return {
    ok,
    endpoint,
    httpStatus,
    detail: ok
      ? `Inference gateway responded HTTP ${httpStatus} on ${endpoint} (full chain reachable).`
      : httpStatus >= 500 && httpStatus < 600
        ? `Inference gateway returned HTTP ${httpStatus} on ${endpoint}; the route is reachable but unhealthy.`
        : `Inference gateway unreachable on ${endpoint} from inside the sandbox.`,
  };
}

function upstream(overrides: Partial<ProviderHealthStatus> = {}): ProviderHealthStatus {
  return {
    ok: true,
    probed: true,
    providerLabel: "NVIDIA Endpoints",
    endpoint: "https://integrate.api.nvidia.com/v1/models",
    detail: "upstream reachable",
    ...overrides,
  };
}

describe("doctor inference checks", () => {
  it.each([
    ["nvidia-prod", "nvidia/nemotron", "ok"],
    ["nvidia-prod", "unknown", "warn"],
    ["unknown", "nvidia/nemotron", "warn"],
    ["unknown", "unknown", "warn"],
  ] as const)("reports %s / %s inference route as %s (#9435)", async (provider, model, status) => {
    const checks = await collectInferenceChecks("alpha", { provider, model }, false, {
      probeProviderHealthImpl: () => null,
      includeServingProcessCheck: false,
    });

    expect(checks[0]).toEqual({
      group: "Inference",
      label: "Route",
      status,
      detail: `${provider} / ${model}`,
      hint:
        status === "ok" ? undefined : "run `nemoclaw alpha status` after the gateway is healthy",
    });
  });

  it.each([
    ["running", "ok", false],
    ["preparing", "warn", true],
    ["stopped", "warn", true],
    ["absent", "fail", true],
    ["conflict", "fail", true],
    ["unknown", "fail", true],
  ] as const)(
    "maps managed llama.cpp %s to an actionable %s diagnostic",
    (state, status, hinted) => {
      const checks = collectManagedLlamaCppDoctorChecks("spark-agent", 7443, {
        inspectManagedLlamaCppStatusImpl: vi.fn(() => ({
          recipeId: "llama-cpp.nemotron.spark.v1",
          modelDigest: state === "preparing" ? null : `sha256:${"a".repeat(64)}`,
          imageReference:
            state === "preparing"
              ? null
              : `ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:${"b".repeat(64)}`,
          endpoint: "https://inference.local/v1" as const,
          state,
          detail: `${state} managed runtime`,
        })),
      });

      expect(checks).toHaveLength(2);
      expect(checks[1]).toMatchObject({
        label: "Managed llama.cpp runtime",
        status,
        detail: `${state}: ${state} managed runtime; endpoint https://inference.local/v1`,
        ...(hinted
          ? { hint: "re-run `nemoclaw onboard` for 'spark-agent' to recover the exact runtime" }
          : {}),
      });
      expect(checks[1]?.hint).toBe(
        hinted
          ? "re-run `nemoclaw onboard` for 'spark-agent' to recover the exact runtime"
          : undefined,
      );
    },
  );

  it("makes a broken inference.local route authoritative over a healthy upstream (#6192)", async () => {
    const checks = await collectInferenceChecks(
      "alpha",
      { provider: "nvidia-prod", model: "nvidia/nemotron" },
      true,
      {
        probeProviderHealthImpl: () => upstream(),
        probeSandboxInferenceGatewayHealthImpl: async () => gateway(false),
      },
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Inference route (gateway)", status: "fail" }),
        expect.objectContaining({ label: "Provider health (upstream)", status: "ok" }),
      ]),
    );
  });

  it("keeps failed upstream health diagnostic when inference.local works (#6192)", async () => {
    const checks = await collectInferenceChecks(
      "alpha",
      { provider: "nvidia-prod", model: "nvidia/nemotron" },
      true,
      {
        probeProviderHealthImpl: () =>
          upstream({ ok: false, detail: "upstream failed", failureLabel: "unreachable" }),
        probeSandboxInferenceGatewayHealthImpl: async () => gateway(true),
      },
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Inference route (gateway)", status: "ok" }),
        expect.objectContaining({ label: "Provider health (upstream)", status: "info" }),
      ]),
    );
    expect(checks.filter((check) => check.status === "fail")).toEqual([]);
  });

  it("keeps inference.local authoritative when the upstream diagnostic throws (#6192)", async () => {
    const checks = await collectInferenceChecks(
      "alpha",
      { provider: "nvidia-prod", model: "nvidia/nemotron" },
      true,
      {
        probeProviderHealthImpl: () => {
          throw new Error("upstream probe crashed");
        },
        probeSandboxInferenceGatewayHealthImpl: async () => gateway(true),
      },
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Inference route (gateway)", status: "ok" }),
        expect.objectContaining({
          label: "Provider health (upstream)",
          status: "info",
          detail: "direct provider health probe could not run",
        }),
      ]),
    );
  });

  it.each(["nvidia-router", "hermes-provider"])(
    "probes inference.local for %s without a direct health check (#6192)",
    async (provider) => {
      const routeProbe = vi.fn(async () => gateway(false));
      const checks = await collectInferenceChecks("alpha", { provider, model: "model" }, true, {
        gatewayName: "recorded-gateway",
        probeProviderHealthImpl: () => null,
        probeSandboxInferenceGatewayHealthImpl: routeProbe,
      });

      expect(routeProbe).toHaveBeenCalledWith("alpha", { gatewayName: "recorded-gateway" });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "Inference route (gateway)", status: "fail" }),
          expect.objectContaining({ label: "Provider health (upstream)", status: "info" }),
        ]),
      );
    },
  );

  it("reports an HTTP 503 inference.local route as unhealthy (#6192)", async () => {
    const checks = await collectInferenceChecks(
      "alpha",
      { provider: "nvidia-prod", model: "model" },
      true,
      {
        probeProviderHealthImpl: () => upstream(),
        probeSandboxInferenceGatewayHealthImpl: async () => gateway(false, 503),
      },
    );

    expect(checks).toContainEqual(
      expect.objectContaining({
        label: "Inference route (gateway)",
        status: "fail",
        detail: expect.stringContaining("503"),
      }),
    );
  });

  it.each(["null", "throw"])(
    "fails closed when the inference.local probe is unavailable (%s) (#6192)",
    async (failureMode) => {
      const checks = await collectInferenceChecks(
        "alpha",
        { provider: "nvidia-prod", model: "model" },
        true,
        {
          probeProviderHealthImpl: () => upstream(),
          probeSandboxInferenceGatewayHealthImpl:
            failureMode === "throw"
              ? async () => {
                  throw new Error("openshell unavailable");
                }
              : async () => null,
        },
      );

      expect(checks).toContainEqual(
        expect.objectContaining({
          label: "Inference route (gateway)",
          status: "fail",
          detail: expect.stringContaining("Could not probe"),
        }),
      );
    },
  );

  it("keeps serving-process health explicitly unchecked until a probe contract exists (#7003)", async () => {
    const checks = await collectInferenceChecks(
      "alpha",
      { provider: "nvidia-prod", model: "model" },
      true,
      {
        probeProviderHealthImpl: () => upstream(),
        probeSandboxInferenceGatewayHealthImpl: async () => gateway(true),
      },
    );

    expect(checks).toContainEqual(
      expect.objectContaining({
        label: "Serving process",
        status: "info",
        detail: "not checked — serving-process probing is not implemented",
      }),
    );
  });

  it("omits serving-process health for terminal agents without a gateway process (#7003)", async () => {
    const checks = await collectInferenceChecks(
      "alpha",
      { provider: "nvidia-prod", model: "model" },
      true,
      {
        probeProviderHealthImpl: () => upstream(),
        probeSandboxInferenceGatewayHealthImpl: async () => gateway(true),
        includeServingProcessCheck: false,
      },
    );

    expect(checks).not.toContainEqual(expect.objectContaining({ label: "Serving process" }));
  });

  it("does not mutate direct provider health while adding route evidence", async () => {
    const providerHealth = upstream();

    await collectInferenceChecks("alpha", { provider: "nvidia-prod", model: "model" }, true, {
      probeProviderHealthImpl: () => providerHealth,
      probeSandboxInferenceGatewayHealthImpl: async () => gateway(true),
    });

    expect(providerHealth).not.toHaveProperty("subprobes");
    expect(providerHealth).not.toHaveProperty("probeLabel");
  });

  it("passes the live route model to direct provider diagnostics", async () => {
    const probe = vi.fn(() => upstream());

    await collectInferenceChecks(
      "alpha",
      { provider: "ollama-local", model: "nemotron-mini:latest" },
      true,
      {
        probeProviderHealthImpl: probe,
        probeSandboxInferenceGatewayHealthImpl: async () => gateway(true),
      },
    );

    expect(probe).toHaveBeenCalledWith("ollama-local", { model: "nemotron-mini:latest" });
  });
});
