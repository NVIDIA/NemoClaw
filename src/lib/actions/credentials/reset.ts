// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderError,
} from "../../adapters/openshell/provider-adapter";
import type { OpenShellGatewayTarget } from "../../adapters/openshell/sandbox-observer";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import {
  NAME_MAX_LENGTH,
  NAME_VALID_PATTERN,
  PROVIDER_NAME_VALID_PATTERN,
} from "../../name-validation";
import { CLI_NAME } from "../../cli/branding";
import {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
} from "../../inference/native-nvidia";
import {
  isBridgeProviderName,
  recoverCredentialGatewayTargetOrExit,
} from "../../credentials/command-support";
import { prompt as askPrompt, KNOWN_CREDENTIAL_ENV_KEYS } from "../../credentials/store";
import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import {
  clearNativeNvidiaProviderAuthority,
  listNativeNvidiaProviderAttachmentSandboxNames,
} from "../../state/registry/native-nvidia-provider-authority";
import { forgetExtraProvider } from "../global";

export type CredentialsResetInput = {
  provider: string;
  confirmed: boolean;
};

export type CredentialsResetResult = {
  exitCode: number;
  outputLines: readonly string[];
  failureLines: readonly string[];
};

export type CredentialsResetDeps = Readonly<{
  providerAdapter?: OpenShellProviderAdapter;
  clearNativeNvidiaProviderAuthority?: typeof clearNativeNvidiaProviderAuthority;
  listNativeNvidiaProviderAttachmentSandboxNames?: typeof listNativeNvidiaProviderAttachmentSandboxNames;
  withGatewayRouteMutationLock?: typeof withGatewayRouteMutationLock;
}>;

export type CredentialsProviderDeleteWithRecoveryResult = Readonly<{
  ok: boolean;
  error?: OpenShellProviderError;
  detachedSandboxes: readonly string[];
  recoveryFailures: readonly Readonly<{
    sandbox: string;
    error: OpenShellProviderError;
  }>[];
}>;

const KNOWN_CREDENTIAL_ENV_KEY_SET = new Set(KNOWN_CREDENTIAL_ENV_KEYS);

function validatedAttachedSandboxes(error: OpenShellProviderError | undefined): readonly string[] {
  if (error?.kind !== "command" || error.reason !== "attached") return [];
  const attachedSandboxes = error.attachedSandboxes ?? [];
  if (
    attachedSandboxes.length === 0 ||
    attachedSandboxes.some(
      (sandbox) =>
        sandbox.length === 0 ||
        sandbox.length > NAME_MAX_LENGTH ||
        !NAME_VALID_PATTERN.test(sandbox),
    )
  ) {
    return [];
  }
  return attachedSandboxes;
}

function ok(outputLines: readonly string[]): CredentialsResetResult {
  return { exitCode: 0, outputLines, failureLines: [] };
}

function fail(failureLines: readonly string[]): CredentialsResetResult {
  return { exitCode: 1, outputLines: [], failureLines };
}

function detachedSandboxGuidance(key: string, sandboxes: readonly string[]): string[] {
  const detachedSandboxes = [...new Set(sandboxes)];
  return detachedSandboxes.length === 0
    ? []
    : [
        "",
        `  Provider '${key}' was detached from sandbox(es): ${detachedSandboxes.join(", ")} during removal.`,
        "  After registering the replacement provider, rebuild each detached sandbox:",
        ...detachedSandboxes.map((sandbox) => `    ${CLI_NAME} ${sandbox} rebuild`),
      ];
}

function nativeNvidiaResetBlockers(
  deps: CredentialsResetDeps,
  gatewayName: string,
): { ok: true; sandboxes: readonly string[] } | { ok: false } {
  try {
    return {
      ok: true,
      sandboxes: (
        deps.listNativeNvidiaProviderAttachmentSandboxNames ??
        listNativeNvidiaProviderAttachmentSandboxNames
      )(gatewayName),
    };
  } catch {
    return { ok: false };
  }
}

function nativeNvidiaResetBlockedResult(sandboxes: readonly string[]): CredentialsResetResult {
  return fail([
    `  Could not remove provider '${NVIDIA_HOSTED_LOGICAL_PROVIDER}'.`,
    "",
    `  '${NVIDIA_HOSTED_LOGICAL_PROVIDER}' is recorded by sandbox(es): ${sandboxes.join(", ")}.`,
    "  No provider or ownership authority was changed.",
    `  To rotate the credential in place, set ${NVIDIA_HOSTED_CREDENTIAL_ENV} and rerun '${CLI_NAME} onboard --name <sandbox>'.`,
    "  To remove the provider completely, preserve any required sandbox state, destroy every recorded sandbox,",
    `  then rerun '${CLI_NAME} credentials reset ${NVIDIA_HOSTED_LOGICAL_PROVIDER}'.`,
    ...sandboxes.map((sandbox) => `    ${CLI_NAME} ${sandbox} destroy`),
  ]);
}

