// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type CaptureOpenshellResult, stripAnsi } from "../adapters/openshell/client";
import {
  checkOpenAiInferenceProviderProfile,
  OPENAI_GATEWAY_PROVIDER_TYPE,
} from "../adapters/openshell/provider-profile";
import { retryUntilAsync } from "../core/retry";
import {
  matchesGatewayProviderBinding,
  parseGatewayProviderMetadata,
} from "../onboard/gateway-provider-metadata";
import { assertHermesPortableCommandUnavailable } from "../onboard/experimental/portable-agent-lifecycle";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
  RuntimeProviderSelectionError,
  requireRuntimeProviderBundleForSandbox,
  requireRuntimeProviderMutationAuthority,
} from "../onboard/runtime-provider/access";
import type { SandboxEntry } from "../state/registry";
import {
  InferenceSetError,
  OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
  openshellReportsProviderNotFound,
} from "./inference-set-error";
import type { InferenceSetProviderBinding } from "./inference-set-route-containment";
import type {
  SandboxInferenceInvocationInput,
  SandboxInferenceInvocationResult,
} from "./sandbox/inference-invocation-probe";

export type { RuntimeProviderBundleRegistry };
export { RuntimeProviderSelectionError };

export type InferenceSetSandboxRouteProbe = (
  input: SandboxInferenceInvocationInput,
) => SandboxInferenceInvocationResult;

// OpenShell 0.0.106 refreshes the sandbox route cache every five seconds.
// A stale route can still return a valid 2xx response, so wait one complete
// refresh interval before probing a changed provider/model selection.
const ROUTE_SELECTION_REFRESH_WAIT_MS = 6_000;
const ROUTE_FAMILY_CONVERGENCE_RETRY_DELAYS_MS = [2_000, 4_000] as const;

