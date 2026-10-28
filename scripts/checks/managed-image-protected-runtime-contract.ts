// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createManagedProviderAdapter } from "../../src/lib/adapters/openshell/managed-provider-adapter.ts";
import { parseOpenShellVersionFromText } from "../../src/lib/adapters/openshell/version-text.ts";
import {
  ensureNativeLocalProvider,
  verifyNativeLocalProviderAttachment,
  type NativeLocalProviderAttachment,
} from "../../src/lib/inference/native-local/profile.ts";
import {
  NATIVE_LOCAL_AUTH_HEADER_SCRIPT,
  NATIVE_LOCAL_CREDENTIAL_ENV,
} from "../../src/lib/inference/native-local/agent-config.ts";
import { createCliOpenShellSandboxLifecycleFromRunner } from "../../src/lib/adapters/openshell/sandbox-lifecycle-cli.ts";
import { createDockerGpuDiagnosticRedactor } from "../../src/lib/onboard/docker-gpu-diagnostic-redaction.ts";
import type { ShippedManagedImageAgent } from "../../src/lib/onboard/managed-image/contract.ts";
import type { ManagedStartupProfile } from "../../src/lib/onboard/managed-startup/profile.ts";
import { gatewayIdForStateDir } from "../../src/lib/onboard/gateway/process-environment.ts";

const MANAGED_IMAGE_HARNESS_OPENSHELL_VERSIONS = ["0.0.116", "0.1.3", "0.1.5"] as const;
export type ManagedImageHarnessOpenShellVersion =
  (typeof MANAGED_IMAGE_HARNESS_OPENSHELL_VERSIONS)[number];

export function requireManagedImageHarnessOpenShellVersion(
  version: string | null | undefined,
): ManagedImageHarnessOpenShellVersion {
  if (
    MANAGED_IMAGE_HARNESS_OPENSHELL_VERSIONS.includes(
      version as ManagedImageHarnessOpenShellVersion,
    )
  ) {
    return version as ManagedImageHarnessOpenShellVersion;
  }
  throw new Error(`Unsupported protected OpenShell runtime version: ${version ?? "unavailable"}`);
}

export function requireManagedImageHarnessOpenShellVersionFromOutput(
  versionOutput: string,
): ManagedImageHarnessOpenShellVersion {
  return requireManagedImageHarnessOpenShellVersion(parseOpenShellVersionFromText(versionOutput));
}

export function isManagedImageHarnessWorkload(
  record:
    | {
        Config?: { Labels?: Record<string, string> };
        Image?: string;
        HostConfig?: { NetworkMode?: string };
        NetworkSettings?: { Networks?: Record<string, unknown> };
      }
    | undefined,
  expected: {
    sandbox: string;
    stateDir: string;
    imageContentId: string;
    runtimeVersion: ManagedImageHarnessOpenShellVersion;
    networkName?: string;
  },
): boolean {
  const labels = record?.Config?.Labels;
  return (
    labels?.["openshell.ai/managed-by"] === "openshell" &&
    labels["openshell.ai/sandbox-name"] === expected.sandbox &&
    record?.Image === expected.imageContentId &&
    (expected.runtimeVersion === "0.1.3" || expected.runtimeVersion === "0.1.5"
      ? labels["openshell.ai/isolation-role"] === "sandbox" &&
        labels["openshell.ai/sandbox-namespace"] === gatewayIdForStateDir(expected.stateDir) &&
        record.HostConfig?.NetworkMode === "none"
      : typeof expected.networkName === "string" &&
        expected.networkName.length > 0 &&
        Object.hasOwn(record.NetworkSettings?.Networks ?? {}, expected.networkName))
  );
}

export {
  PROTECTED_MANAGED_IMAGE_AGENTS,
  type ProtectedManagedImageContract,
  parseProtectedManagedImageContracts,
} from "./protected-managed-image-contract.ts";

export const MANAGED_IMAGE_LOCAL_INFERENCE_KINDS = ["llama-cpp", "ollama", "nim", "vllm"] as const;

export type ManagedImageLocalInferenceKind = (typeof MANAGED_IMAGE_LOCAL_INFERENCE_KINDS)[number];

export type ManagedImageProtectedRouteKind = ManagedImageLocalInferenceKind | "rollback";

// OpenShell 0.0.106 caps routable sandbox names at 19 characters. Keep the
// protected-runtime ownership prefix and every agent/route discriminator
// explicit so the qualification matrix remains deterministic and collision
// free without relying on truncation.
export const MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX = "nmc-mi-";

