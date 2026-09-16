// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { SANDBOX_BUILD_CONTEXT_PREFIX } from "../sandbox/build-context";
import { prebuildSandboxImageIfEligible } from "./sandbox-prebuild";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["connection refusal", () => Promise.reject(new Error("connection refused"))],
  ["timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
  ["HTTP failure", () => Promise.resolve(new Response(null, { status: 503 }))],
  ["authentication required", () => Promise.resolve(new Response(null, { status: 401 }))],
  ["redirect", () => Promise.resolve(new Response(null, { status: 302 }))],
] as const)(
  "refuses a Portable build after registry %s (#11724)",
  /** Verify failed readiness probes stop image building and publication. */
  async (_condition, probe) => {
    const fetchRegistry = vi.spyOn(globalThis, "fetch").mockImplementation(probe);
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
    const dockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM scratch\n");
    const buildImage = vi.fn(async () => 0);
    const publishImage = vi.fn(async () => 125);
    try {
      await expect(
        prebuildSandboxImageIfEligible({
          buildCtx,
          buildId: "registry-reachability",
          createArgs: ["--from", dockerfile, "--name", "alpha"],
          sandboxName: "alpha",
          dockerDriverGateway: true,
          origin: "generated",
          env: {
            NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
            NEMOCLAW_SANDBOX_PREBUILD: "1",
          },
          buildImage,
          publishImage,
          log: () => undefined,
        }),
      ).rejects.toThrow(/registry/i);
      expect(buildImage.mock.calls.length).toBe(0);
      expect(publishImage.mock.calls.length).toBe(0);
      expect(fetchRegistry).toHaveBeenCalledWith(new URL("http://localhost:5000/v2/"), {
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
    } finally {
      fs.rmSync(buildCtx, { recursive: true, force: true });
    }
  },
);
