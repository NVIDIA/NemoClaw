// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type {
  CaptureOpenshellOptions,
  CaptureOpenshellResult,
} from "../../src/lib/adapters/openshell/client";
import type {
  OpenShellInferenceRouteMutator,
  OpenShellInferenceRouteObserver,
} from "../../src/lib/adapters/openshell/inference-route";
import { createCliOpenShellInferenceRouteMutator } from "../../src/lib/adapters/openshell/inference-route-cli";
import type { OpenShellProviderAdapter } from "../../src/lib/adapters/openshell/provider-adapter";
import { createCliOpenShellProviderAdapter } from "../../src/lib/adapters/openshell/provider-adapter-cli";
import { HOSTED_NATIVE_PROVIDERS } from "../../src/lib/inference/native-provider/hosted";
import { fixedNativeProvider } from "../../src/lib/inference/native-provider/fixed";
import type { NativeProviderAttachment } from "../../src/lib/inference/native-provider/contract";
import type { AgentConfigTarget } from "../../src/lib/sandbox/config";
import type { ConfigObject, ConfigValue } from "../../src/lib/security/credential-filter";
import type { Session } from "../../src/lib/state/onboard-session";
import type { SandboxEntry } from "../../src/lib/state/registry";
import type { InferenceSetDeps } from "../../src/lib/actions/inference-set";
import type { EnsureHttpsPinRuntimeAdapterFn } from "../../src/lib/actions/inference-set-route-containment";
import { redactInferenceSetRouteDiagnostic } from "../../src/lib/actions/inference-set-provider-diagnostics";

type LocalValidationResult = ReturnType<InferenceSetDeps["validateLocalProvider"]>;

export const OPENCLAW_TARGET: AgentConfigTarget = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
  sensitiveFiles: [],
};

export const HERMES_TARGET: AgentConfigTarget = {
  agentName: "hermes",
  configPath: "/sandbox/.hermes/config.yaml",
  configDir: "/sandbox/.hermes",
  format: "yaml",
  configFile: "config.yaml",
  sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
};

export const OPENAI_ENDPOINTLESS_PROFILE = JSON.stringify({
  id: "openai",
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: true,
});

export const ANTHROPIC_ENDPOINTLESS_PROFILE = JSON.stringify({
  id: "anthropic",
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: true,
});

function defaultCaptureOpenshell(
  args: string[],
  status: number,
): { status: number; output: string; stdout: string; stderr: string } {
  const output =
    args[0] === "provider" && args[1] === "profile" && args.includes("export")
      ? OPENAI_ENDPOINTLESS_PROFILE
      : "";
  return { status, output, stdout: output, stderr: "" };
}

function nativeAwareProviderAdapter(
  base: OpenShellProviderAdapter,
  entries: SandboxEntry[],
): OpenShellProviderAdapter {
  const definitions = [fixedNativeProvider("nvidia-prod")!, ...HOSTED_NATIVE_PROVIDERS];
  const receipts = entries.flatMap((entry) =>
    [entry.nativeNvidiaProviderAttachment, entry.nativeHostedProviderAttachment].filter(
      (receipt): receipt is NativeProviderAttachment => !!receipt,
    ),
  );
  const present = new Set(receipts.map((receipt) => receipt.providerName));
  const attachments = new Map(
    entries.map((entry) => [
      entry.name,
      new Set(
        [entry.nativeNvidiaProviderAttachment, entry.nativeHostedProviderAttachment]
          .filter((receipt) => !!receipt)
          .map((receipt) => receipt!.providerName),
      ),
    ]),
  );
  const definitionFor = (name: string) =>
    definitions.find((definition) => definition.providerName === name);
  return {
    ...base,
    ensureProviderPolicyComposition: async () => ({ ok: true, value: undefined }),
    importProviderProfile: async (request) =>
      definitions.some((definition) => request.profilePath.endsWith(`${definition.profileId}.yaml`))
        ? { ok: true }
        : await base.importProviderProfile(request),
    getProvider: async (request) => {
      const definition = definitionFor(request.providerName);
      if (!definition) return await base.getProvider(request);
      if (!present.has(request.providerName))
        return {
          ok: false,
          error: { kind: "command", reason: "not_found", message: "provider not found" },
        };
      return {
        ok: true,
        value: {
          name: definition.providerName,
          type: definition.profileId,
          credentialKeys: [definition.credentialEnv],
          configKeys: [],
          revision: {
            id:
              receipts.find((receipt) => receipt.providerName === definition.providerName)
                ?.providerId ?? "11111111-2222-4333-8444-555555555555",
            resourceVersion: 1,
          },
        },
      };
    },
    createProvider: async (request) => {
      if (!definitionFor(request.name)) return await base.createProvider(request);
      present.add(request.name);
      return { ok: true };
    },
    updateProvider: async (request) => {
      if (!definitionFor(request.providerName)) return await base.updateProvider(request);
      present.add(request.providerName);
      return { ok: true };
    },
    attachProvider: async (request) => {
      if (!definitionFor(request.providerName)) return await base.attachProvider(request);
      const names = attachments.get(request.sandboxName) ?? new Set<string>();
      names.add(request.providerName);
      attachments.set(request.sandboxName, names);
      return { ok: true };
    },
    detachProvider: async (request) => {
      if (!definitionFor(request.providerName)) return await base.detachProvider(request);
      return {
        ok: true,
        value: {
          changed: attachments.get(request.sandboxName)?.delete(request.providerName) ?? false,
        },
      };
    },
    listProviderAttachments: async (request) => ({
      ok: true,
      value: { names: [...(attachments.get(request.sandboxName) ?? [])] },
    }),
  };
}

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

