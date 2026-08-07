// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../state/registry/types";
import type { CuaRuntimeReadiness } from "./contract";
import { CUA_FRAMEWORK_FEATURE_ENV, CUA_QUALIFICATION_FEATURE_ENV } from "./feature";
import {
  observeCuaLiveInference,
  parseCuaAppliedPolicyIdentity,
  parseCuaProviderAuthorityDigest,
  requireCuaLifecycleReadiness,
} from "./lifecycle-readiness";
import type { CuaRuntimeReadinessContext } from "./runtime-readiness";

const readiness = { kind: "runtime-readiness" } as CuaRuntimeReadiness;

function entry(): SandboxEntry {
  return {
    name: "alpha",
    agent: "nemocua",
    provider: "recorded-provider",
    model: "recorded/model",
    endpointUrl: "https://inference.example/v1",
    endpointSource: "onboard",
    preferredInferenceApi: "openai-completions",
    credentialEnv: "NVIDIA_API_KEY",
    cuaRuntimeReadiness: readiness,
  };
}

describe("CUA lifecycle readiness authority", () => {
  const providerOutput = (
    overrides: {
      id?: string;
      version?: number;
      name?: string;
      type?: string;
      credentialKeys?: string;
      configKeys?: string;
    } = {},
  ) =>
    [
      "Provider:",
      `  Id: ${overrides.id ?? "provider-id"}`,
      `  Name: ${overrides.name ?? "recorded-provider"}`,
      `  Type: ${overrides.type ?? "openai"}`,
      `  Resource version: ${String(overrides.version ?? 1)}`,
      `  Credential keys: ${overrides.credentialKeys ?? "NVIDIA_API_KEY"}`,
      `  Config keys: ${overrides.configKeys ?? "OPENAI_BASE_URL"}`,
    ].join("\n");

  it("binds the opaque authority digest to the exact live provider generation", () => {
    const input = {
      gatewayName: "nemoclaw-alpha",
      providerName: "recorded-provider",
      model: "recorded/model",
    };
    const current = parseCuaProviderAuthorityDigest({
      ...input,
      output: providerOutput(),
    });

    expect(current).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      parseCuaProviderAuthorityDigest({
        ...input,
        output: providerOutput({ version: 2 }),
      }),
    ).not.toBe(current);
    expect(
      parseCuaProviderAuthorityDigest({
        ...input,
        output: providerOutput({ id: "replacement-provider" }),
      }),
    ).not.toBe(current);
    expect(
      parseCuaProviderAuthorityDigest({
        ...input,
        output: providerOutput({ configKeys: "OPENAI_BASE_URL, EXTRA_CONFIG" }),
      }),
    ).not.toBe(current);
  });

  it.each([
    ["missing version", providerOutput().replace(/^.*Resource version:.*\n?/mu, "")],
    ["duplicate id", `${providerOutput()}\nId: duplicate`],
    ["unknown semantic field", `${providerOutput()}\nEndpoint: https://hidden.invalid`],
    ["control in id", providerOutput({ id: "provider\u0007id" })],
    ["ANSI in id value", providerOutput({ id: "provider\u001b[31mid" })],
    ["oversized output", `${providerOutput()}\n${"x".repeat(64 * 1024)}`],
  ])("rejects a %s provider observation", (_label, output) => {
    expect(() =>
      parseCuaProviderAuthorityDigest({
        gatewayName: "nemoclaw-alpha",
        providerName: "recorded-provider",
        model: "recorded/model",
        output,
      }),
    ).toThrow("provider identity is unavailable");
  });

  it("projects only the exact effective OpenShell policy revision and digest", () => {
    const output = JSON.stringify({
      active_version: 17,
      config_revision: 23,
      hash: `sha256:${"b".repeat(64)}`,
      policy_source: "sandbox",
      sandbox: "alpha",
      status: "effective",
      version: 17,
    });

    expect(parseCuaAppliedPolicyIdentity({ sandboxName: "alpha", output })).toEqual({
      revision: 17,
      digest: `sha256:${"b".repeat(64)}`,
    });
  });

  it.each([
    ["wrong sandbox", { sandbox: "beta" }],
    ["inactive revision", { active_version: 16 }],
    ["non-effective status", { status: "pending" }],
    ["mutable policy source", { policy_source: "gateway" }],
    ["invalid digest", { hash: "sha256:mutable" }],
    ["unknown authority field", { endpoint: "https://hidden.invalid" }],
  ])("rejects %s in the live applied-policy observation", (_label, override) => {
    const output = JSON.stringify({
      active_version: 17,
      config_revision: 23,
      hash: `sha256:${"b".repeat(64)}`,
      policy_source: "sandbox",
      sandbox: "alpha",
      status: "effective",
      version: 17,
      ...override,
    });

    expect(() => parseCuaAppliedPolicyIdentity({ sandboxName: "alpha", output })).toThrow(
      "applied CUA policy identity is unavailable",
    );
  });

  it("binds validation to the live route while preserving durable route metadata", () => {
    const validate = vi.fn((_value: unknown, _context: CuaRuntimeReadinessContext) => readiness);

    expect(
      requireCuaLifecycleReadiness(entry(), {
        env: {
          [CUA_FRAMEWORK_FEATURE_ENV]: "1",
          [CUA_QUALIFICATION_FEATURE_ENV]: "1",
        },
        observeLiveInference: () => ({
          provider: "live-provider",
          model: "live/model",
          providerAuthorityDigest: `sha256:${"a".repeat(64)}`,
        }),
        observeLiveAppliedPolicy: () => ({
          revision: 17,
          digest: `sha256:${"b".repeat(64)}`,
        }),
        validateRuntimeReadiness: validate,
      }),
    ).toBe(readiness);

    expect(validate).toHaveBeenCalledWith(
      readiness,
      expect.objectContaining({
        agentName: "nemocua",
        acceptance: "candidate-qualification",
        recordedInference: expect.objectContaining({
          provider: "recorded-provider",
          endpointUrl: "https://inference.example/v1",
        }),
        liveInference: expect.objectContaining({
          provider: "live-provider",
          model: "live/model",
          endpointUrl: "https://inference.example/v1",
          credentialEnv: "NVIDIA_API_KEY",
        }),
        liveProviderAuthorityDigest: `sha256:${"a".repeat(64)}`,
      }),
    );
  });

  it("allows candidate lifecycle authority only in the dedicated qualification mode", () => {
    const validate = vi.fn((_value: unknown, _context: CuaRuntimeReadinessContext) => readiness);
    const env = {
      [CUA_FRAMEWORK_FEATURE_ENV]: "1",
      [CUA_QUALIFICATION_FEATURE_ENV]: "1",
    };

    requireCuaLifecycleReadiness(entry(), {
      env,
      observeLiveInference: () => ({
        provider: "recorded-provider",
        model: "recorded/model",
        providerAuthorityDigest: `sha256:${"a".repeat(64)}`,
      }),
      observeLiveAppliedPolicy: () => ({
        revision: 17,
        digest: `sha256:${"b".repeat(64)}`,
      }),
      validateRuntimeReadiness: validate,
    });

    expect(validate.mock.calls[0]?.[1]).toMatchObject({
      acceptance: "candidate-qualification",
      env,
    });
  });

  it("rejects a sandbox that has no stored readiness before observing external state", () => {
    const sandbox = entry();
    delete sandbox.cuaRuntimeReadiness;
    const observeLiveInference = vi.fn();

    expect(() => requireCuaLifecycleReadiness(sandbox, { observeLiveInference })).toThrow(
      "CUA runtime readiness is unavailable",
    );
    expect(observeLiveInference).not.toHaveBeenCalled();
  });

  it("rejects malformed stored OpenShell authority before spawning a command (#7755)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-no-spawn-"));
    const marker = path.join(directory, "spawned");
    const executable = path.join(directory, "openshell");
    fs.writeFileSync(executable, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const sandbox = entry();
    sandbox.cuaRuntimeReadiness = {
      kind: "runtime-readiness",
      components: {},
    } as unknown as CuaRuntimeReadiness;

    try {
      expect(() => observeCuaLiveInference(sandbox, { openshellBinary: executable })).toThrow();
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
