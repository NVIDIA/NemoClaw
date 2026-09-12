// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { restoreEnvBulk } from "../../../../test/helpers/env-test-helpers";
import type {
  ProviderRecoveryReceipt,
  RegistryInferenceRoute,
} from "../../onboard/rebuild-route-handoff";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import {
  pinRebuildTargetGatewayForReadiness,
  resolveRebuildMcpRuntimeSelection,
  runRebuildGatewayRecoveryAfterReadiness,
  stageRebuildBaseImageResolutionHandoff,
  stageRegistryProviderRecoveryReceipt,
} from "./rebuild-preflight-target-phase";

const originalOpenShellEnv = {
  OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY,
  OPENSHELL_GATEWAY_ENDPOINT: process.env.OPENSHELL_GATEWAY_ENDPOINT,
  OPENSHELL_LOCAL_TLS_DIR: process.env.OPENSHELL_LOCAL_TLS_DIR,
  OPENSHELL_TOKEN: process.env.OPENSHELL_TOKEN,
  OPENSHELL_WORKSPACE: process.env.OPENSHELL_WORKSPACE,
};

afterEach(() => {
  restoreEnvBulk(originalOpenShellEnv);
});

describe("rebuild readiness gateway pin", () => {
  it("does not require runtime authority for prepared-only MCP state", () => {
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    expect(
      resolveRebuildMcpRuntimeSelection(
        {
          mcp: {
            bridges: {
              github: { addState: "prepared" },
            },
          },
        } as never,
        bail,
      ),
    ).toBeUndefined();
    expect(bail).not.toHaveBeenCalled();
  });

  it("pins the recorded target without selecting or recovering a gateway (#7411)", () => {
    const log = vi.fn();
    process.env.OPENSHELL_GATEWAY = "hostile-gateway";
    process.env.OPENSHELL_GATEWAY_ENDPOINT = "https://hostile.invalid";
    process.env.OPENSHELL_LOCAL_TLS_DIR = "/hostile/tls";
    process.env.OPENSHELL_TOKEN = "hostile-token";
    process.env.OPENSHELL_WORKSPACE = "hostile-workspace";
    const runtimeSelection = { gatewayName: "nemoclaw-9443", workspace: "default" };

    expect(
      pinRebuildTargetGatewayForReadiness(
        "alpha",
        { gatewayName: "nemoclaw-9443", gatewayPort: 9443 } as never,
        log,
        runtimeSelection,
      ),
    ).toBe("nemoclaw-9443");
    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-9443");
    expect(process.env.OPENSHELL_WORKSPACE).toBe("default");
    expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
    expect(process.env.OPENSHELL_LOCAL_TLS_DIR).toBeUndefined();
    expect(process.env.OPENSHELL_TOKEN).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "Pinned rebuild readiness probes for 'alpha' to target gateway 'nemoclaw-9443'",
    );
  });

  it("keeps non-MCP ambient selectors while pinning the recorded gateway (#10514)", () => {
    process.env.OPENSHELL_GATEWAY = "hostile-gateway";
    process.env.OPENSHELL_GATEWAY_ENDPOINT = "https://hostile.invalid";
    process.env.OPENSHELL_LOCAL_TLS_DIR = "/hostile/tls";
    process.env.OPENSHELL_TOKEN = "hostile-token";
    process.env.OPENSHELL_WORKSPACE = "hostile-workspace";

    expect(
      pinRebuildTargetGatewayForReadiness(
        "alpha",
        { gatewayName: "nemoclaw-9443", gatewayPort: 9443 } as never,
        vi.fn(),
      ),
    ).toBe("nemoclaw-9443");
    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-9443");
    expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBe("https://hostile.invalid");
    expect(process.env.OPENSHELL_LOCAL_TLS_DIR).toBe("/hostile/tls");
    expect(process.env.OPENSHELL_TOKEN).toBe("hostile-token");
    expect(process.env.OPENSHELL_WORKSPACE).toBe("hostile-workspace");
  });

  it("does not select or recover the gateway when readiness rejects (#7411)", async () => {
    const afterReadiness = vi.fn();
    const recoverGateway = vi.fn(async () => true);

    await expect(
      runRebuildGatewayRecoveryAfterReadiness({
        assertReadiness: async () => false,
        afterReadiness,
        recoverGateway,
      }),
    ).resolves.toBe(false);
    expect(afterReadiness).not.toHaveBeenCalled();
    expect(recoverGateway).not.toHaveBeenCalled();
  });

  it("recovers the gateway only after readiness and post-admission staging (#7411)", async () => {
    const calls: string[] = [];

    await expect(
      runRebuildGatewayRecoveryAfterReadiness({
        assertReadiness: async () => {
          calls.push("readiness");
          return true;
        },
        afterReadiness: () => calls.push("stage-receipt"),
        recoverGateway: async () => {
          calls.push("recover-gateway");
          return true;
        },
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual(["readiness", "stage-receipt", "recover-gateway"]);
  });
});

const target = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  provider: "compatible-endpoint",
  model: "nvidia/model",
};

const registryRoute: RegistryInferenceRoute = {
  provider: target.provider,
  model: target.model,
  endpointUrl: "https://inference.example.test/v1",
  endpointSource: null,
  preferredInferenceApi: "openai-completions",
  source: "registry",
};

describe("stageRegistryProviderRecoveryReceipt", () => {
  it("leaves recovery authority absent without a registry-derived route", () => {
    const recreateOptions: { providerRecoveryReceipt?: ProviderRecoveryReceipt } = {};

    stageRegistryProviderRecoveryReceipt(recreateOptions, target, null, {
      nonce: "nonce-without-route",
      expiresAtMs: 1_000,
    });

    expect(recreateOptions).not.toHaveProperty("providerRecoveryReceipt");
  });

  it("binds recovery authority to the captured registry route", () => {
    const recreateOptions: { providerRecoveryReceipt?: ProviderRecoveryReceipt } = {};

    stageRegistryProviderRecoveryReceipt(recreateOptions, target, registryRoute, {
      nonce: "nonce-with-route",
      expiresAtMs: 1_000,
    });

    expect(recreateOptions.providerRecoveryReceipt).toEqual({
      ...target,
      route: registryRoute,
      nonce: "nonce-with-route",
      expiresAtMs: 1_000,
      sessionId: null,
    });
  });
});

describe("stageRebuildBaseImageResolutionHandoff", () => {
  it("binds outer resolver provenance to its immutable local handoff (#7144)", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const current = { key: "current", imageId } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    stageRebuildBaseImageResolutionHandoff(recreateOptions, {
      ok: true,
      imageRef: `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`,
      overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      resolutionMetadata: current,
    });

    expect(recreateOptions.preResolvedBaseImageMetadata).toBe(current);
  });

  it("binds provenance to a temporary immutable rebuild handoff (#7144)", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const current = { key: "current", imageId } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    stageRebuildBaseImageResolutionHandoff(recreateOptions, {
      ok: true,
      imageRef: `nemoclaw-hermes-sandbox-base-local:rebuild-123-${"b".repeat(16)}-image-${"a".repeat(64)}`,
      overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      resolutionMetadata: current,
    });

    expect(recreateOptions.preResolvedBaseImageMetadata).toBe(current);
  });

  it("binds provenance to the exact immutable remote rebuild handoff (#7144)", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const imageRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${digest}`;
    const current = {
      key: "current",
      imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
      imageId: `sha256:${"b".repeat(64)}`,
      ref: imageRef,
      digest,
      source: "pinned",
    } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    stageRebuildBaseImageResolutionHandoff(recreateOptions, {
      ok: true,
      imageRef,
      overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      resolutionMetadata: current,
    });

    expect(recreateOptions.preResolvedBaseImageMetadata).toBe(current);
  });

  it("rejects provenance that is not bound to the immutable local handoff", () => {
    const current = {
      key: "current",
      imageId: `sha256:${"a".repeat(64)}`,
    } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    expect(() =>
      stageRebuildBaseImageResolutionHandoff(recreateOptions, {
        ok: true,
        imageRef: `nemoclaw-hermes-sandbox-base-local:image-${"b".repeat(64)}`,
        overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
        resolutionMetadata: current,
      }),
    ).toThrow("provenance did not match its immutable handoff");
  });
});