const PROTECTED_SANDBOX_AGENT_TOKENS: Readonly<Record<ShippedManagedImageAgent, string>> =
  Object.freeze({
    openclaw: "oc",
    hermes: "he",
    "langchain-deepagents-code": "dc",
  });

const PROTECTED_SANDBOX_ROUTE_TOKENS: Readonly<Record<ManagedImageProtectedRouteKind, string>> =
  Object.freeze({
    "llama-cpp": "lc",
    ollama: "ol",
    nim: "ni",
    vllm: "vl",
    rollback: "rb",
  });

export type ManagedImageLocalInferenceRoute = {
  readonly kind: ManagedImageLocalInferenceKind;
  readonly providerName: "llama-cpp-local" | "ollama-local" | "vllm-local";
  readonly credentialEnv:
    | "NEMOCLAW_LLAMACPP_LOCAL_TOKEN"
    | "NEMOCLAW_OLLAMA_PROXY_TOKEN"
    | "NEMOCLAW_VLLM_LOCAL_TOKEN";
  readonly defaultBaseUrl: string;
};

const LOCAL_INFERENCE_ROUTES: Readonly<
  Record<ManagedImageLocalInferenceKind, ManagedImageLocalInferenceRoute>
> = Object.freeze({
  "llama-cpp": Object.freeze({
    kind: "llama-cpp",
    providerName: "llama-cpp-local",
    credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
    defaultBaseUrl: "http://host.openshell.internal:8081/v1",
  }),
  ollama: Object.freeze({
    kind: "ollama",
    providerName: "ollama-local",
    credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    defaultBaseUrl: "http://host.openshell.internal:11435/v1",
  }),
  // Local NIM exposes the same OpenAI-compatible host route as local vLLM.
  // Keep the source kinds distinct even though OpenShell intentionally binds
  // both to vllm-local; this prevents a future engine-specific route change
  // from being silently treated as equivalent.
  nim: Object.freeze({
    kind: "nim",
    providerName: "vllm-local",
    credentialEnv: "NEMOCLAW_VLLM_LOCAL_TOKEN",
    defaultBaseUrl: "http://host.openshell.internal:8000/v1",
  }),
  vllm: Object.freeze({
    kind: "vllm",
    providerName: "vllm-local",
    credentialEnv: "NEMOCLAW_VLLM_LOCAL_TOKEN",
    defaultBaseUrl: "http://host.openshell.internal:8000/v1",
  }),
});

export function isManagedImageLocalInferenceKind(
  value: string,
): value is ManagedImageLocalInferenceKind {
  return (MANAGED_IMAGE_LOCAL_INFERENCE_KINDS as readonly string[]).includes(value);
}

export function resolveManagedImageLocalInferenceRoute(
  kind: ManagedImageLocalInferenceKind,
): ManagedImageLocalInferenceRoute {
  return LOCAL_INFERENCE_ROUTES[kind];
}

export function withManagedImageLocalInferenceProfile(
  profile: ManagedStartupProfile,
  route: ManagedImageLocalInferenceRoute,
  model: string,
  maximumOutputTokens?: number,
): ManagedStartupProfile {
  if (
    maximumOutputTokens !== undefined &&
    (!Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens < 1)
  )
    throw new Error("managed local inference output token limit is invalid");
  const primaryModelRef =
    profile.agent === "openclaw"
      ? `inference/${model}`
      : (profile.inference?.primaryModelRef ?? null);
  return {
    ...profile,
    ...(profile.agent === "openclaw" && maximumOutputTokens !== undefined
      ? { tuning: { ...profile.tuning, maxTokens: maximumOutputTokens } }
      : {}),
    inference: {
      compatibility: profile.agent === "openclaw" ? {} : null,
      inputModalities: profile.agent === "openclaw" ? ["text"] : null,
      ...profile.inference,
      routeProvider: "inference",
      upstreamProvider: route.providerName,
      model,
      primaryModelRef,
      routedBaseUrl: route.defaultBaseUrl,
      upstreamEndpointUrl:
        profile.agent === "langchain-deepagents-code" ? route.defaultBaseUrl : null,
      api: "openai-completions",
    },
  } as ManagedStartupProfile;
}

