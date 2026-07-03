// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const PATCH_SCRIPT = path.resolve(
  import.meta.dirname,
  "../../scripts/patch-openclaw-device-self-approval.ts",
);

function compiledIndent(source: string): string {
  return source.replace(/^( +)/gmu, (indent) => "\t".repeat(Math.floor(indent.length / 2)));
}

function cliFixture(): string {
  return compiledIndent(`
const ADMIN_SCOPE = "operator.admin";
const PAIRING_SCOPE = "operator.pairing";
const OPERATOR_ROLE = "operator";
const GATEWAY_CLIENT_NAMES = { CLI: "cli" };
const GATEWAY_CLIENT_MODES = { CLI: "cli" };
const KNOWN_NON_ADMIN_OPERATOR_SCOPES = new Set(["operator.pairing", "operator.read", "operator.write"]);
function normalizeDeviceRoles(request) {
  return [...new Set([...(request.roles ?? []), ...(request.role ? [request.role] : [])])];
}
function normalizeDeviceAuthScopes(scopes) { return [...new Set(scopes ?? [])]; }
function resolvePairedOperatorScopes(paired) { return paired?.tokenScopes ?? paired?.scopes ?? []; }
function resolvePendingOperatorApprovalScopes(request, paired) {
  const requestedScopes = normalizeDeviceAuthScopes(request.scopes);
  return requestedScopes.length > 0 ? requestedScopes : resolvePairedOperatorScopes(paired);
}
function isKnownNonAdminOperatorScope(scope) {
  return KNOWN_NON_ADMIN_OPERATOR_SCOPES.has(scope);
}
function resolveApprovePairingScopesForRequest(request, paired) {
  const operatorScopes = resolvePendingOperatorApprovalScopes(request, paired);
  if (operatorScopes.length === 0) return;
  if (operatorScopes.includes("operator.admin")) return [ADMIN_SCOPE];
  const out = new Set([PAIRING_SCOPE]);
  for (const scope of operatorScopes) {
    if (!isKnownNonAdminOperatorScope(scope)) return [ADMIN_SCOPE];
    out.add(scope);
  }
  return [...out];
}
async function approvePairingWithFallback(opts, requestId) {
  return callGatewayCli("device.pair.approve", opts, { requestId });
}
`);
}

function handlerFixture(): string {
  return compiledIndent(`
const ErrorCodes = { INVALID_REQUEST: "INVALID_REQUEST" };
const DEVICE_PAIR_APPROVAL_DENIED_MESSAGE = "device pairing approval denied";
const pendingById = new Map();
let capturedApproval;
let approvalFailure;
const validateDevicePairApproveParams = Object.assign(() => true, { errors: [] });
function formatValidationErrors() { return ""; }
function errorShape(code, message) { return { code, message }; }
function resolveDeviceSessionAuthz(client) { return client.authz; }
async function getPendingDevicePairing(requestId) { return pendingById.get(requestId) ?? null; }
function requestsNonOperatorDeviceRole(pending) {
  const roles = new Set([...(pending.roles ?? []), ...(pending.role ? [pending.role] : [])]);
  return [...roles].some((role) => role !== "operator");
}
function emitDevicePairingDeniedSecurityEvent() {}
function emitDevicePairingLifecycleSecurityEvent() {}
function formatDevicePairingForbiddenMessage(value) { return value.reason; }
function redactPairedDevice(device) { return device; }
async function approveDevicePairing(requestId, options) {
  capturedApproval = { requestId, options };
  if (approvalFailure) throw approvalFailure;
  const pending = pendingById.get(requestId);
  return pending ? { status: "approved", requestId, device: pending } : null;
}
/** Gateway request handlers for device pair approval, removal, token rotation, and revocation. */
const deviceHandlers = {
  "device.pair.approve": async ({ params, respond, context, client }) => {
    if (!validateDevicePairApproveParams(params)) {
      respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, \`invalid device.pair.approve params: \${formatValidationErrors(validateDevicePairApproveParams.errors)}\`));
      return;
    }
    const { requestId } = params;
    const authz = resolveDeviceSessionAuthz(client);
    if (!authz.isAdminCaller) {
      const pending = await getPendingDevicePairing(requestId);
      if (!pending) {
        respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_APPROVAL_DENIED_MESSAGE));
        return;
      }
      if (authz.callerDeviceId && pending.deviceId.trim() !== authz.callerDeviceId) {
        context.logGateway.warn(\`device pairing approval denied request=\${requestId} reason=device-ownership-mismatch\`);
        emitDevicePairingDeniedSecurityEvent({
          authz,
          targetDeviceId: pending.deviceId,
          controlId: "device.pair.approve",
          reason: "device-ownership-mismatch"
        });
        respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_APPROVAL_DENIED_MESSAGE));
        return;
      }
      if (requestsNonOperatorDeviceRole(pending)) {
        context.logGateway.warn(\`device pairing approval denied request=\${requestId} reason=role-management-requires-admin\`);
        emitDevicePairingDeniedSecurityEvent({
          authz,
          targetDeviceId: pending.deviceId,
          controlId: "device.pair.approve",
          reason: "role-management-requires-admin"
        });
        respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_APPROVAL_DENIED_MESSAGE));
        return;
      }
    }
    const approved = await approveDevicePairing(requestId, { callerScopes: authz.callerScopes });
    if (!approved) {
      respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
      return;
    }
    if (approved.status === "forbidden") {
      emitDevicePairingDeniedSecurityEvent({ authz, controlId: "device.pair.approve", reason: approved.reason });
      respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, formatDevicePairingForbiddenMessage(approved)));
      return;
    }
    context.logGateway.info(\`device pairing approved device=\${approved.device.deviceId} role=\${approved.device.role ?? "unknown"}\`);
    emitDevicePairingLifecycleSecurityEvent({ action: "device.pairing.approved", severity: "low", authz, targetDeviceId: approved.device.deviceId, controlId: "device.pair.approve", attributes: { role_count: approved.device.roles?.length ?? (approved.device.role ? 1 : 0), scope_count: approved.device.approvedScopes?.length ?? approved.device.scopes?.length ?? 0 } });
    context.broadcast("device.pair.resolved", { requestId, deviceId: approved.device.deviceId, decision: "approved", ts: Date.now() }, { dropIfSlow: true });
    respond(true, { requestId, device: redactPairedDevice(approved.device) }, void 0);
  }
};
`);
}

