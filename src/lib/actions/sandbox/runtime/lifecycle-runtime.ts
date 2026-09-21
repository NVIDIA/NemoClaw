// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundle,
  type RuntimeProviderBundleRegistry,
  normalizeRuntimeProviderIdentity,
  resolveRuntimeProviderBundle,
} from "../../../onboard/runtime-provider/access";
import type {
  RuntimeProviderLifecycleAction,
  RuntimeProviderLifecycleResult,
} from "../../../onboard/runtime-provider/contract";
import { cliName } from "../../../onboard/branding";
import type { SandboxEntry } from "../../../state/registry/types";
import {
  mutateStandardSandboxLifecycle,
  type StandardSandboxLifecycleDeps,
} from "./standard-lifecycle";

export type { RuntimeProviderLifecycleResult as SandboxLifecycleResult };

export type SandboxLifecycleProviderResolution =
  | {
      readonly ok: true;
      readonly sandbox: SandboxEntry;
      readonly bundle: RuntimeProviderBundle;
      readonly control: Extract<RuntimeProviderBundle["lifecycle"], { readonly supported: true }>;
    }
  | {
      readonly ok: false;
      readonly result: RuntimeProviderLifecycleResult;
    };

/**
 * Resolve the exact provider recorded on the sandbox. The action layer never
 * infers lifecycle behavior from a gateway launcher or container-engine name.
 */
export function resolveSandboxLifecycleProvider(
  sandboxName: string,
  sandbox: SandboxEntry | null,
  action: RuntimeProviderLifecycleAction,
  providers: RuntimeProviderBundleRegistry,
): SandboxLifecycleProviderResolution {
  if (!sandbox) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        message:
          `  Sandbox '${sandboxName}' is not registered. ` +
          `Run '${cliName()} list' to see registered sandboxes.`,
      },
    };
  }
  const providerId = normalizeRuntimeProviderIdentity(sandbox.openshellDriver);
  const bundle = resolveRuntimeProviderBundle(providerId, providers);
  if (!bundle) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        message:
          `  '${cliName()} ${sandboxName} ${action}' has no registered lifecycle ` +
          `provider for '${providerId}'.`,
      },
    };
  }
  if (bundle.lifecycle.supported !== true) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        message:
          `  '${cliName()} ${sandboxName} ${action}' is unavailable for runtime provider ` +
          `'${providerId}': ${bundle.lifecycle.reason}`,
      },
    };
  }
  return { ok: true, sandbox, bundle, control: bundle.lifecycle };
}

export interface RegisteredStandardLifecycleDeps extends StandardSandboxLifecycleDeps {
  readonly environment?: NodeJS.ProcessEnv;
  readonly gatewayName?: string;
  readonly log?: (message: string) => void;
  readonly readRegistry?: (sandboxName: string) => SandboxEntry | null;
  readonly runtimeProviders?: RuntimeProviderBundleRegistry;
}

/** Resolve registered provider ownership before crossing the standard OpenShell mutation boundary. */
export async function mutateRegisteredStandardSandboxLifecycle(
  action: RuntimeProviderLifecycleAction,
  sandboxName: string,
  sandbox: SandboxEntry | null,
  deps: RegisteredStandardLifecycleDeps = {},
): Promise<RuntimeProviderLifecycleResult> {
  const resolved = resolveSandboxLifecycleProvider(
    sandboxName,
    sandbox,
    action,
    deps.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  if (!resolved.ok) return resolved.result;
  return await mutateStandardSandboxLifecycle(
    action,
    {
      environment: deps.environment ?? process.env,
      ...(deps.gatewayName ? { gatewayName: deps.gatewayName } : {}),
      log: deps.log ?? console.error,
      readRegistry: deps.readRegistry,
      sandbox: resolved.sandbox,
      sandboxName,
    },
    deps,
  );
}