export async function runCredentialsResetAction(
  input: CredentialsResetInput,
  deps: CredentialsResetDeps = {},
): Promise<CredentialsResetResult> {
  const key = input.provider;
  const nativeNvidiaProvider =
    key === NVIDIA_HOSTED_LOGICAL_PROVIDER || key === NVIDIA_HOSTED_NATIVE_PROVIDER;
  const providerName = nativeNvidiaProvider ? NVIDIA_HOSTED_NATIVE_PROVIDER : key;
  const publicKey = nativeNvidiaProvider ? NVIDIA_HOSTED_LOGICAL_PROVIDER : key;
  if (!PROVIDER_NAME_VALID_PATTERN.test(key)) {
    return fail([
      "  Provider name must be 1-128 chars, start with a letter, and use only letters, digits, '.', '_', or '-'.",
    ]);
  }
  if (isBridgeProviderName(key)) {
    return fail([
      `  '${key}' is a per-sandbox messaging bridge, not a credential.`,
      `  Use \`${CLI_NAME} <sandbox> channels remove <channel>\` to retire`,
      "  the integration (it tears down the bridge provider and rebuilds the sandbox),",
      `  or \`${CLI_NAME} <sandbox> channels stop <channel>\` to pause it without clearing tokens.`,
    ]);
  }

  if (!input.confirmed) {
    const answer = (
      await askPrompt(`  Remove provider '${key}' from the OpenShell gateway? [y/N]: `)
    )
      .trim()
      .toLowerCase();
    if (answer !== "y" && answer !== "yes") return ok(["  Cancelled."]);
  }

  const recoveryFailureLines: string[] = [];
  const target = await recoverCredentialGatewayTargetOrExit("mutation", (lines) => {
    recoveryFailureLines.push(...lines);
  });
  if (!target) return fail(recoveryFailureLines);

  const providerAdapter = deps.providerAdapter ?? createCliOpenShellProviderAdapter();
  const resetProvider = async (): Promise<CredentialsResetResult> => {
    if (nativeNvidiaProvider) {
      const blockers = nativeNvidiaResetBlockers(deps, target.gatewayName);
      if (!blockers.ok) {
        return fail([
          `  Could not safely inspect native NVIDIA inference ownership on gateway '${target.gatewayName}'.`,
          "  No provider or ownership authority was changed.",
          "  Repair the existing NemoClaw state and retry.",
        ]);
      }
      if (blockers.sandboxes.length > 0) {
        return nativeNvidiaResetBlockedResult(blockers.sandboxes);
      }
    }

    const recovery = await deleteProviderWithRecovery(providerName, target, providerAdapter, {
      detachAttached: !nativeNvidiaProvider,
    });

    if (
      !recovery.ok &&
      !KNOWN_CREDENTIAL_ENV_KEY_SET.has(key) &&
      recovery.error?.kind === "command" &&
      recovery.error.reason === "not_found"
    ) {
      if (nativeNvidiaProvider) {
        (deps.clearNativeNvidiaProviderAuthority ?? clearNativeNvidiaProviderAuthority)(
          target.gatewayName,
        );
      }
      const removedLocal = forgetExtraProvider(key);
      return ok([
        removedLocal
          ? `  Provider '${key}' is already absent from the OpenShell gateway. Local state was cleaned up.`
          : `  Provider '${key}' is already absent from the OpenShell gateway.`,
        `  Rerun '${CLI_NAME} onboard' to enter a new value.`,
        ...detachedSandboxGuidance(key, recovery.detachedSandboxes),
      ]);
    }

    const outcome = formatResetOutcome(publicKey, recovery, target.gatewayName);
    if (!outcome.ok) return fail(outcome.lines);

    forgetExtraProvider(publicKey);
    if (nativeNvidiaProvider) {
      (deps.clearNativeNvidiaProviderAuthority ?? clearNativeNvidiaProviderAuthority)(
        target.gatewayName,
      );
    }
    return ok(outcome.lines);
  };

  if (!nativeNvidiaProvider) return resetProvider();
  return (deps.withGatewayRouteMutationLock ?? withGatewayRouteMutationLock)(
    target.gatewayName,
    resetProvider,
  );
}