function stateFixture(): string {
  return compiledIndent(`
const OPERATOR_ROLE = "operator";
const withLock = createAsyncLock();
function createAsyncLock() { return async (fn) => await fn(); }
async function loadState() { return { pendingById: {}, pairedByDeviceId: {} }; }
function mergeRoles(...values) { return values.flat().filter(Boolean); }
function normalizeDeviceAuthScopes(scopes) { return scopes ?? []; }
function resolveScopeOutsideRequestedRoles() { return null; }
function mergeScopes(...values) { return [...new Set(values.flat().filter(Boolean))]; }
function resolveApprovedTokenScopes({ pending }) { return pending.scopes; }
function resolveRoleScopedDeviceTokenScopes(_role, scopes) { return scopes; }
function resolveMissingRequestedScope({ requestedScopes, allowedScopes }) { return requestedScopes.find((scope) => !allowedScopes.includes(scope)); }
function newToken() { return "token"; }
function buildApprovedPairedDevice({ pending }) { return pending; }
async function persistState() {}
async function approveDevicePairing(requestId, optionsOrBaseDir, maybeBaseDir) {
  const options = typeof optionsOrBaseDir === "string" || optionsOrBaseDir === void 0 ? void 0 : optionsOrBaseDir;
  const baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) return null;
    const requestedRoles = mergeRoles(pending.roles, pending.role) ?? [];
    const roleMismatchScope = resolveScopeOutsideRequestedRoles({ requestedRoles, requestedScopes: normalizeDeviceAuthScopes(pending.scopes) });
    if (roleMismatchScope) return { status: "forbidden", reason: "scope-outside-requested-roles", scope: roleMismatchScope };
    const now = Date.now();
    const existing = state.pairedByDeviceId[pending.deviceId];
    const roles = mergeRoles(existing?.roles, existing?.role, pending.roles, pending.role);
    const approvedScopes = mergeScopes(existing?.approvedScopes ?? existing?.scopes, pending.scopes);
    const tokens = existing?.tokens ? { ...existing.tokens } : {};
    const nextTokenScopesByRole = new Map();
    for (const roleForToken of requestedRoles) {
      const existingToken = tokens[roleForToken];
      const nextScopes = resolveApprovedTokenScopes({ role: roleForToken, pending, existingToken, approvedScopes, existing });
      nextTokenScopesByRole.set(roleForToken, nextScopes);
      if (roleForToken === OPERATOR_ROLE && nextScopes.length > 0) {
        const callerRequiredScopes = mergeScopes(resolveRoleScopedDeviceTokenScopes(roleForToken, pending.scopes), nextScopes) ?? nextScopes;
        if (!options?.callerScopes) return {
          status: "forbidden",
          reason: "caller-scopes-required",
          scope: callerRequiredScopes[0]
        };
        const missingScope = resolveMissingRequestedScope({
          role: OPERATOR_ROLE,
          requestedScopes: callerRequiredScopes,
          allowedScopes: options.callerScopes
        });
        if (missingScope) return { status: "forbidden", reason: "caller-missing-scope", scope: missingScope };
      }
    }
    await persistState(state, baseDir, "both");
    return { status: "approved", requestId, device: pending, now, roles, approvedScopes, tokens, nextTokenScopesByRole };
  });
}
void persistState;
`);
}

export function writeFixtureDist(dist: string): void {
  fs.writeFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), cliFixture());
  fs.writeFileSync(path.join(dist, "devices-fixture.js"), handlerFixture());
  fs.writeFileSync(path.join(dist, "device-pairing-fixture.js"), stateFixture());
}

export function runPatch(dist: string, audit = false) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", PATCH_SCRIPT, ...(audit ? ["--audit"] : []), dist],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

export function runFixture<T>(source: string, expression: string): T {
  return vm.runInNewContext(`${source}\n${expression}`, {}) as T;
}

export function validPending(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "request-1",
    deviceId: "device-1",
    publicKey: "public-key-1",
    clientId: "cli",
    clientMode: "cli",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.write"],
    isRepair: true,
    ...overrides,
  };
}

export function validClient(overrides: Record<string, unknown> = {}) {
  return {
    isDeviceTokenAuth: true,
    authz: {
      callerDeviceId: "device-1",
      callerScopes: ["operator.pairing"],
      isAdminCaller: false,
    },
    connect: {
      role: "operator",
      scopes: ["operator.pairing"],
      device: { id: "device-1", publicKey: "public-key-1" },
      client: { id: "cli", mode: "cli" },
    },
    ...overrides,
  };
}
