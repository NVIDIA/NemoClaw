// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  DCODE_MANAGED_EXEC_LAUNCHER,
  DCODE_MANAGED_EXEC_MISSING_DETAIL,
} from "./connect-inference-route-probe";
import {
  buildSandboxInferenceRouteHealth,
  probeSandboxInferenceGatewayHealth,
  type SandboxInferenceRouteHealth,
} from "./inference-route-health";

describe("sandbox inference route health", () => {
  const makeCapture =
    (output: string, status = 0) =>
    async () =>
      ({ status, output }) as never;

  it.each([200, 401, 403])(
    "reports a reachable route for final HTTP responses [case %#]",
    async (httpStatus) => {
      const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
        captureOpenshellImpl: makeCapture(`OK ${httpStatus}`),
      });

      expect(result).toMatchObject({
        ok: true,
        httpStatus,
        endpoint: "https://inference.local/v1/models",
      });
      expect(result?.detail).toContain("full chain reachable");
    },
  );

  it("reports HTTP 5xx as an unhealthy authoritative route (#6192)", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      captureOpenshellImpl: makeCapture("BROKEN 503"),
    });

    expect(result).toMatchObject({ ok: false, httpStatus: 503 });
    expect(result?.detail).toContain("reachable but unhealthy");
  });

  it("reports transport status 000 as unreachable", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      captureOpenshellImpl: makeCapture("BROKEN 000"),
    });

    expect(result).toMatchObject({ ok: false, httpStatus: 0 });
    expect(result?.detail).toContain("unreachable");
  });

  it("returns null when the authoritative probe is unavailable (#6192)", async () => {
    await expect(
      probeSandboxInferenceGatewayHealth("my-sandbox", {
        captureOpenshellImpl: makeCapture("transport unavailable", 1),
      }),
    ).resolves.toBeNull();
    await expect(
      probeSandboxInferenceGatewayHealth("my-sandbox", {
        captureOpenshellImpl: async () => {
          throw new Error("openshell unavailable");
        },
      }),
    ).resolves.toBeNull();
  });

  it("uses the DCode agent path while reporting observable route health (#6192)", async () => {
    const captureOpenshellImpl = vi.fn(makeCapture("OK 200"));
    const getSessionAgentImpl = vi.fn(() => ({ name: "langchain-deepagents-code" }) as never);

    const result = await probeSandboxInferenceGatewayHealth("deep-code", {
      captureOpenshellImpl,
      gatewayName: "recorded-gateway",
      getSessionAgentImpl,
    });

    expect(result).toMatchObject({ ok: true, httpStatus: 200 });
    expect(getSessionAgentImpl).toHaveBeenCalledWith("deep-code");
    expect(captureOpenshellImpl).toHaveBeenCalledWith(
      [
        "sandbox",
        "exec",
        "--name",
        "deep-code",
        "-g",
        "recorded-gateway",
        "--no-tty",
        "--env",
        "HOME=/usr/local/lib/nemoclaw",
        "--env",
        "BASH_ENV=",
        "--env",
        "ENV=",
        "--",
        "/usr/local/lib/nemoclaw/dcode-managed-exec",
        "/bin/sh",
        "-c",
        expect.stringContaining("/usr/bin/curl -q"),
      ],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("reports missing DCode helper as a failed compatibility boundary (#6192)", async () => {
    const result = await probeSandboxInferenceGatewayHealth("deep-code", {
      captureOpenshellImpl: makeCapture(`exec: ${DCODE_MANAGED_EXEC_LAUNCHER}: not found`, 127),
      getSessionAgentImpl: () => ({ name: "langchain-deepagents-code" }) as never,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 0,
      endpoint: "https://inference.local/v1/models",
      detail: DCODE_MANAGED_EXEC_MISSING_DETAIL,
    });
  });
});

describe("buildSandboxInferenceRouteHealth (#10080)", () => {
  const gateway = (httpStatus: number, ok = true): SandboxInferenceRouteHealth => ({
    ok,
    endpoint: "https://inference.local/v1/models",
    httpStatus,
    detail: `probe returned ${httpStatus}`,
  });

  it("fails closed for a non-DCode agent when the route 404s, even if invocation succeeds", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(404),
      null,
      { ok: true },
      {
        agentName: "openclaw",
        provider: "openrouter-api",
      },
    );

    expect(result.ok).toBe(false);
    expect(result.failureLabel).toBe("unreachable");
    expect(result.detail).toContain("never validated against a model catalog");
  });

  it("fails closed for a non-DCode agent when the route 404s and invocation was never attempted", () => {
    const result = buildSandboxInferenceRouteHealth(gateway(404), null, null, {
      agentName: "openclaw",
      provider: "openrouter-api",
    });

    expect(result.ok).toBe(false);
    expect(result.okLabel).toBeUndefined();
    expect(result.failureLabel).toBe("unreachable");
  });

  it("fails closed for Deep Agents Code on OpenRouter when no invocation was attempted", () => {
    const result = buildSandboxInferenceRouteHealth(gateway(404), null, null, {
      agentName: "langchain-deepagents-code",
      provider: "openrouter-api",
    });

    expect(result.ok).toBe(false);
    expect(result.okLabel).toBeUndefined();
    expect(result.detail).toContain("no inference request confirmed the selected model");
  });

  it("fails closed for Deep Agents Code on OpenRouter when the invocation fails", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(404),
      null,
      { ok: false, detail: "provider rejected the request", httpStatus: 401 },
      {
        agentName: "langchain-deepagents-code",
        provider: "openrouter-api",
      },
    );

    expect(result.ok).toBe(false);
  });

  it("still tolerates a 404 for Deep Agents Code on OpenRouter when invocation succeeds", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(404),
      null,
      { ok: true },
      {
        agentName: "langchain-deepagents-code",
        provider: "openrouter-api",
      },
    );

    expect(result.ok).toBe(true);
  });

  it("normalizes the provider before matching the Deep Agents Code 404 exception", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(404),
      null,
      { ok: true },
      {
        agentName: "langchain-deepagents-code",
        provider: " openrouter-api ",
      },
    );

    expect(result.ok).toBe(true);
  });

  it("does not extend the DCode 404 tolerance to a different provider", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(404),
      null,
      { ok: true },
      {
        agentName: "langchain-deepagents-code",
        provider: "nvidia-nim",
      },
    );

    expect(result.ok).toBe(false);
  });

  it.each([401, 403])(
    "keeps a credential-gated HTTP %s route healthy when the invocation succeeds (#6192)",
    (httpStatus) => {
      const result = buildSandboxInferenceRouteHealth(
        gateway(httpStatus),
        null,
        { ok: true },
        { agentName: "openclaw", provider: "openrouter-api" },
      );

      expect(result.ok).toBe(true);
    },
  );

  it.each([401, 403])(
    "fails a credential-gated HTTP %s route when the invocation fails (#6192)",
    (httpStatus) => {
      const result = buildSandboxInferenceRouteHealth(
        gateway(httpStatus),
        null,
        { ok: false, detail: "provider rejected the request", httpStatus },
        { agentName: "openclaw", provider: "openrouter-api" },
      );

      expect(result.ok).toBe(false);
    },
  );

  it.each([302, 400, 405, 410, 429])(
    "fails closed for HTTP %s when an inference request succeeds",
    (httpStatus) => {
      const result = buildSandboxInferenceRouteHealth(
        gateway(httpStatus),
        null,
        { ok: true },
        { agentName: "openclaw", provider: "openrouter-api" },
      );

      expect(result.ok).toBe(false);
      expect(result.failureLabel).toBe("unreachable");
    },
  );

  it("leaves a strictly healthy 2xx route unaffected for any agent", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(200),
      null,
      { ok: true },
      {
        agentName: "openclaw",
        provider: "openrouter-api",
      },
    );

    expect(result.ok).toBe(true);
  });
});
