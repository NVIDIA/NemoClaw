// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import {
  isPolicyDocument,
  isPolicyObject,
  type PolicyObject,
  type PolicyValue,
} from "./preset-parsing";

const MICROSOFT_LOGIN_HOST = "login.microsoftonline.com";
const TEAMS_POLICY_KEY = "teams";
const OUTLOOK_POLICY_KEY = "outlook_graph";

function findMicrosoftLoginEndpoint(policy: PolicyObject, policyKey: string): PolicyObject {
  const endpoints = policy.endpoints;
  if (!Array.isArray(endpoints)) {
    throw new Error(
      `Cannot reconcile Microsoft login policy metadata: '${policyKey}' endpoints are missing.`,
    );
  }
  const matches = endpoints.filter(
    (endpoint) =>
      isPolicyObject(endpoint) && endpoint.host === MICROSOFT_LOGIN_HOST && endpoint.port === 443,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Cannot reconcile Microsoft login policy metadata: '${policyKey}' must declare exactly one ${MICROSOFT_LOGIN_HOST}:443 endpoint.`,
    );
  }
  return matches[0] as PolicyObject;
}

/**
 * OpenShell requires overlapping endpoints to carry identical credential
 * metadata. Outlook and Teams share Microsoft's OAuth host, so the Outlook
 * endpoint borrows Teams' bridge binding only for the lifetime of the Teams
 * policy. Removing Teams restores Outlook's reviewed unbound endpoint.
 */
export function reconcileTeamsOutlookLoginCredentialBinding(
  policyContent: string,
  sandboxName: string | undefined,
  teamsActiveOverride?: boolean,
): string {
  let parsed: PolicyValue;
  try {
    parsed = YAML.parse(policyContent);
  } catch {
    throw new Error("Cannot reconcile Microsoft login policy metadata: policy YAML is invalid.");
  }
  if (!isPolicyDocument(parsed)) {
    throw new Error(
      "Cannot reconcile Microsoft login policy metadata: policy must be a YAML mapping.",
    );
  }

  const networkPolicies = parsed.network_policies;
  if (!networkPolicies || !isPolicyObject(networkPolicies)) return policyContent;
  const outlookPolicy = networkPolicies[OUTLOOK_POLICY_KEY];
  if (!isPolicyObject(outlookPolicy)) return policyContent;

  const teamsPolicy = networkPolicies[TEAMS_POLICY_KEY];
  const teamsActive = teamsActiveOverride ?? isPolicyObject(teamsPolicy);
  const outlookEndpoint = findMicrosoftLoginEndpoint(outlookPolicy, OUTLOOK_POLICY_KEY);
  const expectedProvider = sandboxName ? `${sandboxName}-teams-bridge` : null;
  const expectedBinding = expectedProvider ? { provider: expectedProvider } : null;
  const existingOutlookBinding = outlookEndpoint.credential_binding;

  if (!teamsActive) {
    if (existingOutlookBinding === undefined) return policyContent;
    if (!expectedBinding || !isDeepStrictEqual(existingOutlookBinding, expectedBinding)) {
      throw new Error(
        "Cannot restore Outlook Microsoft login policy metadata: the existing credential binding is not owned by Teams.",
      );
    }
    delete outlookEndpoint.credential_binding;
    return YAML.stringify(parsed);
  }

  if (!expectedBinding) {
    throw new Error(
      "Cannot reconcile Microsoft login policy metadata: a sandbox name is required for the Teams credential provider.",
    );
  }
  if (isPolicyObject(teamsPolicy)) {
    const teamsEndpoint = findMicrosoftLoginEndpoint(teamsPolicy, TEAMS_POLICY_KEY);
    if (teamsEndpoint.credential_binding === undefined) return policyContent;
    if (!isDeepStrictEqual(teamsEndpoint.credential_binding, expectedBinding)) {
      throw new Error(
        "Cannot reconcile Microsoft login policy metadata: the Teams credential binding does not match its sandbox-owned provider.",
      );
    }
  }
  if (
    existingOutlookBinding !== undefined &&
    !isDeepStrictEqual(existingOutlookBinding, expectedBinding)
  ) {
    throw new Error(
      "Cannot reconcile Microsoft login policy metadata: the Outlook endpoint already has a different credential binding.",
    );
  }
  outlookEndpoint.credential_binding = expectedBinding;
  return YAML.stringify(parsed);
}
