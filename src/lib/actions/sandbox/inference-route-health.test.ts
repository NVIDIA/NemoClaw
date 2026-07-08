// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { probeSandboxInferenceGatewayHealth } from "./inference-route-health";

describe("sandbox inference route health", () => {
  const makeCapture =
    (output: string, status = 0) =>
    async () =>
      ({ status, output }) as never;

  it("reports a reachable route for final HTTP responses", async () => {
    for (const httpStatus of [200, 401, 403]) {
      const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
        captureOpenshellImpl: makeCapture(`OK ${httpStatus}`),
      });

      expect(result).toMatchObject({
        ok: true,
        httpStatus,
        endpoint: "https://inference.local/v1/models",
      });
      expect(result?.detail).toContain("full chain reachable");
    }
  });

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
        "--",
        "/usr/local/lib/nemoclaw/dcode-managed-exec",
        "/bin/sh",
        "-c",
        expect.stringContaining("/usr/bin/curl -q"),
      ],
      expect.objectContaining({ ignoreError: true }),
    );
  });
});
