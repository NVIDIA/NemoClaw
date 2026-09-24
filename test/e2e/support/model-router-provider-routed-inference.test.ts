// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";

import {
  buildProviderRoutedEnv,
  retainRouterDiagnostics,
} from "../live/model-router-provider-routed-inference-helpers.ts";

describe("Model Router provider-routed live support", () => {
  it("builds the routed onboard environment with both NVIDIA credential names", () => {
    expect(buildProviderRoutedEnv("nvapi-public-test-key", "e2e-router", {})).toMatchObject({
      NVIDIA_INFERENCE_API_KEY: "nvapi-public-test-key",
      NEMOCLAW_PROVIDER_KEY: "nvapi-public-test-key",
      NEMOCLAW_POLICY_MODE: "skip",
      NEMOCLAW_PROVIDER: "routed",
      NEMOCLAW_SANDBOX_NAME: "e2e-router",
    });
  });

  it("retains router status without request text or credentials", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-diagnostics-"));
    try {
      const log = path.join(directory, "router.log");
      await fs.writeFile(
        log,
        [
          "Model Router Toolkit: strategy registered in 1.0s",
          "Warmup route : model",
          '127.0.0.1 - "POST /v1/chat/completions HTTP/1.1" 200 OK',
          "TimeoutError: private request text; Authorization: Bearer arbitrary-secret",
        ].join("\n"),
      );
      const sink = new ArtifactSink(path.join(directory, "artifacts"));
      await retainRouterDiagnostics(sink, log);
      const retained = JSON.parse(
        await fs.readFile(sink.pathFor("router-diagnostics.json"), "utf8"),
      );
      expect(retained).toEqual({
        available: true,
        truncated: false,
        strategyRegistered: true,
        warmupCompleted: true,
        warmupFailed: false,
        strategyInjectionFailed: false,
        timeoutReported: true,
        authenticationErrorReported: false,
        rateLimitReported: false,
        connectionErrorReported: false,
        completionResponses: 1,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds router log reads to the final 64 KiB", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-diagnostics-"));
    try {
      const sink = new ArtifactSink(path.join(directory, "artifacts"));
      const log = path.join(directory, "router.log");
      await fs.writeFile(log, `AuthenticationError${"x".repeat(70_000)}RateLimitError`);
      await retainRouterDiagnostics(sink, log);
      expect(
        JSON.parse(await fs.readFile(sink.pathFor("router-diagnostics.json"), "utf8")),
      ).toMatchObject({
        available: true,
        truncated: true,
        authenticationErrorReported: false,
        rateLimitReported: true,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { kind: "symlink", prepare: (log: string, directory: string) => fs.symlink(directory, log) },
    { kind: "missing", prepare: async (_log: string, _directory: string) => {} },
    { kind: "directory", prepare: (log: string, _directory: string) => fs.mkdir(log) },
  ])("reports a $kind log as unavailable without error text", async ({ prepare }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "router-diagnostics-"));
    try {
      const sink = new ArtifactSink(path.join(directory, "artifacts"));
      const log = path.join(directory, "router.log");
      await prepare(log, directory);
      await retainRouterDiagnostics(sink, log);
      expect(
        JSON.parse(await fs.readFile(sink.pathFor("router-diagnostics.json"), "utf8")),
      ).toEqual({ available: false });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
