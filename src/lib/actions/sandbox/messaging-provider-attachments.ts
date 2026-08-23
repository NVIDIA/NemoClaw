// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stripAnsi } from "../../adapters/openshell/client";
import { runOpenshell } from "../../adapters/openshell/runtime";
import type { SandboxMessagingPlan } from "../../messaging";
import {
  matchesGatewayCredentialOnlyProviderBinding,
  readGatewayProviderMetadata,
} from "../../onboard/gateway-provider-metadata";
import { staticMessagingProviderTypeForChannel } from "../../onboard/messaging-bridge-provider";

type OpenShellRunner = typeof runOpenshell;
type OpenShellResult = ReturnType<OpenShellRunner>;

function commandOutput(result: OpenShellResult): string {
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
  return stripAnsi(`${stdout ?? ""}\n${stderr ?? ""}`)
    .replace(/\r/g, "")
    .trim();
}

export function parseMessagingProviderAttachmentNames(output: string): string[] {
  const clean = stripAnsi(output).replace(/\r/g, "").trim();
  if (/^No providers attached to sandbox\b/m.test(clean)) return [];
  const lines = clean
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) =>
    /^NAME\s+TYPE\s+CREDENTIAL_KEYS\s+CONFIG_KEYS$/.test(line),
  );
  if (headerIndex < 0) throw new Error("missing provider attachment table header");
  return lines.slice(headerIndex + 1).map((line) => {
    const match = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)$/);
    if (!match?.[1]) throw new Error("invalid provider attachment table row");
    return match[1];
  });
}

function listMessagingProviderAttachments(sandboxName: string, run: OpenShellRunner): Set<string> {
  const result = run(["sandbox", "provider", "list", sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = commandOutput(result);
  if (result.status !== 0) {
    throw new Error(output || `Could not inspect providers attached to '${sandboxName}'.`);
  }
  try {
    return new Set(parseMessagingProviderAttachmentNames(output));
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

function assertMessagingProviderBinding(
  plan: SandboxMessagingPlan,
  binding: SandboxMessagingPlan["credentialBindings"][number],
  run: OpenShellRunner,
): void {
  const metadata = readGatewayProviderMetadata(binding.providerName, run);
  const exactType = staticMessagingProviderTypeForChannel(binding.channelId, plan.agent);
  const expectedType = exactType ?? metadata?.type ?? "generic";
  if (
    !matchesGatewayCredentialOnlyProviderBinding(metadata, {
      name: binding.providerName,
      type: expectedType,
      credentialKey: binding.providerEnvKey,
    })
  ) {
    throw new Error(
      `Existing provider '${binding.providerName}' does not match the required '${expectedType}' credential binding.`,
    );
  }
}

export function rollbackMessagingProviderAttachments(
  sandboxName: string,
  providerNames: readonly string[],
  run: OpenShellRunner = runOpenshell,
): string[] {
  const failures: string[] = [];
  for (const providerName of [...providerNames].reverse()) {
    const result = run(["sandbox", "provider", "detach", sandboxName, providerName], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = commandOutput(result);
    if (
      result.status !== 0 &&
      !/\bNotFound\b|not found|not attached|already detached/i.test(output)
    ) {
      failures.push(`${providerName}: ${output || `detach exited ${result.status}`}`);
    }
  }
  return failures;
}

export function restoreChannelMessagingProviderAttachments(
  sandboxName: string,
  plan: SandboxMessagingPlan,
  channelId: string,
  run: OpenShellRunner = runOpenshell,
): string[] {
  const bindings = channelCredentialBindings(plan, channelId);
  if (bindings.length === 0) return [];
  for (const binding of bindings) assertMessagingProviderBinding(plan, binding, run);

  const attachedBefore = listMessagingProviderAttachments(sandboxName, run);
  const newlyAttached: string[] = [];
  try {
    for (const binding of bindings) {
      if (attachedBefore.has(binding.providerName)) continue;
      const result = run(["sandbox", "provider", "attach", sandboxName, binding.providerName], {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        throw new Error(
          commandOutput(result) || `Failed to attach provider '${binding.providerName}'.`,
        );
      }
      const attachedAfter = listMessagingProviderAttachments(sandboxName, run);
      if (!attachedAfter.has(binding.providerName)) {
        throw new Error(
          `OpenShell did not confirm provider '${binding.providerName}' was attached to '${sandboxName}'.`,
        );
      }
      newlyAttached.push(binding.providerName);
    }
    return newlyAttached;
  } catch (error) {
    const rollbackFailures = rollbackMessagingProviderAttachments(sandboxName, newlyAttached, run);
    const detail =
      rollbackFailures.length > 0 ? ` Rollback failed: ${rollbackFailures.join("; ")}` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
  }
}
