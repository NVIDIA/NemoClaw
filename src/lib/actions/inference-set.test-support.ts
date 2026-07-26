// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { ValidationResult } from "../inference/local";
import type { AgentConfigTarget } from "../sandbox/config";
import type { ConfigObject, ConfigValue } from "../security/credential-filter";
import type { Session } from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";
import type { InferenceSetDeps } from "./inference-set";
import type { EnsureHttpsPinRuntimeAdapterFn } from "./inference-set-route-containment";

export const OPENCLAW_TARGET: AgentConfigTarget = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
};

export const HERMES_TARGET: AgentConfigTarget = {
  agentName: "hermes",
  configPath: "/sandbox/.hermes/config.yaml",
  configDir: "/sandbox/.hermes",
  format: "yaml",
  configFile: "config.yaml",
  sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
};

export function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    version: 1,
    sessionId: "session-1",
    resumable: true,
    status: "complete",
    mode: "onboard",
    startedAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T00:00:00.000Z",
    lastStepStarted: null,
    lastCompletedStep: null,
    failure: null,
    agent: "openclaw",
    sandboxName: "alpha",
    provider: "nvidia-prod",
    model: "moonshotai/kimi-k2.6",
    endpointUrl: "https://inference.local/v1",
    credentialEnv: "OPENAI_API_KEY",
    hermesAuthMethod: null,
    preferredInferenceApi: null,
    nimContainer: null,
    routerPid: null,
    routerCredentialHash: null,
    webSearchConfig: null,
    policyPresets: null,
    messagingPlan: null,
    migratedLegacyValueHashes: null,
    hermesToolGateways: null,
    gpuPassthrough: false,
    telegramConfig: null,
    wechatConfig: null,
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
    machine: {
      version: 1,
      state: "complete",
      stateEnteredAt: "2026-05-11T00:00:00.000Z",
      revision: 0,
    },
    steps: {},
    ...overrides,
  } as Session;
}

