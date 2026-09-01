// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { inspectPolicyMutationContext, setPolicyDocument } from "../../../src/lib/policy/index.ts";
import { parseOpenShellPolicy } from "../../../src/lib/policy/merge.ts";
import { policyDocumentWithEndpointCredentialBinding } from "../fixtures/policy-credential-binding.ts";

type PolicyCredentialBindingOptions = {
  sandboxName: string;
  providerName: string;
  endpointHost: string;
  endpointPort: string | number;
  protocol: "rest" | "websocket";
};

function policyDocumentsMatch(left: string, right: string): boolean {
  return isDeepStrictEqual(parseOpenShellPolicy(left).policy, parseOpenShellPolicy(right).policy);
}

function policyDocumentHasRequestedBinding(
  document: string,
  options: PolicyCredentialBindingOptions,
): boolean {
  try {
    const boundDocument = policyDocumentWithEndpointCredentialBinding(
      document,
      options.providerName,
      options.endpointHost,
      Number(options.endpointPort),
      options.protocol,
    );
    return policyDocumentsMatch(boundDocument, document);
  } catch {
    return false;
  }
}

export function applyPolicyCredentialBinding(options: PolicyCredentialBindingOptions): void {
  const operation = `bind the ${options.providerName} credential provider`;
  const context = inspectPolicyMutationContext(options.sandboxName, operation);
  if (context.basePolicyDocument === undefined) {
    throw new Error(`sandbox base policy is unavailable while attempting to ${operation}`);
  }
  const requestedDocument = policyDocumentWithEndpointCredentialBinding(
    context.basePolicyDocument,
    options.providerName,
    options.endpointHost,
    Number(options.endpointPort),
    options.protocol,
  );
  const applied = setPolicyDocument(options.sandboxName, requestedDocument, {
    context,
    nonFatal: true,
    operation,
    reconciledDocumentIsAcceptable: (document) =>
      policyDocumentHasRequestedBinding(document, options),
  });
  if (!applied) {
    throw new Error(`failed to ${operation} for sandbox '${options.sandboxName}'`);
  }
}
