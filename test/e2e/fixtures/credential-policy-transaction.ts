// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import {
  captureRecordedSandboxBasePolicy,
  setPolicyDocument,
} from "../../../src/lib/policy/index.ts";
import { bindCredentialPolicyDocument } from "./credential-policy-binding.ts";

export function applyCredentialPolicyBinding(options: {
  sandboxName: string;
  providerName: string;
  host: string;
  port: number;
  protocol: string;
}): void {
  const operation = `bind the ${options.providerName} credential policy endpoint`;
  const currentPolicy = captureRecordedSandboxBasePolicy(options.sandboxName, operation);
  const requestedPolicy = bindCredentialPolicyDocument(
    currentPolicy,
    options.providerName,
    options.host,
    options.port,
    options.protocol,
  );
  if (
    !setPolicyDocument(options.sandboxName, requestedPolicy, {
      nonFatal: true,
      operation,
    })
  ) {
    throw new Error(`failed to ${operation}`);
  }
}

function main(): void {
  const [sandboxName, providerName, host, rawPort, protocol] = process.argv.slice(2);
  const port = Number(rawPort);
  if (
    !sandboxName ||
    !providerName ||
    !host ||
    !rawPort ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !protocol
  ) {
    throw new Error(
      "usage: credential-policy-transaction <sandbox> <provider> <host> <port> <protocol>",
    );
  }
  applyCredentialPolicyBinding({ sandboxName, providerName, host, port, protocol });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
