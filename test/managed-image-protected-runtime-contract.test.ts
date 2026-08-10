// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { managedStartupE2eProfile } from "../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  MANAGED_IMAGE_LOCAL_INFERENCE_KINDS,
  MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX,
  managedImageProtectedSandboxName,
  PROTECTED_MANAGED_IMAGE_AGENTS,
  resolveManagedImageLocalInferenceRoute,
  withManagedImageLocalInferenceProfile,
} from "../scripts/checks/managed-image-protected-runtime-contract.ts";
import {
  managedImageLocalInferenceBaseUrl,
  managedImageOpenShellBasePolicyPath,
  managedImageOpenShellCommittedProbe,
  managedImageOpenShellProbe,
  parseManagedImageOpenShellE2eInputs,
  removeManagedImageGatewayStateIfSafe,
  resolveManagedImageOnboardModule,
} from "../scripts/checks/run-managed-image-openshell-e2e.ts";

const IMAGE = `localhost:5000/nemoclaw-managed-protected/openclaw@sha256:${"a".repeat(64)}`;
const VALID_SANDBOX = "managed-openclaw";

describe("protected managed-image runtime contract", () => {
  it("loads every OpenShell operation required before protected image launch (#7744)", async () => {
    const onboard = resolveManagedImageOnboardModule(await import("../src/lib/onboard.ts"));

    for (const operation of [
      "openshellArgv",
      "runOpenshell",
      "runCaptureOpenshell",
      "sleepSeconds",
      "startGatewayForRecovery",
    ] as const) {
      expect(onboard[operation], operation).toBeTypeOf("function");
    }
  });

  it("rejects a missing protected OpenShell operation with a precise contract error (#8759)", () => {
    expect(() =>
      resolveManagedImageOnboardModule({
        default: {
          openshellArgv: () => [],
          runCaptureOpenshell: () => "",
          sleepSeconds: () => undefined,
          startGatewayForRecovery: async () => undefined,
        },
      }),
    ).toThrow("managed-image onboard module is missing required operation(s): runOpenshell");
  });

  it.each([
    ["unknown ownership", { failed: [], ownershipFailures: ["status cannot be proven"] }, 0],
    ["denied signal", { failed: [9_999_601], ownershipFailures: [] }, 0],
    ["failed gateway removal", { failed: [], ownershipFailures: [] }, 1],
  ])("retains gateway evidence after %s (#7744)", (_case, gatewayStop, removalStatus) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-state-retain-"));
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, "9999601\n");

    try {
      expect(removeManagedImageGatewayStateIfSafe(stateDir, gatewayStop, removalStatus)).toBe(
        false,
      );
      expect(fs.readFileSync(pidFile, "utf8")).toBe("9999601\n");
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("removes gateway state only after scoped stop and gateway removal succeed (#7744)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-state-remove-"));
    fs.writeFileSync(path.join(stateDir, "openshell-gateway.pid"), "9999601\n");

    expect(
      removeManagedImageGatewayStateIfSafe(stateDir, { failed: [], ownershipFailures: [] }, 0),
    ).toBe(true);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it("assigns every protected agent and route a unique OpenShell-compatible sandbox name (#8497)", () => {
    const routeKinds = [...MANAGED_IMAGE_LOCAL_INFERENCE_KINDS, "rollback"] as const;
    const qualifications = PROTECTED_MANAGED_IMAGE_AGENTS.flatMap((agent) =>
      routeKinds.map((routeKind) => ({
        agent,
        sandbox: managedImageProtectedSandboxName(agent, routeKind),
      })),
    );
    const names = qualifications.map(({ sandbox }) => sandbox);

    expect(names).toEqual([
      "nmc-mi-oc-lc",
      "nmc-mi-oc-ol",
      "nmc-mi-oc-ni",
      "nmc-mi-oc-vl",
      "nmc-mi-oc-rb",
      "nmc-mi-he-lc",
      "nmc-mi-he-ol",
      "nmc-mi-he-ni",
      "nmc-mi-he-vl",
      "nmc-mi-he-rb",
      "nmc-mi-dc-lc",
      "nmc-mi-dc-ol",
      "nmc-mi-dc-ni",
      "nmc-mi-dc-vl",
      "nmc-mi-dc-rb",
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const { agent, sandbox: name } of qualifications) {
      expect(name.startsWith(MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(19);
      expect(name).not.toContain("--");
      expect(
        parseManagedImageOpenShellE2eInputs(["--agent", agent, "--image", IMAGE, "--sandbox", name])
          .sandbox,
      ).toBe(name);
    }
  });

  it("enforces the canonical OpenShell sandbox-name length and delimiter contract (#8497)", () => {
    const parseSandbox = (sandbox: string) =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        sandbox,
      ]);

    expect(parseSandbox(`a${"b".repeat(18)}`).sandbox).toHaveLength(19);
    expect(() => parseSandbox(`a${"b".repeat(19)}`)).toThrow(/1-19 characters/u);
    expect(() => parseSandbox("managed--openclaw")).toThrow(/single internal hyphens/u);
  });

  it.each([
    ["llama-cpp", "llama-cpp-local", "NEMOCLAW_LLAMACPP_LOCAL_TOKEN", 8081],
    ["ollama", "ollama-local", "NEMOCLAW_OLLAMA_PROXY_TOKEN", 11435],
    ["nim", "vllm-local", "NEMOCLAW_VLLM_LOCAL_TOKEN", 8000],
    ["vllm", "vllm-local", "NEMOCLAW_VLLM_LOCAL_TOKEN", 8000],
  ] as const)("maps %s to its exact host-local route", (kind, provider, credential, port) => {
    const route = resolveManagedImageLocalInferenceRoute(kind);

    expect(MANAGED_IMAGE_LOCAL_INFERENCE_KINDS).toContain(kind);
    expect(route).toMatchObject({
      kind,
      providerName: provider,
      credentialEnv: credential,
    });
    expect(new URL(route.defaultBaseUrl)).toMatchObject({
      hostname: "host.openshell.internal",
      port: String(port),
      pathname: "/v1",
      protocol: "http:",
    });
  });

  it("accepts an exact protected local-inference URL override", () => {
    expect(
      managedImageLocalInferenceBaseUrl("ollama", "http://host.openshell.internal:11435/v1/"),
    ).toBe("http://host.openshell.internal:11435/v1");
  });

  it.each([
    ["HTTPS", "https://host.openshell.internal:11435/v1"],
    ["another host", "http://example.invalid:11435/v1"],
    ["a missing port", "http://host.openshell.internal/v1"],
    ["port zero", "http://host.openshell.internal:0/v1"],
    ["an out-of-range port", "http://host.openshell.internal:65536/v1"],
    ["another path", "http://host.openshell.internal:11435/v2"],
    ["credentials", "http://user:secret@host.openshell.internal:11435/v1"],
    ["a query", "http://host.openshell.internal:11435/v1?model=other"],
    ["a fragment", "http://host.openshell.internal:11435/v1#other"],
  ])("rejects a protected local-inference override with %s", (_case, value) => {
    expect(() => managedImageLocalInferenceBaseUrl("ollama", value)).toThrow(
      /protected local inference/u,
    );
  });

  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("binds %s to an exact GPU/local-inference launch", (agent) => {
    const parsed = parseManagedImageOpenShellE2eInputs([
      "--agent",
      agent,
      "--image",
      IMAGE,
      "--sandbox",
      managedImageProtectedSandboxName(agent, "nim"),
      "--gpu",
      "--local-provider",
      "nim",
      "--model",
      "nvidia/nemotron-3-nano",
    ]);

    expect(parsed).toEqual({
      agent,
      gpu: true,
      image: IMAGE,
      localProvider: "nim",
      model: "nvidia/nemotron-3-nano",
      sandbox: managedImageProtectedSandboxName(agent, "nim"),
    });
    expect(path.isAbsolute(managedImageOpenShellBasePolicyPath(agent))).toBe(true);
    expect(managedImageOpenShellProbe(agent)).toContain("managed-startup-complete.json");
  });

  it("rewrites only the inference route while preserving the managed agent profile", () => {
    const profile = managedStartupE2eProfile("hermes", false, true, true);
    const route = resolveManagedImageLocalInferenceRoute("nim");
    const rewritten = withManagedImageLocalInferenceProfile(
      profile,
      route,
      "nvidia/nemotron-3-nano",
    );

    expect(rewritten).toMatchObject({
      agent: "hermes",
      inference: {
        api: "openai-completions",
        model: "nvidia/nemotron-3-nano",
        routedBaseUrl: "https://inference.local/v1",
        routeProvider: "inference",
        upstreamEndpointUrl: null,
        upstreamProvider: "vllm-local",
      },
    });
    expect(rewritten.agentConfig).toEqual(profile.agentConfig);
  });

  it("rejects mutable images and incomplete GPU provider tuples", () => {
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        "localhost:5000/openclaw:latest",
        "--sandbox",
        VALID_SANDBOX,
      ]),
    ).toThrow(/immutable repository@sha256/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        VALID_SANDBOX,
        "--gpu",
      ]),
    ).toThrow(/--gpu requires/u);
  });

  it("allows only llama.cpp local inference without direct sandbox GPU access", () => {
    expect(
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-llama",
        "--local-provider",
        "llama-cpp",
        "--model",
        "nvidia-nemotron-3-nano-30b-a3b",
      ]),
    ).toMatchObject({
      agent: "openclaw",
      localProvider: "llama-cpp",
      model: "nvidia-nemotron-3-nano-30b-a3b",
    });
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-vllm",
        "--local-provider",
        "vllm",
        "--model",
        "nvidia/nemotron-3-nano",
      ]),
    ).toThrow(/require --gpu/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-llama",
        "--local-provider",
        "llama-cpp",
        "--model",
        "nvidia-nemotron-3-nano-30b-a3b",
        "--gpu",
      ]),
    ).toThrow(/must not grant direct sandbox GPU access/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-llama",
        "--local-provider",
        "llama-cpp",
      ]),
    ).toThrow(/requires --model/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-llama",
        "--local-provider",
        "llama-cpp",
        "--model",
        "nvidia-nemotron-3-nano-30b-a3b",
        "--inject-bootstrap-completion-failure",
      ]),
    ).toThrow(/cannot be combined/u);
  });

  it("keeps rollback cleanup distinct from initial readiness", () => {
    expect(managedImageOpenShellCommittedProbe()).toContain(
      "managed-startup-shared-state-transaction-v1",
    );
    expect(
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-oc-rollback",
        "--inject-bootstrap-completion-failure",
      ]),
    ).toMatchObject({ failureInjection: "bootstrap-completion" });
  });
});
