// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { testTimeoutOptions } from "../helpers/timeouts";
import { runConnect, setupFixture } from "./helpers";

describe("sandbox connect inference route swap (#1248)", () => {
  it(
    "skips the vLLM model preflight on connect --probe-only but keeps it for a full connect (#4585)",
    testTimeoutOptions(20_000),
    () => {
      const fixture = setupFixture(
        {
          name: "my-sandbox",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );
      const bogus = { NEMOCLAW_VLLM_MODEL: "definitely-not-a-real-vllm-model" };
      const PREFLIGHT_HINT = "NEMOCLAW_VLLM_MODEL is consumed by";

      // probe-only / recover never install or serve a model, so the express-vLLM
      // model preflight must be skipped rather than hard-exiting the probe.
      const probe = runConnect(fixture.tmpDir, fixture.sandboxName, bogus, ["--probe-only"]);
      const probeOut = (probe.stdout || "") + (probe.stderr || "");
      // probe-only must proceed (not just avoid the hint): a non-zero exit would
      // mean it failed for some other reason before the skipped preflight.
      expect(probe.status).toBe(0);
      expect(probeOut).not.toContain(PREFLIGHT_HINT);

      // A full connect still runs the preflight and fails fast on the bogus value.
      const full = runConnect(fixture.tmpDir, fixture.sandboxName, bogus, []);
      const fullOut = (full.stdout || "") + (full.stderr || "");
      expect(full.status).toBe(1);
      expect(fullOut).toContain(PREFLIGHT_HINT);
    },
  );

  it(
    "swaps inference route when live route does not match sandbox provider",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "my-sandbox",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(1);
      expect(state.inferenceSetCalls[0]).toEqual([
        "--provider",
        "anthropic-prod",
        "--model",
        "claude-sonnet-4-20250514",
        "--no-verify",
      ]);

      // Override must be loud (#3726), not a silent status-style line.
      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("differs from the recorded route");
      expect(combined).toContain(
        "Aligning the gateway to anthropic-prod/claude-sonnet-4-20250514",
      );
    },
  );

  it(
    "warns and aligns the route even in --probe-only quiet mode (#3726)",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "probe-diverged-sandbox",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName, {}, ["--probe-only"]);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("differs from the recorded route");
      expect(combined).toContain(
        "Aligning the gateway to anthropic-prod/claude-sonnet-4-20250514",
      );
      expect(state.inferenceSetCalls).toContainEqual([
        "--provider",
        "anthropic-prod",
        "--model",
        "claude-sonnet-4-20250514",
        "--no-verify",
      ]);
      expect(state.sandboxConnectCalls).toEqual([]);
    },
  );

  it(
    "does not swap inference route for legacy sandbox without provider",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "legacy-sandbox",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(0);
    },
  );

  it(
    "does not swap when live route already matches sandbox provider",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "matched-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(0);
    },
  );

  it(
    "repairs the kubernetes sandbox DNS proxy when inference.local returns 503",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "stale-dns-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          openshellDriver: "kubernetes",
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"inference service unavailable"}',
            "OK 200",
          ],
        },
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const dockerCalls = state.dockerCalls as string[][];
      const inferenceExecCalls = state.sandboxExecCalls.filter(
        (call: string[]) =>
          JSON.stringify(call).includes("inference.local/v1/models"),
      );
      expect(state.inferenceSetCalls.length).toBe(0);
      expect(inferenceExecCalls.length).toBe(2);
      expect(
        dockerCalls.some((call) =>
          call.join(" ").includes("get service kube-dns"),
        ),
      ).toBe(true);
      expect(
        dockerCalls.some((call) =>
          call.join(" ").includes("get endpoints kube-dns"),
        ),
      ).toBe(false);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain(
        "inference.local is unavailable inside 'stale-dns-sandbox'",
      );
      expect(combined).toContain("inference.local route repaired");
    },
  );
});
