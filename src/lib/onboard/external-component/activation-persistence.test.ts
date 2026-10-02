// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseExternalComponentDeclaration } from "./index";
import { finalDeps } from "./onboarding";
import type { SessionUpdates } from "../../state/onboard-session";
import {
  handleFinalizationState,
  type FinalizationStateOptions,
} from "../machine/handlers/finalization";

let temporaryHome: string;
let session: typeof import("../../state/onboard-session");
const evidence = {
  schemaVersion: 1 as const,
  activationId: "4b5a8e18-f967-4e27-a3b2-f2cc315abe21",
  componentId: "example/policy-adapter",
  lifecycleGeneration: "generation-1",
  sandboxIdentityFingerprint: `sha256:${"b".repeat(64)}`,
  resultClass: "ambiguous" as const,
};

function declaration(componentId: unknown, schemaVersion = 2) {
  return JSON.stringify({
    schemaVersion,
    componentId,
    activationSocketPath: "/run/example/activate.sock",
    ...(schemaVersion === 1
      ? { interceptorSocketPath: "/run/example/interceptor.sock" }
      : {
          interceptor: {
            endpoint: "https://127.0.0.1:9443",
            caCertificatePath: "/run/example/ca.pem",
            audience: "urn:example:admission",
          },
          middleware: {
            name: "example/middleware",
            endpoint: "https://host.openshell.internal:9444",
            caCertificatePath: "/run/example/ca.pem",
            audience: "urn:example:middleware",
          },
        }),
  });
}

beforeEach(async () => {
  temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "nc-activation-persistence-"));
  vi.stubEnv("HOME", temporaryHome);
  vi.resetModules();
  session = await import("../../state/onboard-session");
  session.saveSession(session.createSession());
});

