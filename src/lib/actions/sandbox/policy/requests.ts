// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Review network requests that OpenShell blocked for a sandbox and holds as
 * pending rule proposals. This is the CLI counterpart of the `Network Rules`
 * panel in `openshell term`: list pending requests, then approve or reject one
 * by ID. OpenShell owns the proposal, the prover result, and the live policy
 * merge; NemoClaw only resolves the sandbox's recorded gateway and asks for
 * explicit acknowledgement before an approval widens egress.
 */

import {
  createSdkOpenShellPolicyRequests,
  type OpenShellPolicyRequests,
  type PolicyRequest,
  type PolicyRequestError,
} from "../../../adapters/openshell/policy-requests-sdk";
import { isNonInteractiveSession } from "../../../core/non-interactive";
import { assertNoOpenShellGatewayEndpointOverride } from "../../../openshell-gateway-endpoint-guard";
import { renderTerminalText } from "../../../policy/preset-scope-render";
// Same lock as policy add/remove/exclude, so approvals serialize with them.
import { withMcpLifecycleLock } from "../../../state/mcp-lifecycle-lock-acquisition";

/**
 * Host services supplied by the command layer: the CLI name for guidance, the
 * sandbox's recorded gateway, and the interactive prompt.
 */
export type PolicyRequestsHost = Readonly<{
  cliName: string;
  resolveGatewayName: (sandboxName: string) => string | null;
  ask: (question: string) => Promise<string>;
}>;

export type PolicyRequestsDeps = Readonly<{
  policyRequests?: OpenShellPolicyRequests;
  log?: (line: string) => void;
  error?: (line: string) => void;
  logJson?: (value: unknown) => void;
  isNonInteractive?: () => boolean;
  withLock?: <T>(sandboxName: string, operation: () => Promise<T>) => Promise<T>;
}>;

export type PolicyRequestsListOptions = Readonly<{ json?: boolean }>;

export type PolicyRequestApproveOptions = Readonly<{
  requestId: string;
  yes?: boolean;
}>;

export type PolicyRequestRejectOptions = Readonly<{
  requestId: string;
  reason?: string;
}>;

export type PolicyRequestsOutcome = Readonly<{ exitCode: number }>;

type ResolvedDeps = PolicyRequestsHost &
  Required<Omit<PolicyRequestsDeps, "policyRequests">> &
  Readonly<{ policyRequests: OpenShellPolicyRequests }>;

function resolveDeps(host: PolicyRequestsHost, deps: PolicyRequestsDeps): ResolvedDeps {
  return {
    ...host,
    policyRequests: deps.policyRequests ?? createSdkOpenShellPolicyRequests({ env: process.env }),
    log: deps.log ?? ((line) => console.log(line)),
    error: deps.error ?? ((line) => console.error(line)),
    logJson: deps.logJson ?? ((value) => console.log(JSON.stringify(value, null, 2))),
    isNonInteractive: deps.isNonInteractive ?? (() => isNonInteractiveSession()),
    withLock: deps.withLock ?? withMcpLifecycleLock,
  };
}

function safe(value: string): string {
  return renderTerminalText(value);
}

function requestsCommand(sandboxName: string, deps: ResolvedDeps): string {
  return `${deps.cliName} ${sandboxName} policy requests`;
}

type Target = Readonly<{
  sandboxName: string;
  target: Readonly<{ kind: "named"; gatewayName: string }>;
}>;

function resolveTarget(sandboxName: string, deps: ResolvedDeps): Target | null {
  const gatewayName = deps.resolveGatewayName(sandboxName);
  if (!gatewayName) {
    deps.error(`  Sandbox '${safe(sandboxName)}' is not registered with ${deps.cliName}.`);
    return null;
  }
  assertNoOpenShellGatewayEndpointOverride();
  return { sandboxName, target: { kind: "named", gatewayName } };
}

