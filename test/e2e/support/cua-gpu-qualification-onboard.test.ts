// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CleanupRegistry } from "../fixtures/cleanup.ts";
import {
  assertCuaQualificationInventoryTransition,
  assertCuaQualificationLocalRegistryAbsent,
  assertCuaQualificationSingletonInventory,
  buildCuaQualificationOnboardEnv,
  collectCuaQualificationOnboardSecretEnv,
  isCuaQualificationGatewayUnavailable,
  parseCuaQualificationOpenShellInventory,
  registerCuaQualificationSandboxCleanup,
  resolveCuaQualificationRegistryPath,
} from "../live/cua-gpu-qualification-onboard.ts";

const tempDirectories: string[] = [];

function sandboxRow(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `sandbox-${name}`,
    name,
    labels: { "openshell.ai/sandbox-name": name },
    resource_version: 1,
    created_at: "2026-08-04T00:00:00Z",
    phase: "Ready",
    current_policy_version: 1,
    ...overrides,
  };
}

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-onboard-"));
  tempDirectories.push(home);
  return home;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("CUA qualification canonical onboarding support", () => {
  it("constructs a minimal explicit onboarding env and redacts credentials and endpoints", () => {
    const secretEnv = collectCuaQualificationOnboardSecretEnv(
      {
        COMPATIBLE_API_KEY: "opaque-compatible-key",
        OPENAI_API_KEY: "must-not-pass",
        NEMOCLAW_ENDPOINT_URL: "https://private.example.test/v1",
        UNRELATED_SECRET: "must-not-pass",
      },
      "custom",
    );
    const result = buildCuaQualificationOnboardEnv({
      baseEnv: {
        HOME: "/tmp/cua-home",
        PATH: "/usr/bin",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        AMBIENT_VALUE: "must-not-pass",
      },
      expectedModel: "provider/model",
      model: "provider/model",
      provider: "custom",
      runtimeEnv: {
        PATH: "/candidate/bin:/usr/bin",
        NEMOCLAW_CUA_ENABLED: "1",
        NEMOCLAW_CUA_QUALIFICATION: "1",
        NEMOCLAW_CUA_RUNTIME_MANIFEST: "/authority/cua-runtime-manifest.json",
        NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256: "a".repeat(64),
        NEMOCLAW_CUA_QUALIFICATION_ENVIRONMENT: "/authority/cua-qualification-environment.json",
        NEMOCLAW_CUA_QUALIFICATION_ARTIFACT_RUNNER:
          "/usr/local/libexec/nemoclaw-cua-qualification-artifact-runner",
        NEMOCLAW_CUA_SANDBOX_IMAGE_REF: `registry.invalid/nemocua@sha256:${"b".repeat(64)}`,
        NEMOCLAW_OPENSHELL_BIN: "/authority/openshell",
      },
      secretEnv,
    });

    expect(result.env).toMatchObject({
      HOME: "/tmp/cua-home",
      PATH: "/candidate/bin:/usr/bin",
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_CUA_ENABLED: "1",
      NEMOCLAW_CUA_QUALIFICATION: "1",
      NEMOCLAW_CUA_RUNTIME_MANIFEST: "/authority/cua-runtime-manifest.json",
      NEMOCLAW_CUA_RUNTIME_MANIFEST_SHA256: "a".repeat(64),
      NEMOCLAW_CUA_QUALIFICATION_ENVIRONMENT: "/authority/cua-qualification-environment.json",
      NEMOCLAW_CUA_QUALIFICATION_ARTIFACT_RUNNER:
        "/usr/local/libexec/nemoclaw-cua-qualification-artifact-runner",
      NEMOCLAW_CUA_SANDBOX_IMAGE_REF: `registry.invalid/nemocua@sha256:${"b".repeat(64)}`,
      NEMOCLAW_ENDPOINT_URL: "https://private.example.test/v1",
      NEMOCLAW_MODEL: "provider/model",
      NEMOCLAW_OPENSHELL_BIN: "/authority/openshell",
      NEMOCLAW_PROVIDER: "custom",
      COMPATIBLE_API_KEY: "opaque-compatible-key",
    });
    expect(result.env.AMBIENT_VALUE).toBeUndefined();
    expect(result.env.OPENAI_API_KEY).toBeUndefined();
    expect(result.env.UNRELATED_SECRET).toBeUndefined();
    expect(result.redactionValues.sort()).toEqual(
      ["https://private.example.test/v1", "opaque-compatible-key"].sort(),
    );
  });

  it("forwards only credentials scoped to the selected provider and its aliases", () => {
    expect(
      collectCuaQualificationOnboardSecretEnv(
        {
          OPENROUTER_API_KEY: "router-key",
          OPENAI_API_KEY: "openai-key",
          NEMOCLAW_ENDPOINT_URL: "https://private.example.test/v1",
        },
        "open-router",
      ),
    ).toEqual({ OPENROUTER_API_KEY: "router-key" });
  });

  it("rejects provider selectors inherited from Object.prototype", () => {
    expect(() => collectCuaQualificationOnboardSecretEnv({}, "constructor")).toThrow(
      "has no qualification credential mapping",
    );
    expect(() =>
      buildCuaQualificationOnboardEnv({
        baseEnv: { NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" },
        expectedModel: "provider/model",
        model: "provider/model",
        provider: "constructor",
        runtimeEnv: {},
        secretEnv: {},
      }),
    ).toThrow("has no qualification credential mapping");
  });

  it("rejects missing consent, receipt-model drift, and non-fixed env inputs", () => {
    const base = {
      baseEnv: { HOME: "/tmp/cua-home", PATH: "/usr/bin" },
      expectedModel: "receipt/model",
      model: "receipt/model",
      provider: "build",
      runtimeEnv: { PATH: "/candidate/bin:/usr/bin" },
      secretEnv: {},
    };
    expect(() => buildCuaQualificationOnboardEnv(base)).toThrow(
      "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1",
    );
    expect(() =>
      buildCuaQualificationOnboardEnv({
        ...base,
        baseEnv: { ...base.baseEnv, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" },
        model: "other/model",
      }),
    ).toThrow("must equal the qualification receipt model");
    expect(() =>
      buildCuaQualificationOnboardEnv({
        ...base,
        baseEnv: { ...base.baseEnv, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" },
        runtimeEnv: { ATTACKER_OVERLAY: "1" },
      }),
    ).toThrow("runtime env does not allow key 'ATTACKER_OVERLAY'");
    expect(() =>
      buildCuaQualificationOnboardEnv({
        ...base,
        baseEnv: { ...base.baseEnv, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" },
        secretEnv: { ATTACKER_SECRET: "secret" },
      }),
    ).toThrow("onboard secretEnv does not allow key 'ATTACKER_SECRET'");
    expect(() =>
      buildCuaQualificationOnboardEnv({
        ...base,
        baseEnv: { ...base.baseEnv, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" },
        provider: "openai=NVIDIA_INFERENCE_API_KEY",
      }),
    ).toThrow("printable credential-free provider coordinate");
  });

  it("fails closed when the requested local registry name already exists", () => {
    const home = tempHome();
    expect(resolveCuaQualificationRegistryPath(home)).toBe(
      path.join(home, ".nemoclaw", "sandboxes.json"),
    );
    assertCuaQualificationLocalRegistryAbsent({ home, sandboxName: "cua-fresh" });
    const directory = path.join(home, ".nemoclaw");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "sandboxes.json"),
      JSON.stringify({ sandboxes: { "cua-fresh": { agent: "nemocua" } } }),
    );
    expect(() =>
      assertCuaQualificationLocalRegistryAbsent({ home, sandboxName: "cua-fresh" }),
    ).toThrow("already exists in the local registry");
  });

  it("rejects malformed registries rather than treating them as absent", () => {
    const home = tempHome();
    const directory = path.join(home, ".nemoclaw");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "sandboxes.json"), "{not-json");
    expect(() =>
      assertCuaQualificationLocalRegistryAbsent({ home, sandboxName: "cua-fresh" }),
    ).toThrow("is not valid JSON");

    fs.rmSync(path.join(directory, "sandboxes.json"));
    fs.writeFileSync(
      path.join(directory, "registry-target.json"),
      JSON.stringify({ sandboxes: {} }),
    );
    fs.symlinkSync(
      path.join(directory, "registry-target.json"),
      path.join(directory, "sandboxes.json"),
    );
    expect(() =>
      assertCuaQualificationLocalRegistryAbsent({ home, sandboxName: "cua-fresh" }),
    ).toThrow();
  });

  it("parses only bounded strict unique OpenShell inventory rows", () => {
    expect(
      parseCuaQualificationOpenShellInventory(JSON.stringify([sandboxRow("cua-fresh")])),
    ).toEqual(["cua-fresh"]);
    expect(() =>
      parseCuaQualificationOpenShellInventory(JSON.stringify([{ name: "cua-fresh" }])),
    ).toThrow("invalid row shape or cardinality");
    expect(() =>
      parseCuaQualificationOpenShellInventory(
        JSON.stringify([sandboxRow("cua-fresh"), sandboxRow("cua-fresh")]),
      ),
    ).toThrow("duplicate sandbox names");
    expect(() => parseCuaQualificationOpenShellInventory("[]\0")).toThrow(
      "exceeded its bounded JSON contract",
    );
  });

  it("requires the post-onboard OpenShell inventory to be the requested singleton", () => {
    expect(() =>
      assertCuaQualificationSingletonInventory(["cua-fresh"], "cua-fresh"),
    ).not.toThrow();
    expect(() =>
      assertCuaQualificationSingletonInventory(["cua-fresh", "nested-cua"], "cua-fresh"),
    ).toThrow("must create exactly one OpenShell sandbox");
    expect(() => assertCuaQualificationSingletonInventory([], "cua-fresh")).toThrow(
      "must create exactly one OpenShell sandbox",
    );
    expect(() =>
      assertCuaQualificationInventoryTransition(
        ["existing"],
        ["cua-fresh", "existing"],
        "cua-fresh",
      ),
    ).not.toThrow();
    expect(() =>
      assertCuaQualificationInventoryTransition(
        ["existing"],
        ["cua-fresh", "existing", "nested-cua"],
        "cua-fresh",
      ),
    ).toThrow("must add only OpenShell sandbox");
  });

  it("accepts only a bounded gateway-unavailable pre-inventory failure", () => {
    expect(
      isCuaQualificationGatewayUnavailable({
        exitCode: 1,
        stderr: "No active gateway",
        stdout: "",
      }),
    ).toBe(true);
    expect(
      isCuaQualificationGatewayUnavailable({
        exitCode: 1,
        stderr: "permission denied",
        stdout: "",
      }),
    ).toBe(false);
    expect(
      isCuaQualificationGatewayUnavailable({
        exitCode: 0,
        stderr: "No active gateway",
        stdout: "",
      }),
    ).toBe(false);
  });

  it("registers public NemoClaw cleanup after the OpenShell fallback so LIFO runs it first", async () => {
    const order: string[] = [];
    const cleanup = new CleanupRegistry();
    registerCuaQualificationSandboxCleanup(cleanup, "cua-fresh", {
      nemoclaw: () => {
        order.push("nemoclaw");
      },
      openshell: () => {
        order.push("openshell");
      },
    });

    const result = await cleanup.runAll();
    expect(result.failures).toEqual([]);
    expect(order).toEqual(["nemoclaw", "openshell"]);
  });
});