export function managedImageProtectedSandboxName(
  agent: ShippedManagedImageAgent,
  routeKind: ManagedImageProtectedRouteKind,
): string {
  return `${MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX}${PROTECTED_SANDBOX_AGENT_TOKENS[agent]}-${PROTECTED_SANDBOX_ROUTE_TOKENS[routeKind]}`;
}

export function managedImageFailureDetail(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const redactor = createDockerGpuDiagnosticRedactor();
  redactor.rememberInspect({
    Config: { Env: Object.entries(env).map(([key, value]) => `${key}=${value ?? ""}`) },
  });
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return redactor.redactText(detail).slice(0, 8_000);
}

export function createManagedImageSandboxWithDiagnostics(
  run: Parameters<typeof createCliOpenShellSandboxLifecycleFromRunner>[0],
  resolveBinary: () => string,
) {
  const { createSandbox } = createCliOpenShellSandboxLifecycleFromRunner(run, { resolveBinary });
  return async (...args: Parameters<typeof createSandbox>) => {
    const result = await createSandbox(...args);
    if (result.status !== 0 || result.ambiguous) {
      console.error(
        `Managed-image create evidence: ${managedImageFailureDetail(result.diagnostic)}`,
      );
    }
    return result;
  };
}

export type ManagedImageOpenShellE2eInputs = {
  agent: ShippedManagedImageAgent;
  image: string;
  sandbox: string;
  gpu?: true;
  localProvider?: ManagedImageLocalInferenceKind;
  model?: string;
  failureInjection?: "bootstrap-completion";
};

export function managedImageLocalInferenceBaseUrl(
  localProvider: ManagedImageLocalInferenceKind,
  configuredValue = process.env.NEMOCLAW_E2E_LOCAL_INFERENCE_BASE_URL,
): string {
  const route = resolveManagedImageLocalInferenceRoute(localProvider);
  const configured = String(configuredValue ?? "").trim();
  const value = configured || route.defaultBaseUrl;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("protected local inference base URL is invalid");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "host.openshell.internal" ||
    !/^[1-9][0-9]{0,4}$/u.test(parsed.port) ||
    parsed.pathname.replace(/\/+$/u, "") !== "/v1" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("protected local inference must use http://host.openshell.internal:<port>/v1");
  }
  return value.replace(/\/+$/u, "");
}

function localInferenceBaseUrl(input: ManagedImageOpenShellE2eInputs): string {
  if (!input.localProvider) throw new Error("local provider is required");
  return managedImageLocalInferenceBaseUrl(input.localProvider);
}

export async function configureLocalInferenceRoute(
  onboard: {
    runOpenshell(
      args: string[],
      options?: Record<string, unknown>,
    ): ReturnType<NonNullable<Parameters<typeof createManagedProviderAdapter>[0]>>;
  },
  input: ManagedImageOpenShellE2eInputs,
  env: NodeJS.ProcessEnv,
  adapter: Parameters<
    typeof ensureNativeLocalProvider
  >[0]["adapter"] = createManagedProviderAdapter(onboard.runOpenshell),
): Promise<NativeLocalProviderAttachment | undefined> {
  if (!input.localProvider || !input.model) return;
  const route = resolveManagedImageLocalInferenceRoute(input.localProvider);
  const credential = String(env[route.credentialEnv] ?? "").trim();
  if (!credential || /[\0\r\n]/u.test(credential)) {
    throw new Error(`${route.credentialEnv} is required for protected local inference`);
  }
  let authority: NativeLocalProviderAttachment | undefined;
  return ensureNativeLocalProvider({
    binding: {
      provider: route.providerName,
      ...(input.agent === "langchain-deepagents-code" ? {} : { agent: input.agent }),
      endpointUrl: localInferenceBaseUrl(input),
      credentialEnv: NATIVE_LOCAL_CREDENTIAL_ENV,
      authMode:
        input.localProvider === "nim" || input.localProvider === "vllm"
          ? "sentinel"
          : "authenticated",
      gatewayName: "nemoclaw",
      sandboxName: input.sandbox,
    },
    adapter,
    credentialValue: credential,
    policyCommand: async (args) => onboard.runOpenshell(args, { ignoreError: true, env }),
    // This invocation owns a fresh private gateway. Never adopt an existing provider.
    readAuthority: () => authority,
    writeAuthority: (receipt) => {
      authority = receipt;
    },
  });
}