function reportError(
  action: string,
  sandboxName: string,
  error: PolicyRequestError,
  deps: ResolvedDeps,
): PolicyRequestsOutcome {
  deps.error(`  Could not ${action} for sandbox '${safe(sandboxName)}': ${safe(error.message)}`);
  if (error.kind === "stale") {
    deps.error(`  Run '${requestsCommand(sandboxName, deps)}' to review the refreshed request.`);
  } else if (error.kind === "local_state") {
    deps.error(
      "  Fix the host directory named above, then retry. The sandbox itself was not changed.",
    );
  } else if (error.kind === "unavailable" || error.kind === "timeout") {
    deps.error(`  Check that the sandbox is running with '${deps.cliName} ${sandboxName} status'.`);
  }
  if (error.kind === "timeout" && action !== "read pending requests") {
    // The gateway may still apply a change after the CLI gives up waiting.
    deps.error(
      `  It may still have gone through. Run '${requestsCommand(sandboxName, deps)}' before retrying.`,
    );
  }
  return { exitCode: 1 };
}

function endpointLabel(request: PolicyRequest): string {
  if (request.endpoints.length === 0) return "(no endpoint)";
  return request.endpoints
    .map((endpoint) => {
      const port = endpoint.port > 0 ? `:${String(endpoint.port)}` : "";
      return safe(`${endpoint.host}${port}`);
    })
    .join(", ");
}

function renderRequest(request: PolicyRequest, log: (line: string) => void): void {
  log(`  ${safe(request.id)}`);
  log(`    Destination: ${endpointLabel(request)}`);
  if (request.binary) log(`    Binary:      ${safe(request.binary)}`);
  for (const endpoint of request.endpoints) {
    for (const rule of endpoint.rules) {
      log(`    Allows:      ${safe(`${rule.method || "*"} ${rule.path || "/"}`)}`);
    }
    if (endpoint.rules.length === 0 && endpoint.access) {
      log(`    Access:      ${safe(endpoint.access)}`);
    }
  }
  if (request.hitCount > 0) {
    log(`    Attempts:    ${String(request.hitCount)}`);
  }
  if (request.rationale) log(`    Rationale:   ${safe(request.rationale)}`);
  if (request.securityNotes) log(`    Security:    ${safe(request.securityNotes)}`);
  if (request.validationResult) log(`    Prover:      ${safe(request.validationResult)}`);
  if (request.applicationError) {
    log(`    Cannot apply: ${safe(request.applicationError)}`);
  }
}

function toJson(request: PolicyRequest): Record<string, unknown> {
  return {
    id: request.id,
    ruleName: request.ruleName,
    binary: request.binary,
    endpoints: request.endpoints,
    rationale: request.rationale,
    securityNotes: request.securityNotes,
    validationResult: request.validationResult,
    applicationError: request.applicationError,
    hitCount: request.hitCount,
    firstSeenMs: request.firstSeenMs,
    lastSeenMs: request.lastSeenMs,
  };
}

/** List the network requests OpenShell is holding for review. */
export async function listSandboxPolicyRequests(
  sandboxName: string,
  options: PolicyRequestsListOptions,
  host: PolicyRequestsHost,
  deps: PolicyRequestsDeps = {},
): Promise<PolicyRequestsOutcome> {
  const resolved = resolveDeps(host, deps);
  const target = resolveTarget(sandboxName, resolved);
  if (!target) return { exitCode: 1 };
  const result = await resolved.policyRequests.listPending(target);
  if (!result.ok) return reportError("read pending requests", sandboxName, result.error, resolved);

  if (options.json) {
    resolved.logJson({
      sandbox: sandboxName,
      requests: result.value.map(toJson),
    });
    return { exitCode: 0 };
  }
  if (result.value.length === 0) {
    resolved.log(`  No pending network requests for sandbox '${safe(sandboxName)}'.`);
    return { exitCode: 0 };
  }
  const count = result.value.length;
  resolved.log(
    `  ${String(count)} pending network request${count === 1 ? "" : "s"} for sandbox '${safe(sandboxName)}':`,
  );
  for (const request of result.value) {
    resolved.log("");
    renderRequest(request, resolved.log);
  }
  resolved.log("");
  resolved.log(`  Approve: ${resolved.cliName} ${sandboxName} policy approve <id>`);
  resolved.log(
    `  Reject:  ${resolved.cliName} ${sandboxName} policy reject <id> [--reason <text>]`,
  );
  return { exitCode: 0 };
}