export function createCompatibleProviderCapture(options: {
  name: string;
  type: "openai" | "anthropic";
  credentialEnv: string;
  configKey: "OPENAI_BASE_URL" | "ANTHROPIC_BASE_URL";
  initiallyPresent?: boolean;
}): CaptureOpenshell & ReturnType<typeof vi.fn> {
  let providerPresent = options.initiallyPresent ?? true;
  let providerVersion = providerPresent ? 1 : 0;
  return vi.fn((args: string[]) => {
    switch (`${args[0]}:${args[1]}`) {
      case "provider:profile": {
        const profile =
          options.type === "anthropic"
            ? ANTHROPIC_ENDPOINTLESS_PROFILE
            : OPENAI_ENDPOINTLESS_PROFILE;
        return {
          status: 0,
          output: profile,
          stdout: profile,
          stderr: "",
        };
      }
      case "provider:get": {
        if (!providerPresent) {
          const output =
            "Error: code: 'Some requested entity was not found', message: \"provider not found\"";
          return { status: 1, output, stdout: "", stderr: output };
        }
        const output = [
          `Name: ${options.name}`,
          "Id: 11111111-2222-4333-8444-555555555555",
          `Type: ${options.type}`,
          `Resource version: ${providerVersion}`,
          `Credential keys: ${options.credentialEnv}`,
          `Config keys: ${options.configKey}`,
        ].join("\n");
        return { status: 0, output, stdout: output, stderr: "" };
      }
      case "provider:create":
        providerPresent = true;
        providerVersion = 1;
        return { status: 0, output: "", stdout: "", stderr: "" };
      case "provider:update":
        providerVersion += 1;
        return { status: 0, output: "", stdout: "", stderr: "" };
      case "provider:delete":
        providerPresent = false;
        return { status: 0, output: "", stdout: "", stderr: "" };
      default:
        return { status: 0, output: "", stdout: "", stderr: "" };
    }
  });
}

export type CaptureOpenshell = (
  args: string[],
  options?: CaptureOpenshellOptions,
) => CaptureOpenshellResult;