export function localInferenceProbe(input: ManagedImageOpenShellE2eInputs): [string, ...string[]] {
  if (!input.model) throw new Error("local inference model is required");
  const payload = JSON.stringify({
    model: input.model,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    reasoning_effort: "none",
    max_tokens: 32,
  });
  const script = [
    "set -eu",
    NATIVE_LOCAL_AUTH_HEADER_SCRIPT,
    'response="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-managed-image-inference.XXXXXX")"',
    "trap 'rm -f \"$response\"' EXIT",
    'curl -fsS --max-time 180 "$1" -H "$AUTH_HEADER" -H \'Content-Type: application/json\' --data "$2" > "$response"',
    "node - \"$response\" <<'NODE'",
    'const fs = require("node:fs");',
    'const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));',
    "const choice = Array.isArray(body.choices) ? body.choices[0] : null;",
    'const text = choice && choice.message && typeof choice.message.content === "string"',
    "  ? choice.message.content",
    '  : choice && typeof choice.text === "string" ? choice.text : "";',
    'if (!/pong/i.test(text)) throw new Error("local inference did not return PONG");',
    "NODE",
  ].join("\n");
  return [
    "/bin/sh",
    "-eu",
    "-c",
    script,
    "native-local-inference",
    `${localInferenceBaseUrl(input)}/chat/completions`,
    payload,
  ];
}

export function localInferenceAgentCommand(input: ManagedImageOpenShellE2eInputs): string[] {
  const prompt = "Reply with exactly one word: PONG";
  switch (input.agent) {
    case "openclaw":
      return [
        "openclaw",
        "agent",
        "--agent",
        "main",
        "--json",
        "--thinking",
        "off",
        "--session-id",
        `protected-${input.sandbox}`,
        "-m",
        prompt,
      ];
    case "hermes":
      return ["hermes", "-z", prompt];
    case "langchain-deepagents-code":
      return ["dcode", "-n", prompt, "--json"];
  }
}

export async function waitForLocalInferenceAgentPairing<
  T extends {
    readonly status: number | null;
    readonly stderr: string | null;
    readonly error?: Error;
  },
>(
  agent: ShippedManagedImageAgent,
  run: () => T,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const result = run();
    if (
      agent !== "openclaw" ||
      result.error ||
      result.status !== 1 ||
      attempt === 3 ||
      !/scope upgrade pending approval/iu.test(result.stderr ?? "")
    )
      return result;
    // The normal watcher approves allowlisted scopes asynchronously.
    await sleep(5_000);
  }
}

function openClawAnswerDiagnostic(envelope: unknown): string {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const category = (value: unknown, allowed: readonly string[]) =>
    typeof value === "string" && allowed.includes(value)
      ? value
      : value === undefined
        ? "absent"
        : "other";
  const length = (value: unknown) => (typeof value === "string" ? value.length : null);
  const flag = (value: unknown) => (typeof value === "boolean" ? value : null);
  const result = record(record(envelope).result);
  const meta = record(result.meta);
  const completion = record(meta.completion);
  const payloads = Array.isArray(result.payloads) ? result.payloads : null;
  const sampled = payloads?.slice(0, 32) ?? [];
  const textLengths = sampled.map((payload) => length(record(payload).text));
  // Only fixed categories and scalar measurements may leave the agent envelope.
  return JSON.stringify({
    payloadCount: payloads?.length ?? null,
    sampledPayloadCount: sampled.length,
    payloadTextLengths: textLengths,
    finalVisibleTextLength: length(meta.finalAssistantVisibleText),
    finalRawTextLength: length(meta.finalAssistantRawText),
    stopReason: category(meta.stopReason, [
      "stop",
      "length",
      "toolUse",
      "tool_calls",
      "end_turn",
      "error",
      "aborted",
      "superseded",
    ]),
    terminalReplyKind: category(meta.terminalReplyKind, ["silent-empty"]),
    livenessState: category(meta.livenessState, ["blocked", "completed", "paused"]),
    aborted: flag(meta.aborted),
    yielded: flag(meta.yielded),
    continuationPending: flag(meta.continuationPending),
    refusal: flag(completion.refusal),
    pendingToolCallCount: Array.isArray(meta.pendingToolCalls)
      ? meta.pendingToolCalls.length
      : null,
  });
}