async function findPendingRequest(
  target: Target,
  requestId: string,
  deps: ResolvedDeps,
): Promise<PolicyRequest | PolicyRequestsOutcome> {
  const result = await deps.policyRequests.listPending(target);
  if (!result.ok) {
    return reportError("read pending requests", target.sandboxName, result.error, deps);
  }
  const request = result.value.find((candidate) => candidate.id === requestId);
  if (!request) {
    deps.error(
      `  No pending request '${safe(requestId)}' for sandbox '${safe(target.sandboxName)}'.`,
    );
    deps.error(`  Run '${requestsCommand(target.sandboxName, deps)}' to list pending requests.`);
    return { exitCode: 1 };
  }
  return request;
}

function isOutcome(value: PolicyRequest | PolicyRequestsOutcome): value is PolicyRequestsOutcome {
  return "exitCode" in value;
}

/** Approve one pending request after showing exactly what it allows. */
export async function approveSandboxPolicyRequest(
  sandboxName: string,
  options: PolicyRequestApproveOptions,
  host: PolicyRequestsHost,
  deps: PolicyRequestsDeps = {},
): Promise<PolicyRequestsOutcome> {
  const resolved = resolveDeps(host, deps);
  const target = resolveTarget(sandboxName, resolved);
  if (!target) return { exitCode: 1 };

  return resolved.withLock(sandboxName, async () => {
    const found = await findPendingRequest(target, options.requestId, resolved);
    if (isOutcome(found)) return found;

    resolved.log(`  Approving this request adds it to the live policy for '${safe(sandboxName)}':`);
    resolved.log("");
    renderRequest(found, resolved.log);
    resolved.log("");
    if (found.applicationError) {
      resolved.error("  OpenShell reports that this request cannot be applied as proposed.");
      resolved.error("  Reject it with guidance so the agent can propose a narrower rule.");
      return { exitCode: 1 };
    }
    if (!options.yes) {
      if (resolved.isNonInteractive()) {
        resolved.error("  Non-interactive approval requires explicit acknowledgement: pass --yes.");
        return { exitCode: 1 };
      }
      // Ctrl-D at the prompt means "no", same as an empty answer.
      const answer = await resolved
        .ask(`  Approve request '${safe(found.id)}'? [y/N]: `)
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException | null)?.code === "EOF") return "";
          throw error;
        });
      if (!answer.trim().toLowerCase().startsWith("y")) {
        resolved.log("  Cancelled. The request is still pending.");
        return { exitCode: 0 };
      }
    }

    const result = await resolved.policyRequests.approve({
      ...target,
      chunkId: found.id,
      reviewToken: found.reviewToken,
    });
    if (!result.ok) return reportError("approve the request", sandboxName, result.error, resolved);
    const version =
      result.value.policyVersion > 0
        ? ` (policy version ${String(result.value.policyVersion)})`
        : "";
    resolved.log(`  ✓ Approved '${safe(found.id)}'${version}. The sandbox can retry the request.`);
    return { exitCode: 0 };
  });
}

/** Reject one pending request, optionally telling the agent why. */
export async function rejectSandboxPolicyRequest(
  sandboxName: string,
  options: PolicyRequestRejectOptions,
  host: PolicyRequestsHost,
  deps: PolicyRequestsDeps = {},
): Promise<PolicyRequestsOutcome> {
  const resolved = resolveDeps(host, deps);
  const target = resolveTarget(sandboxName, resolved);
  if (!target) return { exitCode: 1 };

  return resolved.withLock(sandboxName, async () => {
    const found = await findPendingRequest(target, options.requestId, resolved);
    if (isOutcome(found)) return found;
    const result = await resolved.policyRequests.reject({
      ...target,
      chunkId: found.id,
      reason: options.reason?.trim() ?? "",
    });
    if (!result.ok) return reportError("reject the request", sandboxName, result.error, resolved);
    resolved.log(`  ✓ Rejected '${safe(found.id)}'. The destination stays blocked.`);
    return { exitCode: 0 };
  });
}
