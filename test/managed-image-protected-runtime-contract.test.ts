// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import { managedStartupE2eProfile } from "../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  MANAGED_IMAGE_LOCAL_INFERENCE_KINDS,
  managedImageProtectedSandboxName,
  resolveManagedImageLocalInferenceRoute,
  withManagedImageLocalInferenceProfile,
} from "../scripts/checks/managed-image-protected-runtime-contract.ts";
import {
  managedImageLocalInferenceBaseUrl,
  managedImageOpenShellBasePolicyPath,
  managedImageOpenShellCommittedProbe,
  managedImageOpenShellProbe,
  parseManagedImageOpenShellE2eInputs,
} from "../scripts/checks/run-managed-image-openshell-e2e.ts";

const IMAGE = `localhost:5000/nemoclaw-managed-protected/openclaw@sha256:${"a".repeat(64)}`;

describe("protected managed-image runtime contract", () => {
  it.each([
    ["ollama", "ollama-local", "NEMOCLAW_OLLAMA_PROXY_TOKEN", 11435],
    ["nim", "vllm-local", "NEMOCLAW_VLLM_LOCAL_TOKEN", 8000],
    ["vllm", "vllm-local", "NEMOCLAW_VLLM_LOCAL_TOKEN", 8000],
  ] as const)("maps %s to its exact host-local route", (kind, provider, credential, port) => {
    const route = resolveManagedImageLocalInferenceRoute(kind);

    expect(MANAGED_IMAGE_LOCAL_INFERENCE_KINDS).toContain(kind);
    expect(route).toMatchObject({ kind, providerName: provider, credentialEnv: credential });
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
        "managed-openclaw",
      ]),
    ).toThrow(/immutable repository@sha256/u);
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMAGE,
        "--sandbox",
        "managed-openclaw",
        "--gpu",
      ]),
    ).toThrow(/--gpu requires/u);
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
        "managed-openclaw-rollback",
        "--inject-bootstrap-completion-failure",
      ]),
    ).toMatchObject({ failureInjection: "bootstrap-completion" });
  });
});