export function assertLocalInferenceAgentResponse(
  input: ManagedImageOpenShellE2eInputs,
  stdout: string,
  routeCompleted: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!routeCompleted)
    throw new Error(`${input.agent} did not complete a request through its configured local model`);
  let response: unknown = stdout;
  let openClawDiagnostic: string | undefined;
  if (input.agent === "openclaw") {
    const envelope = JSON.parse(stdout);
    openClawDiagnostic = openClawAnswerDiagnostic(envelope);
    const result = envelope?.result;
    if (
      envelope?.status !== "ok" ||
      result?.meta?.aborted !== false ||
      result?.meta?.agentMeta?.provider !== "inference" ||
      result?.meta?.agentMeta?.model !== input.model
    )
      throw new Error(
        `OpenClaw did not complete through its configured local model; diagnostic=${openClawDiagnostic}`,
      );
    response = result.payloads?.map((payload: { text?: string }) => payload.text ?? "").join("\n");
  } else if (input.agent === "langchain-deepagents-code") {
    const envelope = JSON.parse(stdout);
    if (envelope?.data?.status !== "success" || envelope?.data?.exit_code !== 0)
      throw new Error("LangChain Deep Agents Code did not complete its local inference turn");
    response = envelope.data.response;
  }
  // The direct provider probe owns the PONG assertion. Agent models may answer
  // the same prompt differently, so require a completed assistant turn here.
  const answer = typeof response === "string" ? response.trim() : "";
  if (!answer || /reply with exactly one word: pong/iu.test(answer))
    throw new Error(
      `${input.agent} local inference returned no assistant answer; ${
        openClawDiagnostic === undefined
          ? `response=${JSON.stringify(managedImageFailureDetail(response, env).slice(0, 512))}`
          : `diagnostic=${openClawDiagnostic}`
      }`,
    );
}

export async function readProtectedLocalInferenceCount(
  input: ManagedImageOpenShellE2eInputs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const ollama = input.localProvider === "ollama";
  const routePort = Number(new URL(localInferenceBaseUrl(input)).port);
  const portText = ollama ? String(routePort) : env.NEMOCLAW_PROTECTED_INFERENCE_RECEIPT_PORT;
  const token = ollama
    ? env.NEMOCLAW_OLLAMA_PROXY_TOKEN
    : env.NEMOCLAW_PROTECTED_INFERENCE_RECEIPT_TOKEN;
  const port = Number(portText);
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    port !== routePort ||
    !token ||
    !/^[a-f0-9]{48}$/u.test(token)
  )
    throw new Error("protected local inference receipt authority is unavailable");
  const model = input.model ?? "";
  if (ollama && !model) throw new Error("protected local inference receipt model is unavailable");
  const receiptPath = ollama
    ? `/_nemoclaw/e2e-inference-receipt?${new URLSearchParams({ model })}`
    : "/_nemoclaw/e2e-inference-receipt";
  const response = await fetch(`http://127.0.0.1:${port}${receiptPath}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("protected local inference receipt is unavailable");
  const receipt: unknown = await response.json();
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !("completedRequests" in receipt) ||
    !Number.isSafeInteger(receipt.completedRequests) ||
    (receipt.completedRequests as number) < 0 ||
    (ollama && (!("model" in receipt) || receipt.model !== model))
  )
    throw new Error("protected local inference receipt is malformed");
  return receipt.completedRequests as number;
}

export async function verifyManagedImageLocalInferenceRoute(
  run: NonNullable<Parameters<typeof createManagedProviderAdapter>[0]>,
  sandboxName: string,
  expected: NativeLocalProviderAttachment,
): Promise<void> {
  await verifyNativeLocalProviderAttachment({
    adapter: createManagedProviderAdapter(run),
    sandboxName,
    expected,
    requireUnexpiredCredential: true,
  });
}

export function managedImageHarnessContainerListArgs(
  sandbox: string,
  includeStopped: boolean,
  runtimeVersion: ManagedImageHarnessOpenShellVersion,
): string[] {
  return [
    "docker",
    "ps",
    includeStopped ? "-aq" : "-q",
    "--no-trunc",
    "--filter",
    "label=openshell.ai/managed-by=openshell",
    "--filter",
    `label=openshell.ai/sandbox-name=${sandbox}`,
    ...(runtimeVersion === "0.1.3" || runtimeVersion === "0.1.5"
      ? ["--filter", "label=openshell.ai/isolation-role=sandbox"]
      : []),
  ];
}

export function managedImageSandboxListLimitFlag(
  runtimeVersion: ManagedImageHarnessOpenShellVersion,
): string {
  return runtimeVersion === "0.1.3" || runtimeVersion === "0.1.5" ? "--page-size" : "--limit";
}