export function sleepInferenceSetRouteConvergence(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function probeInferenceSetSandboxRoute(
  input: SandboxInferenceInvocationInput,
): SandboxInferenceInvocationResult {
  const probe: typeof import("./sandbox/inference-invocation-probe") = require("./sandbox/inference-invocation-probe");
  return probe.probeSandboxInferenceInvocation(
    input,
    {},
    probe.READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
  );
}

export async function probeInferenceSetSandboxRouteUntilConverged(
  options: {
    input: SandboxInferenceInvocationInput;
    previousProvider: string;
    previousModel: string;
    previousInferenceApi: string | null;
    targetInferenceApi: string | null;
  },
  deps: {
    probe: InferenceSetSandboxRouteProbe;
    sleep: (milliseconds: number) => Promise<void>;
    onRetry?: (
      result: SandboxInferenceInvocationResult,
      delayMs: number,
      attempt: number,
    ) => void | Promise<void>;
  } = {
    probe: probeInferenceSetSandboxRoute,
    sleep: sleepInferenceSetRouteConvergence,
  },
): Promise<SandboxInferenceInvocationResult> {
  const routeSelectionChanged =
    options.previousProvider !== options.input.provider ||
    options.previousModel !== options.input.model;
  if (routeSelectionChanged) {
    await deps.sleep(ROUTE_SELECTION_REFRESH_WAIT_MS);
  }
  const inferenceApiChanged = options.previousInferenceApi !== options.targetInferenceApi;
  return await retryUntilAsync(() => deps.probe(options.input), {
    accept: (result) =>
      result.ok || !inferenceApiChanged || (result.httpStatus !== 400 && result.httpStatus !== 404),
    retryDelaysMs: ROUTE_FAMILY_CONVERGENCE_RETRY_DELAYS_MS,
    onRetry: deps.onRetry,
    sleep: deps.sleep,
  });
}

export function requireInferenceSetRuntimeAuthority(
  entry: SandboxEntry,
  providers: RuntimeProviderBundleRegistry = CURRENT_RUNTIME_PROVIDER_BUNDLES,
): void {
  const runtimeProvider = requireRuntimeProviderBundleForSandbox(entry, providers);
  requireRuntimeProviderMutationAuthority(runtimeProvider, "inference-set");
}

export function assertInferenceSetCommandAvailable(sandboxName: string): void {
  assertHermesPortableCommandUnavailable(sandboxName, "inference:set");
}

type CaptureProviderCommand = (
  args: string[],
  options: {
    ignoreError: true;
    includeStreams: true;
    maxBuffer: number;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
) => CaptureOpenshellResult;

type ProviderSurface = {
  type: "openai" | "anthropic";
  configKey: "OPENAI_BASE_URL" | "ANTHROPIC_BASE_URL";
};

type ProviderObservation =
  | { kind: "absent" }
  | {
      kind: "present";
      id: string;
      resourceVersion: number;
      metadata: NonNullable<ReturnType<typeof parseGatewayProviderMetadata>>;
    }
  | { kind: "error"; status: number | null };

function providerSurface(binding: InferenceSetProviderBinding): ProviderSurface {
  return binding.providerType === "anthropic"
    ? { type: "anthropic", configKey: "ANTHROPIC_BASE_URL" }
    : { type: "openai", configKey: "OPENAI_BASE_URL" };
}

function resultText(result: CaptureOpenshellResult): string {
  // includeStreams=true normally makes `output` a duplicate aggregate of
  // stdout/stderr. Parse the split streams when present and use `output` only
  // as the compatibility fallback so strict duplicate-field checks keep
  // working on normal OpenShell results.
  const hasStreams = result.stdout !== undefined || result.stderr !== undefined;
  const combined = hasStreams
    ? `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    : String(result.output ?? "");
  return Buffer.from(combined, "utf8")
    .subarray(0, OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER)
    .toString("utf8");
}

function parseProviderVersion(output: string): { id: string; resourceVersion: number } | null {
  const clean = stripAnsi(output);
  const ids = Array.from(clean.matchAll(/^\s*Id:\s*([A-Za-z0-9._:-]{1,128})\s*$/gimu));
  const versions = Array.from(clean.matchAll(/^\s*Resource version:\s*([0-9]+)\s*$/gimu));
  if (ids.length !== 1 || versions.length !== 1) return null;
  const resourceVersion = Number(versions[0][1]);
  if (!Number.isSafeInteger(resourceVersion) || resourceVersion < 1) return null;
  return { id: ids[0][1], resourceVersion };
}

function inspectProvider(
  captureOpenshell: CaptureProviderCommand,
  gatewayName: string,
  providerName: string,
): ProviderObservation {
  const result = captureOpenshell(["provider", "get", "-g", gatewayName, providerName], {
    ignoreError: true,
    includeStreams: true,
    maxBuffer: OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
  });
  const output = resultText(result);
  if (result.status !== 0) {
    return providerLookupReportsNotFound(output, providerName)
      ? { kind: "absent" }
      : { kind: "error", status: result.status };
  }
  const metadata = parseGatewayProviderMetadata(output);
  const version = parseProviderVersion(output);
  if (!metadata || !version) return { kind: "error", status: result.status };
  return { kind: "present", ...version, metadata };
}

function providerLookupReportsNotFound(output: string, providerName: string): boolean {
  if (openshellReportsProviderNotFound(output, providerName)) return true;
  // OpenShell 0.0.99 omits the name only from this exact-name `provider get`
  // command. Keep the route-update parser strict because its output can name
  // a different missing provider.
  return stripAnsi(output)
    .toLowerCase()
    .split("\n")
    .some(
      (line) =>
        /code:\s*['"]some requested entity was not found['"]/u.test(line) &&
        /message:\s*['"]provider not found['"]/u.test(line),
    );
}

function expectedShape(providerName: string, surface: ProviderSurface, credentialEnv: string) {
  return {
    name: providerName,
    type: surface.type,
    credentialKey: credentialEnv,
    configKey: surface.configKey,
  };
}

function assertProviderOwnership(options: {
  observation: ProviderObservation;
  providerName: string;
  surface: ProviderSurface;
  binding: InferenceSetProviderBinding;
}): "create" | "update" {
  const { observation, providerName, surface, binding } = options;
  if (observation.kind === "absent") return "create";
  if (observation.kind === "error") {
    throw new InferenceSetError(
      `Could not inspect provider '${providerName}' (status ${observation.status ?? "unknown"}); no provider mutation was attempted.`,
      1,
    );
  }
  if (
    !matchesGatewayProviderBinding(
      observation.metadata,
      expectedShape(providerName, surface, binding.credentialEnv),
    )
  ) {
    throw new InferenceSetError(
      `Refusing to replace provider '${providerName}': its live binding is malformed, foreign, or does not match this sandbox's durable custom-endpoint provenance. Re-run onboarding to reconcile the provider safely.`,
      2,
    );
  }
  return "update";
}

