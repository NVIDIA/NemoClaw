// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type RuntimeProviderBundle,
  type RuntimeProviderBundleRegistry,
  normalizeRuntimeProviderIdentity,
  requireRuntimeProviderMutationAuthority,
  resolveRuntimeProviderBundle,
  RuntimeProviderSelectionError,
} from "../../../onboard/runtime-provider/access";
import type {
  RuntimeProviderLifecycleAction,
  RuntimeProviderLifecycleResult,
} from "../../../onboard/runtime-provider/contract";
import { cliName } from "../../../onboard/branding";
import type { SandboxEntry } from "../../../state/registry/types";

export type { RuntimeProviderLifecycleResult as SandboxLifecycleResult };

export type SandboxLifecycleProviderResolution =
  | {
      readonly ok: true;
      readonly sandbox: SandboxEntry;
      readonly bundle: RuntimeProviderBundle;
      readonly lifecycle: Extract<RuntimeProviderBundle["lifecycle"], { readonly supported: true }>;
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
  try {
    requireRuntimeProviderMutationAuthority(bundle, action);
  } catch (error) {
    if (!(error instanceof RuntimeProviderSelectionError)) throw error;
    return { ok: false, result: { exitCode: 1, message: `  ${error.message}` } };
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
  return { ok: true, sandbox, bundle, lifecycle: bundle.lifecycle };
}