/** Build the user-facing result after a provider delete attempt. */
export function formatResetOutcome(
  key: string,
  recovery: CredentialsProviderDeleteWithRecoveryResult,
  gatewayName: string,
): { ok: boolean; lines: string[] } {
  const onboardHint = `  Rerun '${CLI_NAME} onboard' to enter a new value.`;
  if (recovery.ok) {
    return {
      ok: true,
      lines: [
        `  Removed provider '${key}' from the OpenShell gateway.`,
        onboardHint,
        ...detachedSandboxGuidance(key, recovery.detachedSandboxes),
      ],
    };
  }

  const lines = [`  Could not remove provider '${key}'.`];
  if (KNOWN_CREDENTIAL_ENV_KEY_SET.has(key)) {
    lines.push(
      "",
      `  '${key}' looks like a credential env variable name.`,
      "  As of this release, 'credentials reset' takes an OpenShell",
      `  provider name. Run '${CLI_NAME} credentials list' to see the`,
      "  registered providers, then retry with one of those names.",
    );
  }
  const stuckSandboxes = [
    ...new Set([
      ...recovery.recoveryFailures.map((failure) => failure.sandbox),
      ...validatedAttachedSandboxes(recovery.error),
    ]),
  ];
  if (key === NVIDIA_HOSTED_LOGICAL_PROVIDER && stuckSandboxes.length > 0) {
    lines.push(
      "",
      `  '${key}' remains attached to sandbox(es): ${stuckSandboxes.join(", ")}.`,
      "  No provider attachment was changed.",
      `  To rotate the credential in place, set ${NVIDIA_HOSTED_CREDENTIAL_ENV} and rerun '${CLI_NAME} onboard --name <sandbox>'.`,
      "  To remove the provider completely, preserve any required sandbox state, destroy every attached sandbox,",
      `  then rerun '${CLI_NAME} credentials reset ${key}'.`,
      ...stuckSandboxes.map((sandbox) => `    ${CLI_NAME} ${sandbox} destroy`),
    );
    if (recovery.error?.message) lines.push(`  ${recovery.error.message}`);
    return { ok: false, lines };
  }
  if (stuckSandboxes.length > 0) {
    const stuck = stuckSandboxes.join(", ");
    lines.push(
      "",
      `  '${key}' is still attached to sandbox(es): ${stuck}.`,
      ...recovery.recoveryFailures.map(
        (failure) =>
          `  Could not detach provider '${key}' from sandbox '${failure.sandbox}': ${failure.error.message}`,
      ),
      "  Detach the provider from each remaining sandbox:",
      ...stuckSandboxes.map(
        (sandbox) => `    openshell sandbox provider detach -g ${gatewayName} ${sandbox} ${key}`,
      ),
      `  Then rerun '${CLI_NAME} credentials reset ${key}'.`,
    );
  }
  const detachedSandboxes = [...new Set(recovery.detachedSandboxes)];
  if (detachedSandboxes.length > 0) {
    lines.push(
      "",
      `  Provider '${key}' was detached from sandbox(es): ${detachedSandboxes.join(", ")}, but provider removal was not confirmed.`,
      `  Rerun '${CLI_NAME} credentials reset ${key}' to complete provider removal.`,
      "  If the provider remains registered, restore it by rebuilding the detached sandbox(es):",
      ...detachedSandboxes.map((sandbox) => `    ${CLI_NAME} ${sandbox} rebuild`),
    );
  }
  if (recovery.error?.message) lines.push(`  ${recovery.error.message}`);
  return { ok: false, lines };
}

async function deleteProviderWithRecovery(
  providerName: string,
  target: OpenShellGatewayTarget,
  providerAdapter: OpenShellProviderAdapter,
  options: Readonly<{ detachAttached: boolean }> = { detachAttached: true },
): Promise<CredentialsProviderDeleteWithRecoveryResult> {
  const request = {
    target,
    providerName,
    timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
  } as const;
  let result = await providerAdapter.deleteProvider(request);
  const detachedSandboxes: string[] = [];
  const recoveryFailures: Array<{ sandbox: string; error: OpenShellProviderError }> = [];
  if (result.ok || result.error.kind !== "command" || result.error.reason !== "attached") {
    return result.ok
      ? { ok: true, detachedSandboxes, recoveryFailures }
      : { ok: false, error: result.error, detachedSandboxes, recoveryFailures };
  }

  const attachedSandboxes = validatedAttachedSandboxes(result.error);
  if (attachedSandboxes.length === 0) {
    return { ok: false, error: result.error, detachedSandboxes, recoveryFailures };
  }
  if (!options.detachAttached) {
    return { ok: false, error: result.error, detachedSandboxes, recoveryFailures };
  }

  for (const sandbox of attachedSandboxes) {
    const detach = await providerAdapter.detachProvider({ ...request, sandboxName: sandbox });
    if (detach.ok) detachedSandboxes.push(sandbox);
    else recoveryFailures.push({ sandbox, error: detach.error });
  }
  result = await providerAdapter.deleteProvider(request);
  return result.ok
    ? { ok: true, detachedSandboxes: attachedSandboxes, recoveryFailures }
    : { ok: false, error: result.error, detachedSandboxes, recoveryFailures };
}