export function createDeps(options: {
  config: ConfigObject;
  entry?: SandboxEntry | null;
  entries?: SandboxEntry[];
  defaultSandbox?: string | null;
  requestedAgent?: string | null;
  target?: AgentConfigTarget;
  session?: Session | null;
  openshellStatus?: number;
  captureOpenshell?: InferenceSetDeps["captureOpenshell"];
  localValidation?: ValidationResult;
  localReachable?: boolean;
  contextWindow?: number | null;
  shieldsMutable?: boolean;
  prepareRunOpenshell?: () => void;
  rewriteConfigUrlsWithDnsPinning?: (value: ConfigValue) => Promise<ConfigValue>;
  ensureHttpsPinRuntimeAdapter?: EnsureHttpsPinRuntimeAdapterFn;
  revokeHttpsPinRuntimeAdapterRoute?: InferenceSetDeps["revokeHttpsPinRuntimeAdapterRoute"];
  updateSandbox?: InferenceSetDeps["updateSandbox"];
  restartSandboxGateway?: InferenceSetDeps["restartSandboxGateway"];
  seedHermesDashboardConfigResult?: "converged" | "absent" | "failed";
  withGatewayRouteMutationLock?: InferenceSetDeps["withGatewayRouteMutationLock"];
}): InferenceSetDeps & {
  calls: {
    captureOpenshell: ReturnType<typeof vi.fn>;
    writeSandboxConfig: ReturnType<typeof vi.fn>;
    recomputeSandboxConfigHash: ReturnType<typeof vi.fn>;
    seedHermesDashboardConfig: ReturnType<typeof vi.fn>;
    updateSandbox: ReturnType<typeof vi.fn>;
    readSandboxConfig: ReturnType<typeof vi.fn>;
    updateSession: ReturnType<typeof vi.fn>;
    appendAuditEntry: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    validateLocalProvider: ReturnType<typeof vi.fn>;
    ensureLocalProviderReachable: ReturnType<typeof vi.fn>;
    resolveContextWindowForModel: ReturnType<typeof vi.fn>;
    prepareRunOpenshell: ReturnType<typeof vi.fn>;
    rewriteConfigUrlsWithDnsPinning: ReturnType<typeof vi.fn>;
    ensureHttpsPinRuntimeAdapter: ReturnType<typeof vi.fn>;
    revokeHttpsPinRuntimeAdapterRoute: ReturnType<typeof vi.fn>;
    restartSandboxGateway: ReturnType<typeof vi.fn>;
    withGatewayRouteMutationLock: ReturnType<typeof vi.fn>;
  };
  getSession: () => Session | null;
} {
  let session = options.session ?? null;
  const entries = options.entries ?? [options.entry ?? { name: "alpha", agent: null }];
  const sandboxes = entries.reduce<Record<string, SandboxEntry>>((acc, entry) => {
    acc[entry.name] = entry;
    return acc;
  }, {});
  const defaultSandbox =
    options.defaultSandbox === undefined ? (entries[0]?.name ?? null) : options.defaultSandbox;
  const calls = {
    captureOpenshell: vi.fn(
      options.captureOpenshell ??
        (() => ({
          status: options.openshellStatus ?? 0,
          output: "",
          stdout: "",
          stderr: "",
        })),
    ),
    writeSandboxConfig: vi.fn(),
    recomputeSandboxConfigHash: vi.fn(),
    seedHermesDashboardConfig: vi.fn(() => options.seedHermesDashboardConfigResult ?? "converged"),
    updateSandbox: vi.fn(options.updateSandbox ?? (() => true)),
    readSandboxConfig: vi.fn(() => options.config),
    updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
      const current = session ?? baseSession();
      session = mutator(current) ?? current;
      return session;
    }),
    appendAuditEntry: vi.fn(),
    log: vi.fn(),
    validateLocalProvider: vi.fn((): ValidationResult => options.localValidation ?? { ok: true }),
    ensureLocalProviderReachable: vi.fn(() => options.localReachable ?? true),
    resolveContextWindowForModel: vi.fn((_provider: string, _model: string) =>
      options.contextWindow === undefined ? null : options.contextWindow,
    ),
    prepareRunOpenshell: vi.fn(options.prepareRunOpenshell ?? (() => undefined)),
    rewriteConfigUrlsWithDnsPinning: vi.fn(
      options.rewriteConfigUrlsWithDnsPinning ?? (async (value: ConfigValue) => value),
    ),
    ensureHttpsPinRuntimeAdapter: vi.fn(
      options.ensureHttpsPinRuntimeAdapter ??
        (async () => ({
          baseUrl: "http://host.openshell.internal:11438/route/test-route",
          credentialEnv: "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_TOKEN",
          token: "test-adapter-token",
          routeId: "test-route",
        })),
    ),
    revokeHttpsPinRuntimeAdapterRoute: vi.fn(
      options.revokeHttpsPinRuntimeAdapterRoute ?? (async () => true),
    ),
    restartSandboxGateway: vi.fn(
      options.restartSandboxGateway ??
        ((): ReturnType<InferenceSetDeps["restartSandboxGateway"]> => ({
          ok: true,
          restarted: true,
          healthPassed: true,
          forwardRecovered: true,
        })),
    ),
    withGatewayRouteMutationLock: vi.fn(
      options.withGatewayRouteMutationLock ??
        (async (_gatewayName: string, operation: () => Promise<unknown> | unknown) =>
          await operation()),
    ),
  };
  return {
    getDefaultSandbox: () => defaultSandbox,
    getSandbox: (name: string) => sandboxes[name] ?? null,
    listSandboxes: () => ({ sandboxes: entries, defaultSandbox }),
    updateSandbox: calls.updateSandbox,
    getRequestedAgent: () => options.requestedAgent,
    loadSession: () => session,
    updateSession: calls.updateSession,
    resolveAgentConfig: () => options.target ?? OPENCLAW_TARGET,
    readSandboxConfig: calls.readSandboxConfig,
    writeSandboxConfig: calls.writeSandboxConfig,
    recomputeSandboxConfigHash: calls.recomputeSandboxConfigHash,
    seedHermesDashboardConfig: calls.seedHermesDashboardConfig,
    prepareRunOpenshell: calls.prepareRunOpenshell,
    captureOpenshell: calls.captureOpenshell,
    appendAuditEntry: calls.appendAuditEntry,
    log: calls.log,
    isLocalInferenceProvider: (provider) =>
      provider === "ollama-local" || provider === "vllm-local",
    validateLocalProvider: calls.validateLocalProvider,
    ensureLocalProviderReachable: calls.ensureLocalProviderReachable,
    resolveContextWindowForModel: calls.resolveContextWindowForModel,
    isSandboxConfigMutable: () => options.shieldsMutable ?? true,
    rewriteConfigUrlsWithDnsPinning: calls.rewriteConfigUrlsWithDnsPinning,
    ensureHttpsPinRuntimeAdapter:
      calls.ensureHttpsPinRuntimeAdapter as unknown as EnsureHttpsPinRuntimeAdapterFn,
    revokeHttpsPinRuntimeAdapterRoute:
      calls.revokeHttpsPinRuntimeAdapterRoute as InferenceSetDeps["revokeHttpsPinRuntimeAdapterRoute"],
    withGatewayRouteMutationLock:
      calls.withGatewayRouteMutationLock as InferenceSetDeps["withGatewayRouteMutationLock"],
    restartSandboxGateway: calls.restartSandboxGateway,
    calls,
    getSession: () => session,
  };
}