export function createDeps(options: {
  config: ConfigObject;
  entry?: SandboxEntry | null;
  entries?: SandboxEntry[];
  defaultSandbox?: string | null;
  requestedAgent?: string | null;
  target?: AgentConfigTarget;
  session?: Session | null;
  openshellStatus?: number;
  captureOpenshell?: CaptureOpenshell;
  inferenceRouteMutator?: OpenShellInferenceRouteMutator;
  inferenceRouteObserver?: OpenShellInferenceRouteObserver;
  providerAdapter?: OpenShellProviderAdapter;
  localValidation?: LocalValidationResult;
  localReachable?: boolean;
  contextWindow?: number | null;
  prepareRunOpenshell?: () => void;
  rewriteConfigUrlsWithDnsPinning?: (value: ConfigValue) => Promise<ConfigValue>;
  resolveCredentialValue?: InferenceSetDeps["resolveCredentialValue"];
  ensureHttpsPinRuntimeAdapter?: EnsureHttpsPinRuntimeAdapterFn;
  revokeHttpsPinRuntimeAdapterRoute?: InferenceSetDeps["revokeHttpsPinRuntimeAdapterRoute"];
  probeSandboxRoute?: InferenceSetDeps["probeSandboxRoute"];
  updateSandbox?: InferenceSetDeps["updateSandbox"];
  restartSandboxGateway?: InferenceSetDeps["restartSandboxGateway"];
  settleOpenClawPairing?: InferenceSetDeps["settleOpenClawPairing"];
  withGatewayRouteMutationLock?: InferenceSetDeps["withGatewayRouteMutationLock"];
  getNativeNvidiaProviderAuthority?: InferenceSetDeps["getNativeNvidiaProviderAuthority"];
  setNativeNvidiaProviderAuthority?: InferenceSetDeps["setNativeNvidiaProviderAuthority"];
}): InferenceSetDeps & {
  calls: {
    captureOpenshell: ReturnType<typeof vi.fn>;
    setOpenClawConfigValues: ReturnType<typeof vi.fn>;
    writeSandboxConfig: ReturnType<typeof vi.fn>;
    recomputeSandboxConfigHash: ReturnType<typeof vi.fn>;
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
    resolveCredentialValue: ReturnType<typeof vi.fn>;
    ensureHttpsPinRuntimeAdapter: ReturnType<typeof vi.fn>;
    revokeHttpsPinRuntimeAdapterRoute: ReturnType<typeof vi.fn>;
    probeSandboxRoute: ReturnType<typeof vi.fn>;
    sleep: ReturnType<typeof vi.fn>;
    restartSandboxGateway: ReturnType<typeof vi.fn>;
    settleOpenClawPairing: ReturnType<typeof vi.fn>;
    withGatewayRouteMutationLock: ReturnType<typeof vi.fn>;
    setNativeNvidiaProviderAuthority: ReturnType<typeof vi.fn>;
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
        ((args: string[]) => defaultCaptureOpenshell(args, options.openshellStatus ?? 0)),
    ),
    setOpenClawConfigValues: vi.fn(),
    writeSandboxConfig: vi.fn(),
    recomputeSandboxConfigHash: vi.fn(),
    updateSandbox: vi.fn(options.updateSandbox ?? (() => true)),
    readSandboxConfig: vi.fn(() => options.config),
    updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
      const current = session ?? baseSession();
      session = mutator(current) ?? current;
      return session;
    }),
    appendAuditEntry: vi.fn(),
    log: vi.fn(),
    validateLocalProvider: vi.fn(
      (): LocalValidationResult => options.localValidation ?? { ok: true },
    ),
    ensureLocalProviderReachable: vi.fn(() => options.localReachable ?? true),
    resolveContextWindowForModel: vi.fn((_provider: string, _model: string) =>
      options.contextWindow === undefined ? null : options.contextWindow,
    ),
    prepareRunOpenshell: vi.fn(options.prepareRunOpenshell ?? (() => undefined)),
    rewriteConfigUrlsWithDnsPinning: vi.fn(
      options.rewriteConfigUrlsWithDnsPinning ?? (async (value: ConfigValue) => value),
    ),
    resolveCredentialValue: vi.fn(
      options.resolveCredentialValue ??
        ((credentialEnv: string) => process.env[credentialEnv] ?? "test-credential-value"),
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
    probeSandboxRoute: vi.fn(options.probeSandboxRoute ?? (async () => ({ ok: true }) as const)),
    sleep: vi.fn(async () => {}),
    restartSandboxGateway: vi.fn(
      options.restartSandboxGateway ??
        (async (): ReturnType<InferenceSetDeps["restartSandboxGateway"]> => ({
          ok: true,
          restarted: true,
          healthPassed: true,
          forwardRecovered: true,
        })),
    ),
    settleOpenClawPairing: vi.fn(options.settleOpenClawPairing ?? (() => ({ ok: true }) as const)),
    withGatewayRouteMutationLock: vi.fn(
      options.withGatewayRouteMutationLock ??
        (async (_gatewayName: string, operation: () => Promise<unknown> | unknown) =>
          await operation()),
    ),
    setNativeNvidiaProviderAuthority: vi.fn(),
  };
  const providerAdapter =
    options.providerAdapter ??
    nativeAwareProviderAdapter(
      createCliOpenShellProviderAdapter({
        run: (args, runOptions) => {
          const result = calls.captureOpenshell(args, {
            ...(runOptions.env ? { env: runOptions.env } : {}),
            ignoreError: true,
            includeStreams: true,
            ...(runOptions.maxBuffer ? { maxBuffer: runOptions.maxBuffer } : {}),
            timeout: runOptions.timeout,
          });
          return {
            status: result.status,
            stdout: result.stdout || result.stderr ? result.stdout : result.output,
            stderr: result.stderr,
            ...("error" in result && result.error ? { error: result.error } : {}),
            ...("signal" in result && result.signal ? { signal: result.signal } : {}),
          };
        },
      }),
      entries,
    );
  const hostedAuthority = new Map<string, NativeProviderAttachment>();
  const inferenceRouteMutator =
    options.inferenceRouteMutator ??
    createCliOpenShellInferenceRouteMutator(
      async (args, runOptions) => {
        const result = calls.captureOpenshell(args, {
          ignoreError: true,
          includeStderr: true,
          includeStreams: true,
          maxBuffer: runOptions.outputLimitBytes,
          timeout: runOptions.timeout,
        });
        return {
          status: result.status,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          ...("error" in result && result.error ? { error: result.error } : {}),
        };
      },
      { redactDiagnostic: redactInferenceSetRouteDiagnostic },
    );
  return {
    getDefaultSandbox: () => defaultSandbox,
    getSandbox: (name: string) => sandboxes[name] ?? null,
    listSandboxes: () => ({ sandboxes: entries, defaultSandbox }),
    getNativeHostedProviderAuthority: (gateway, provider) =>
      hostedAuthority.get(`${gateway}/${provider}`),
    setNativeHostedProviderAuthority: (gateway, provider, receipt) => {
      hostedAuthority.set(`${gateway}/${provider}`, receipt);
    },
    getNativeNvidiaProviderAuthority: options.getNativeNvidiaProviderAuthority,
    setNativeNvidiaProviderAuthority:
      options.setNativeNvidiaProviderAuthority ?? calls.setNativeNvidiaProviderAuthority,
    updateSandbox: calls.updateSandbox,
    getRequestedAgent: () => options.requestedAgent,
    loadSession: () => session,
    updateSession: calls.updateSession,
    resolveAgentConfig: () => options.target ?? OPENCLAW_TARGET,
    readSandboxConfig: calls.readSandboxConfig,
    setOpenClawConfigValues: calls.setOpenClawConfigValues,
    writeSandboxConfig: calls.writeSandboxConfig,
    recomputeSandboxConfigHash: calls.recomputeSandboxConfigHash,
    prepareRunOpenshell: calls.prepareRunOpenshell,
    inferenceRouteMutator,
    inferenceRouteObserver:
      options.inferenceRouteObserver ??
      ({
        observeInferenceRoute: vi.fn(async () => ({
          ok: true as const,
          value:
            entries[0]?.provider && entries[0]?.model
              ? {
                  state: "configured" as const,
                  route: { provider: entries[0].provider, model: entries[0].model },
                }
              : { state: "unconfigured" as const },
        })),
      } satisfies OpenShellInferenceRouteObserver),
    providerAdapter,
    appendAuditEntry: calls.appendAuditEntry,
    log: calls.log,
    isLocalInferenceProvider: (provider) =>
      provider === "ollama-local" || provider === "vllm-local",
    validateLocalProvider: calls.validateLocalProvider,
    ensureLocalProviderReachable: calls.ensureLocalProviderReachable,
    resolveContextWindowForModel: calls.resolveContextWindowForModel,
    rewriteConfigUrlsWithDnsPinning: calls.rewriteConfigUrlsWithDnsPinning,
    resolveCredentialValue: calls.resolveCredentialValue,
    ensureHttpsPinRuntimeAdapter:
      calls.ensureHttpsPinRuntimeAdapter as unknown as EnsureHttpsPinRuntimeAdapterFn,
    revokeHttpsPinRuntimeAdapterRoute:
      calls.revokeHttpsPinRuntimeAdapterRoute as InferenceSetDeps["revokeHttpsPinRuntimeAdapterRoute"],
    probeSandboxRoute: calls.probeSandboxRoute as InferenceSetDeps["probeSandboxRoute"],
    sleep: calls.sleep,
    withGatewayRouteMutationLock:
      calls.withGatewayRouteMutationLock as InferenceSetDeps["withGatewayRouteMutationLock"],
    restartSandboxGateway: calls.restartSandboxGateway,
    settleOpenClawPairing: calls.settleOpenClawPairing,
    calls,
    getSession: () => session,
  };
}