function mutationArgs(options: {
  action: "create" | "update";
  gatewayName: string;
  providerName: string;
  surface: ProviderSurface;
  credentialEnv: string;
  baseUrl: string;
}): string[] {
  const args =
    options.action === "create"
      ? [
          "provider",
          "create",
          "-g",
          options.gatewayName,
          "--name",
          options.providerName,
          "--type",
          options.surface.type,
        ]
      : ["provider", "update", "-g", options.gatewayName, options.providerName];
  args.push(
    "--credential",
    options.credentialEnv,
    "--config",
    `${options.surface.configKey}=${options.baseUrl}`,
  );
  return args;
}

export function prepareInferenceSetProviderBinding(options: {
  gatewayName: string;
  providerName: string;
  binding: InferenceSetProviderBinding;
  captureOpenshell: CaptureProviderCommand;
}): { action: "create" | "update"; commit: () => void; rollback: () => void } {
  const { gatewayName, providerName, binding, captureOpenshell } = options;
  const surface = providerSurface(binding);
  const before = inspectProvider(captureOpenshell, gatewayName, providerName);
  const action = assertProviderOwnership({
    observation: before,
    providerName,
    surface,
    binding,
  });

  const apply = (): void => {
    if (surface.type === OPENAI_GATEWAY_PROVIDER_TYPE) {
      const profile = checkOpenAiInferenceProviderProfile({
        runOpenshell: (args, runnerOptions) =>
          captureOpenshell(
            args[0] === "provider" && args[1] === "profile"
              ? [args[0], args[1], "-g", gatewayName, ...args.slice(2)]
              : args,
            {
              ignoreError: true,
              includeStreams: true,
              maxBuffer: OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
              timeout: runnerOptions?.timeout,
            },
          ),
      });
      if (!profile.ok) {
        throw new InferenceSetError(profile.messages.join("\n").trim(), 1);
      }
    }
    const result = captureOpenshell(
      mutationArgs({
        action,
        gatewayName,
        providerName,
        surface,
        credentialEnv: binding.credentialEnv,
        baseUrl: binding.baseUrl,
      }),
      {
        ignoreError: true,
        includeStreams: true,
        maxBuffer: OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
        env: { [binding.credentialEnv]: binding.token },
      },
    );
    const after = inspectProvider(captureOpenshell, gatewayName, providerName);
    if (result.status !== 0) {
      throw new InferenceSetError(
        `Failed to ${action} provider '${providerName}' on gateway '${gatewayName}' (status ${result.status ?? "unknown"}). ` +
          `The provider command may have partially applied; retry this command or re-run onboarding to converge the requested binding.`,
        1,
      );
    }
    if (
      after.kind !== "present" ||
      (action === "update" &&
        (before.kind !== "present" ||
          after.id !== before.id ||
          after.resourceVersion <= before.resourceVersion)) ||
      !matchesGatewayProviderBinding(
        after.metadata,
        expectedShape(providerName, surface, binding.credentialEnv),
      )
    ) {
      throw new InferenceSetError(
        `Provider '${providerName}' did not converge to the expected type and binding-key shape after ${action}. ` +
          `Provider state may be partial; retry this command or re-run onboarding to reconcile it.`,
        1,
      );
    }
  };

  if (action === "update") {
    return {
      action,
      commit: apply,
      rollback: () => {},
    };
  }

  apply();
  return {
    action,
    commit: () => {},
    rollback: () => {
      const result = captureOpenshell(["provider", "delete", "-g", gatewayName, providerName], {
        ignoreError: true,
        includeStreams: true,
        maxBuffer: OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
      });
      const restored = inspectProvider(captureOpenshell, gatewayName, providerName);
      if (result.status !== 0 || restored.kind !== "absent") {
        throw new InferenceSetError(
          `Failed to remove newly created provider '${providerName}' after inference selection failed.`,
          1,
        );
      }
    },
  };
}

export const __test = {
  inspectProvider,
  parseProviderVersion,
  providerSurface,
  providerLookupReportsNotFound,
  mutationArgs,
};
