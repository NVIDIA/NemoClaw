// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(value = ""): string {
  return String(value).replace(ANSI_RE, "");
}

export type SpawnLikeResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
};

export function isMissingSandboxDeleteOutput(output = ""): boolean {
  return /\bNotFound\b|\bNot Found\b|sandbox not found|sandbox .* not found|sandbox .* not present|sandbox does not exist|no such sandbox/i.test(
    stripAnsi(output),
  );
}

/**
 * True when a `sandbox delete` failure is a gateway transport error (the
 * OpenShell gateway at 127.0.0.1:8080 is not listening) rather than a real
 * delete rejection. When the gateway process is down every gateway call gets a
 * connection-refused/transport error, which used to make `destroy` fatal with
 * no bypass (#6046).
 */
export function isGatewayUnreachableDeleteOutput(output = ""): boolean {
  return /connection refused|os error (?:61|111)|tcp connect error|error trying to connect|transport error|failed to connect to|connect(?:ion)? timed out|deadline has elapsed|connection reset/i.test(
    stripAnsi(output),
  );
}

export function getSandboxDeleteOutcome(deleteResult: SpawnLikeResult): {
  output: string;
  alreadyGone: boolean;
  gatewayUnreachable: boolean;
} {
  const output = `${deleteResult.stdout || ""}${deleteResult.stderr || ""}`.trim();
  const failed = deleteResult.status !== 0;
  const alreadyGone = failed && isMissingSandboxDeleteOutput(output);
  return {
    output,
    alreadyGone,
    gatewayUnreachable: failed && !alreadyGone && isGatewayUnreachableDeleteOutput(output),
  };
}

export function shouldStopHostServicesAfterDestroy(input: {
  deleteSucceededOrAlreadyGone: boolean;
  registeredSandboxCount: number;
  sandboxStillRegistered: boolean;
}): boolean {
  return (
    input.deleteSucceededOrAlreadyGone &&
    input.registeredSandboxCount === 1 &&
    input.sandboxStillRegistered
  );
}

export function shouldCleanupGatewayAfterDestroy(input: {
  deleteSucceededOrAlreadyGone: boolean;
  removedRegistryEntry: boolean;
  noRegisteredSandboxes: boolean;
  noLiveSandboxes: boolean;
}): boolean {
  return (
    input.deleteSucceededOrAlreadyGone &&
    input.removedRegistryEntry &&
    input.noRegisteredSandboxes &&
    input.noLiveSandboxes
  );
}
