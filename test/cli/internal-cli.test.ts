// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runWithEnvAsync } from "./helpers";

vi.setConfig({ maxConcurrency: 4 });

describe.concurrent("internal oclif namespace", () => {
  it("passes internal subcommands directly to oclif space-separated routing", async () => {
    const result = await runWithEnvAsync("internal dns fix-coredns --help");

    expect(result.code).toBe(0);
    expect(result.out).toContain("Internal: patch CoreDNS");
    expect(result.out).toContain("nemoclaw internal dns fix-coredns [gateway-name]");
  });

  it("exposes setup-proxy as an oclif-routed internal subcommand", async () => {
    const result = await runWithEnvAsync("internal dns setup-proxy --help");

    expect(result.code).toBe(0);
    expect(result.out).toContain("Internal: configure sandbox DNS proxy");
    expect(result.out).toContain("nemoclaw internal dns setup-proxy <gateway-name> <sandbox-name>");
  });

  it("exposes uninstall plan commands through oclif routing", async () => {
    const result = await runWithEnvAsync("internal uninstall run-plan --help");

    expect(result.code).toBe(0);
    expect(result.out).toContain("NemoClaw Uninstaller");
    expect(result.out).toContain("--delete-models");
    expect(result.out).toContain("--keep-openshell");
    expect(result.out).toContain("--yes");
  });

  it("names only port-specific gateway resources when the gateway port is non-default (#10763)", async () => {
    const preview = await runWithEnvAsync("internal uninstall plan --json", {
      NEMOCLAW_GATEWAY_PORT: "8091",
    });

    expect(preview.code).toBe(0);
    const plan = JSON.parse(preview.out) as {
      gatewayName: string;
      steps: { actions: { kind: string; name?: string }[] }[];
    };
    const actions = plan.steps.flatMap((step) => step.actions);
    expect(plan.gatewayName).toBe("nemoclaw-8091");
    expect(actions).toContainEqual({
      kind: "destroy-openshell-gateway",
      name: "nemoclaw-8091",
    });
    expect(actions).toContainEqual({
      kind: "delete-docker-volume",
      name: "openshell-cluster-nemoclaw-8091",
    });
    expect(actions).not.toContainEqual({
      kind: "destroy-openshell-gateway",
      name: "nemoclaw",
    });
    expect(actions).not.toContainEqual({
      kind: "delete-docker-volume",
      name: "openshell-cluster-nemoclaw",
    });
  });

  it("exposes the dev npm-link shim command through oclif routing", async () => {
    const result = await runWithEnvAsync("internal dev npm-link-or-shim --help");

    expect(result.code).toBe(0);
    expect(result.out).toContain("Internal: link the checkout CLI or create a dev shim");
    expect(result.out).toContain("nemoclaw internal dev npm-link-or-shim");
  });

  it("exposes installer plan commands through oclif routing", async () => {
    const help = await runWithEnvAsync("internal installer plan --help");

    expect(help.code).toBe(0);
    expect(help.out).toContain("Internal: build the NemoClaw installer plan");
    expect(help.out).toContain("nemoclaw internal installer plan [--json]");

    const result = await runWithEnvAsync(
      "internal installer plan --json --install-ref v1.2.3 --provider cloud --node-version v22.19.0 --npm-version 10.0.0",
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      installRef: "v1.2.3",
      provider: { normalized: "build", raw: "cloud", valid: true },
      runtime: { ok: true },
    });

    const deferred = await runWithEnvAsync(
      "internal installer plan --defer-onboarding --deferred-onboarding-supported --registered-sandbox-count 0 --deferred-onboarding-decision",
      {
        NEMOCLAW_AGENT: "langchain-deepagents-code",
        NEMOCLAW_PROVIDER: "build",
        NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE: "",
        NEMOCLAW_PROVIDER_KEY: "",
        NVIDIA_API_KEY: "",
        NVIDIA_INFERENCE_API_KEY: "",
      },
    );
    expect(deferred.code).toBe(0);
    expect(deferred.out.trim()).toBe("defer");
  });

  it("exposes installer ref and env normalization helpers through oclif routing", async () => {
    const ref = await runWithEnvAsync(
      "internal installer resolve-release-tag --json --install-tag v2.0.0",
    );
    const env = await runWithEnvAsync("internal installer normalize-env --json --provider nim");

    expect(ref.code).toBe(0);
    expect(JSON.parse(ref.out)).toEqual({ installRef: "v2.0.0" });
    expect(env.code).toBe(0);
    expect(JSON.parse(env.out)).toMatchObject({
      installRef: "lkg",
      provider: { normalized: "nim-local", raw: "nim", valid: true },
    });
  });

  it("fails the experimental voice gateway gate before parsing required flags (#8378)", async () => {
    const result = await runWithEnvAsync("internal voice-gateway serve", {
      NEMOCLAW_EXPERIMENTAL_VOICE_GATEWAY: "",
    });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("Experimental voice gateway is disabled");
    expect(result.out).not.toContain("Missing required flag");
  });

  it("ships hidden help for the feature-gated voice gateway command (#8378)", async () => {
    const result = await runWithEnvAsync("internal voice-gateway serve --help", {
      NEMOCLAW_EXPERIMENTAL_VOICE_GATEWAY: "1",
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("Internal: serve the experimental voice gateway");
    expect(result.out).toContain("--runtime-identity");
  });
});
