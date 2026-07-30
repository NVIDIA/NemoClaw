// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface SandboxRuntimeAuthorityAdapter<TContext> {
  readonly driverName: string;
  resolve(context: TContext): unknown;
  revalidate?(authority: unknown, context: TContext): void;
}

export type SandboxRuntimeAuthorityAdapterRegistry<TContext> = Readonly<
  Record<string, SandboxRuntimeAuthorityAdapter<TContext>>
>;

/**
 * Resolve driver-owned sandbox-create authority without teaching the workflow
 * coordinator about individual runtimes. A null result is a deliberate
 * no-authority contract (for example Kubernetes direct creation), while an
 * absent or mismatched adapter fails closed.
 */
export function resolveSandboxRuntimeAuthority<TContext>(
  driverName: string,
  context: TContext,
  adapters: SandboxRuntimeAuthorityAdapterRegistry<TContext>,
): unknown {
  const adapter = Object.hasOwn(adapters, driverName) ? adapters[driverName] : undefined;
  if (!adapter || adapter.driverName !== driverName) {
    throw new Error(`OpenShell compute driver '${driverName}' has no runtime-authority adapter.`);
  }
  return adapter.resolve(context);
}

export function revalidateSandboxRuntimeAuthority<TContext>(
  driverName: string,
  authority: unknown,
  context: TContext,
  adapters: SandboxRuntimeAuthorityAdapterRegistry<TContext>,
): void {
  const adapter = Object.hasOwn(adapters, driverName) ? adapters[driverName] : undefined;
  if (!adapter || adapter.driverName !== driverName) {
    throw new Error(`OpenShell compute driver '${driverName}' has no runtime-authority adapter.`);
  }
  if (adapter.revalidate) {
    adapter.revalidate(authority, context);
    return;
  }
  if (authority != null) {
    throw new Error(
      `OpenShell compute driver '${driverName}' has no runtime-authority revalidation hook.`,
    );
  }
}

export interface AuthorizedSandboxRecreateDeletionSteps {
  beforeDelete(): void;
  deleteSandbox(): void;
  afterDelete(): void;
}

/**
 * Resolve the selected driver's exact authority before entering the ordinary
 * recreate deletion boundary. A failed qualification therefore cannot run
 * provider cleanup, sandbox deletion, or any post-delete runtime mutation.
 */
export function runAuthorizedSandboxRecreateDeletion<TContext>(
  driverName: string,
  context: TContext,
  adapters: SandboxRuntimeAuthorityAdapterRegistry<TContext>,
  steps: AuthorizedSandboxRecreateDeletionSteps,
): unknown {
  const authority = resolveSandboxRuntimeAuthority(driverName, context, adapters);
  steps.beforeDelete();
  revalidateSandboxRuntimeAuthority(driverName, authority, context, adapters);
  steps.deleteSandbox();
  steps.afterDelete();
  return authority;
}