afterEach(() => {
  fs.rmSync(temporaryHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

function finalization(componentId = evidence.componentId) {
  const activate = vi.fn(async () => {
    // Reload inside the callback to prove evidence reached disk before activation.
    expect(session.loadSession()?.externalComponentActivation).toEqual({
      ...evidence,
      componentId,
    });
    return { kind: "activated" as const };
  });
  const options: FinalizationStateOptions<null, unknown, unknown> = {
    sandboxName: "example",
    model: "",
    provider: "",
    nimContainer: null,
    agent: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    stagedLegacyKeys: [],
    migratedLegacyKeys: new Set(),
    webSearchEnabled: false,
    webSearchProvider: null,
    providerless: true,
    externalComponent: {
      declaration: parseExternalComponentDeclaration(declaration(componentId)),
      revalidateBeforeGateway: vi.fn(),
      revalidateBeforeActivation: vi.fn(),
    },
    deps: {
      ...finalDeps("example", session, { getSandbox: () => null, setDefault: vi.fn() }, vi.fn()),
      createExternalComponentActivationId: () => evidence.activationId,
      createExternalComponentActivationProof: () => ({
        gatewayName: "example",
        sandboxId: "example-sandbox-id",
        ...evidence,
        policySource: "sandbox",
        policyHash: `sha256:${"a".repeat(64)}`,
        policyActiveVersion: 1,
        revalidate: vi.fn(),
      }),
      activateExternalComponent: activate,
      toSessionUpdates: (updates) => updates as SessionUpdates,
      removeLegacyCredentialsFile: vi.fn(),
      cleanupStaleHostFiles: vi.fn(),
      checkAndRecoverSandboxProcesses: vi.fn(),
      settleOrdinaryOpenClawPairing: vi.fn(),
      ordinaryOpenClawPairingIncompleteMessage: vi.fn(),
      readRegistryAgent: vi.fn(),
      settlePortablePairing: vi.fn(),
      portablePairingIncompleteMessage: vi.fn(),
      getChatUiUrl: vi.fn(),
      buildVerifyChain: vi.fn(),
      verifyDeployment: vi.fn(),
      formatVerificationDiagnostics: vi.fn(),
      isDeploymentHealthy: vi.fn(),
      reportDeploymentReadiness: vi.fn(),
      verifyWebSearchInsideSandbox: vi.fn(),
      printDashboard: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    },
  };
  return { options, activate };
}

describe("component ID registration and activation persistence", () => {
  it.each([
    "example/policy-adapter",
    "a",
    "a".repeat(64),
    "a".repeat(65),
    `example/${"a".repeat(120)}`,
  ])(
    "persists registered v2 ID %s before activation and clears evidence after success",
    async (componentId) => {
      const { options, activate } = finalization(componentId);
      const result = await handleFinalizationState(options);
      expect(result.stateResult).toMatchObject({ type: "transition", next: "post_verify" });
      expect(activate).toHaveBeenCalledOnce();
      expect(session.loadSession()?.externalComponentActivation).toBeNull();
    },
  );

  it.each(["a", "example-policy_adapter.1", "a".repeat(64), "openshell"])(
    "preserves legacy registration and persisted ID %s",
    (componentId) => {
      expect(parseExternalComponentDeclaration(declaration(componentId, 1)).componentId).toBe(
        componentId,
      );
      session.updateSession((saved) => {
        saved.externalComponentActivation = { ...evidence, componentId };
      });
      expect(session.loadSession()?.externalComponentActivation).toEqual({
        ...evidence,
        componentId,
      });
    },
  );

  it.each(["example/policy-adapter", "a".repeat(65), "a".repeat(128)])(
    "keeps v1 registration restrictions for %s",
    (componentId) => {
      expect(() => parseExternalComponentDeclaration(declaration(componentId, 1))).toThrow(
        /declaration_invalid/,
      );
    },
  );

  it.each([
    "",
    "/example",
    "-example",
    "example policy",
    "example\\policy",
    "example:policy",
    "éxample",
    "a".repeat(129),
    "openshell/policy-adapter",
    7,
    null,
  ])("rejects invalid or reserved ID %s in registration and saved evidence", (componentId) => {
    expect(() => parseExternalComponentDeclaration(declaration(componentId))).toThrow(
      /declaration_invalid/,
    );
    const saved = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8"));
    saved.externalComponentActivation = { ...evidence, componentId };
    fs.writeFileSync(session.SESSION_FILE, JSON.stringify(saved));
    expect(() => session.loadSession()).toThrow(
      session.InvalidPersistedExternalComponentActivationError,
    );
  });

  it.each([
    ["UUID", { activationId: "invalid" }],
    ["identity", { sandboxIdentityFingerprint: "invalid" }],
    ["lifecycle", { lifecycleGeneration: "" }],
    ["unknown field", { unexpected: true }],
    ["component ID", { componentId: "openshell/policy-adapter" }],
    ["result class", { resultClass: "activated" }],
  ])("rejects invalid saved %s before invoking activation", async (_label, invalid) => {
    const { options, activate } = finalization();
    const saved = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8"));
    saved.externalComponentActivation = { ...evidence, ...invalid };
    fs.writeFileSync(session.SESSION_FILE, JSON.stringify(saved));
    await expect(handleFinalizationState(options)).rejects.toThrow(
      session.InvalidPersistedExternalComponentActivationError,
    );
    expect(activate).not.toHaveBeenCalled();
  });

  it("rejects invalid new evidence before invoking activation or changing the saved session", async () => {
    const { options, activate } = finalization();
    options.deps.createExternalComponentActivationId = () => "invalid";
    const before = fs.readFileSync(session.SESSION_FILE, "utf8");
    await expect(handleFinalizationState(options)).rejects.toThrow(
      session.InvalidPersistedExternalComponentActivationError,
    );
    expect(activate).not.toHaveBeenCalled();
    expect(fs.readFileSync(session.SESSION_FILE, "utf8")).toBe(before);
  });
});
