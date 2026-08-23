// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenShell attachment commands accept a provider name but no caller-supplied
 * provider ID. The sandbox lifecycle lock serializes NemoClaw mutations. Exact
 * gateway, provider ID, resource version, and credential-shape checks reject
 * identity drift before attachment and compensation. Remove these checks when
 * OpenShell exposes an immutable-ID attachment precondition.
 */

import { stripAnsi } from "../../../adapters/openshell/ansi";
import { parseProviderAttachmentNames } from "../../../adapters/openshell/provider-attachment-table";
import type { SandboxMessagingPlan } from "../../../messaging";
import {
  matchesGatewayCredentialOnlyProviderBinding,
  readGatewayProviderIdentity,
  type GatewayProviderIdentity,
  type GatewayProviderRunner,
} from "../../../onboard/gateway-provider-metadata";
import { staticMessagingProviderTypeForChannel } from "../../../onboard/messaging-bridge-provider";

type OpenShellRunner = GatewayProviderRunner;
type OpenShellResult = ReturnType<OpenShellRunner>;

export type MessagingProviderAttachmentReceipt = {
  readonly credentialKey: string;
  readonly gatewayName: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly providerType: string;
  readonly resourceVersion: number;
};

function commandOutput(result: OpenShellResult): string {
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
  return stripAnsi(`${stdout ?? ""}\n${stderr ?? ""}`)
    .replace(/\r/g, "")
    .trim();
}

export { parseProviderAttachmentNames as parseMessagingProviderAttachmentNames } from "../../../adapters/openshell/provider-attachment-table";

function gatewayScopedArgs(args: string[], gatewayName: string): string[] {
  return [...args.slice(0, 2), "-g", gatewayName, ...args.slice(2)];
}

function listMessagingProviderAttachments(
  sandboxName: string,
  gatewayName: string,
  run: OpenShellRunner,
): Set<string> {
  const result = run(gatewayScopedArgs(["sandbox", "provider", "list", sandboxName], gatewayName), {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = commandOutput(result);
  if (result.status !== 0) {
    throw new Error(output || `Could not inspect providers attached to '${sandboxName}'.`);
  }
  try {
    return new Set(parseProviderAttachmentNames(output));
  } catch (error) {
    throw new Error(
      `OpenShell returned invalid provider attachment metadata for '${sandboxName}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function channelCredentialBindings(plan: SandboxMessagingPlan, channelId: string) {
  return [
    ...new Map(
      plan.credentialBindings
        .filter((binding) => binding.channelId === channelId)
        .map((binding) => [binding.providerName, binding]),
    ).values(),
  ];
}

function providerIdentityMatchesReceipt(
  identity: GatewayProviderIdentity | null,
  receipt: MessagingProviderAttachmentReceipt,
): boolean {
  return (
    identity?.id === receipt.providerId &&
    identity.resourceVersion === receipt.resourceVersion &&
    matchesGatewayCredentialOnlyProviderBinding(identity, {
      name: receipt.providerName,
      type: receipt.providerType,
      credentialKey: receipt.credentialKey,
    })
  );
}

function readMessagingProviderReceipt(
  plan: SandboxMessagingPlan,
  binding: SandboxMessagingPlan["credentialBindings"][number],
  gatewayName: string,
  run: OpenShellRunner,
): MessagingProviderAttachmentReceipt {
  const identity = readGatewayProviderIdentity(binding.providerName, run, gatewayName);
  const exactType = staticMessagingProviderTypeForChannel(binding.channelId, plan.agent);
  const expectedType = exactType ?? identity?.type ?? "generic";
  if (
    !identity ||
    !matchesGatewayCredentialOnlyProviderBinding(identity, {
      name: binding.providerName,
      type: expectedType,
      credentialKey: binding.providerEnvKey,
    })
  ) {
    throw new Error(
      `Existing provider '${binding.providerName}' does not match the required '${expectedType}' credential binding.`,
    );
  }
  return {
    credentialKey: binding.providerEnvKey,
    gatewayName,
    providerId: identity.id,
    providerName: binding.providerName,
    providerType: expectedType,
    resourceVersion: identity.resourceVersion,
  };
}

function assertProviderIdentityUnchanged(
  receipt: MessagingProviderAttachmentReceipt,
  run: OpenShellRunner,
): void {
  const identity = readGatewayProviderIdentity(receipt.providerName, run, receipt.gatewayName);
  if (!providerIdentityMatchesReceipt(identity, receipt)) {
    throw new Error(
      `Provider '${receipt.providerName}' changed across the attachment boundary. Refusing to mutate it.`,
    );
  }
}

export function rollbackMessagingProviderAttachments(
  sandboxName: string,
  receipts: readonly MessagingProviderAttachmentReceipt[],
  run: OpenShellRunner,
): string[] {
  const failures: string[] = [];
  for (const receipt of [...receipts].reverse()) {
    const identity = readGatewayProviderIdentity(receipt.providerName, run, receipt.gatewayName);
    if (!providerIdentityMatchesReceipt(identity, receipt)) {
      failures.push(`${receipt.providerName}: provider identity changed; refusing detach`);
      continue;
    }
    const result = run(
      gatewayScopedArgs(
        ["sandbox", "provider", "detach", sandboxName, receipt.providerName],
        receipt.gatewayName,
      ),
      {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = commandOutput(result);
    if (
      result.status !== 0 &&
      !/\bNotFound\b|not found|not attached|already detached/i.test(output)
    ) {
      failures.push(`${receipt.providerName}: ${output || `detach exited ${result.status}`}`);
    }
  }
  return failures;
}

export function restoreChannelMessagingProviderAttachments(
  sandboxName: string,
  plan: SandboxMessagingPlan,
  channelId: string,
  gatewayName: string,
  run: OpenShellRunner,
): MessagingProviderAttachmentReceipt[] {
  const bindings = channelCredentialBindings(plan, channelId);
  if (bindings.length === 0) return [];
  const receipts = new Map(
    bindings.map((binding) => [
      binding.providerName,
      readMessagingProviderReceipt(plan, binding, gatewayName, run),
    ]),
  );

  const attachedBefore = listMessagingProviderAttachments(sandboxName, gatewayName, run);
  const newlyAttached: MessagingProviderAttachmentReceipt[] = [];
  try {
    for (const binding of bindings) {
      if (attachedBefore.has(binding.providerName)) continue;
      const receipt = receipts.get(binding.providerName);
      if (!receipt) throw new Error(`Provider '${binding.providerName}' has no identity receipt.`);
      assertProviderIdentityUnchanged(receipt, run);
      const result = run(
        gatewayScopedArgs(
          ["sandbox", "provider", "attach", sandboxName, binding.providerName],
          gatewayName,
        ),
        {
          ignoreError: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (result.status !== 0) {
        throw new Error(
          commandOutput(result) || `Failed to attach provider '${binding.providerName}'.`,
        );
      }
      newlyAttached.push(receipt);
      const attachedAfter = listMessagingProviderAttachments(sandboxName, gatewayName, run);
      if (!attachedAfter.has(binding.providerName)) {
        throw new Error(
          `OpenShell did not confirm provider '${binding.providerName}' was attached to '${sandboxName}'.`,
        );
      }
    }
    for (const receipt of receipts.values()) {
      assertProviderIdentityUnchanged(receipt, run);
    }
    return newlyAttached;
  } catch (error) {
    const rollbackFailures = rollbackMessagingProviderAttachments(sandboxName, newlyAttached, run);
    const detail =
      rollbackFailures.length > 0 ? ` Rollback failed: ${rollbackFailures.join("; ")}` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
  }
}
