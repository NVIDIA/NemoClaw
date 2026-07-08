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
const gatewayCalls = [];
let pairingList = { pending: [], paired: [] };
let localPairingList = { pending: [], paired: [] };
let approvalFailures = [];
function setPairingLists(localList, liveList = localList) {
  localPairingList = localList;
  pairingList = liveList;
}
function withProgress(_options, callback) { return callback(); }
function parseTimeoutMsWithFallback(value, fallback) { return value ?? fallback; }
async function callGateway(options) {
  gatewayCalls.push(options);
  if (options.method === "device.pair.list") return pairingList;
  if (options.method === "device.pair.approve" && approvalFailures.length > 0) {
    throw approvalFailures.shift();
  }
  return { requestId: options.params.requestId, approved: true };
}
const callGatewayCli = async (method, opts, params, callOpts) => withProgress({
  label: \`Devices \${method}\`,
  indeterminate: true,
  enabled: opts.json !== true
}, async () => await callGateway({
  url: opts.url,
  token: opts.token,
  password: opts.password,
  method,
  params,
  timeoutMs: parseTimeoutMsWithFallback(opts.timeout, 10000),
  clientName: GATEWAY_CLIENT_NAMES.CLI,
  mode: GATEWAY_CLIENT_MODES.CLI,
  scopes: callOpts?.scopes
}));
function normalizeOptionalString(value) {
  if (typeof value !== "string") return;
  const normalized = value.trim();
  return normalized || undefined;
}
function normalizeDeviceRoles(request) {
  return [...new Set([...(request.roles ?? []), ...(request.role ? [request.role] : [])])];
}
function normalizeDeviceAuthScopes(scopes) {
  const normalized = new Set(scopes ?? []);
  if (normalized.has("operator.admin")) {
    normalized.add("operator.read");
    normalized.add("operator.write");
  } else if (normalized.has("operator.write")) {
    normalized.add("operator.read");
  }
  return [...normalized].sort();
}
function resolvePairedOperatorScopes(paired) {
  const tokens = Array.isArray(paired?.tokens)
    ? paired.tokens
    : paired?.tokens && typeof paired.tokens === "object"
      ? Object.values(paired.tokens)
      : [];
  const operatorToken = tokens.find((token) => token.role === OPERATOR_ROLE && !token.revokedAtMs);
  return normalizeDeviceAuthScopes(operatorToken?.scopes ?? paired?.scopes);
}
function resolvePendingOperatorApprovalScopes(request, paired) {
  const requestedScopes = normalizeDeviceAuthScopes(request.scopes);
  return requestedScopes.length > 0 ? requestedScopes : resolvePairedOperatorScopes(paired);
}
function isKnownNonAdminOperatorScope(scope) {
  return KNOWN_NON_ADMIN_OPERATOR_SCOPES.has(scope);
}
function parseDevicePairingList(value) {
  return {
    pending: Array.isArray(value?.pending) ? value.pending : [],
    paired: Array.isArray(value?.paired) ? value.paired : [],
  };
}
function findPendingRequestById(pending, requestId) {
  return pending.find((request) => request.requestId === requestId);
}
function indexPairedDevices(paired) {
  return new Map(paired.map((device) => [normalizeOptionalString(device.deviceId), device]));
}
function lookupPairedDevice(pairedByDeviceId, request) {
  return pairedByDeviceId.get(normalizeOptionalString(request.deviceId));
}
async function listDevicePairing() {
  return localPairingList;
}
async function listPairingWithFallback(opts) {
  try {
    return parseDevicePairingList(await callGatewayCli("device.pair.list", opts, {}));
  } catch (error) {
    throw error;
  }
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
async function resolveApprovePairingGatewayContext(opts, requestId) {
  try {
    const list = await listPairingWithFallback(opts);
    const request = findPendingRequestById(list.pending, requestId);
    if (!request) return {
      originalRequest: null,
      scopes: void 0
    };
    return {
      originalRequest: request,
      scopes: resolveApprovePairingScopesForRequest(request, lookupPairedDevice(indexPairedDevices(list.paired), request))
    };
  } catch {
    return {
      originalRequest: null,
      scopes: void 0
    };
  }
}
function isDevicePairingApprovalDenied(error) {
  return String(error?.message ?? error).toLowerCase().includes("device pairing approval denied");
}
async function approvePairingWithFallback(opts, requestId) {
  const { scopes, originalRequest } = await resolveApprovePairingGatewayContext(opts, requestId);
  try {
    return await callGatewayCli("device.pair.approve", opts, { requestId }, scopes ? { scopes } : void 0);
  } catch (error) {
    if (isDevicePairingApprovalDenied(error) && !scopes?.includes("operator.admin")) return await callGatewayCli("device.pair.approve", opts, { requestId }, { scopes: [ADMIN_SCOPE] });
    throw error;
  }
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
const PENDING_TTL_MS = 300 * 1e3;
const OPERATOR_ROLE = "operator";
const withLock = createAsyncLock();
const files = new Map();
const writes = [];
let delayedPairedWrite = null;
let failNextPendingWrite = false;
let failCommittedJournalAfterWrite = false;
let driftOnBuild = null;
function cloneJson(value) { return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)); }
function createAsyncLock() {
  let tail = Promise.resolve();
  return async (fn) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  };
}
function resolvePairingPaths(baseDir) {
  const root = baseDir ?? "/fixture";
  return { pendingPath: \`\${root}/pending.json\`, pairedPath: \`\${root}/paired.json\` };
}
function coercePairingStateRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function pruneExpiredPending() {}
async function readJsonIfExists(file) { return files.has(file) ? cloneJson(files.get(file)) : null; }
async function writeJson(file, value, options) {
  writes.push({ file, value: cloneJson(value), options: cloneJson(options) });
  const { pendingPath, pairedPath } = resolvePairingPaths("/fixture", "devices");
  if (file === pendingPath && failNextPendingWrite) {
    failNextPendingWrite = false;
    throw new Error("pending publication failed");
  }
  if (file === pairedPath && delayedPairedWrite?.armed) {
    const delayed = delayedPairedWrite;
    delayed.armed = false;
    delayed.started();
    await delayed.gate;
  }
  files.set(file, cloneJson(value));
  if (file.endsWith(".nemoclaw-self-approval-journal") && value?.phase === "committed" && failCommittedJournalAfterWrite) {
    failCommittedJournalAfterWrite = false;
    throw new Error("committed journal durability acknowledgement failed");
  }
}
function setPairingState(pendingById, pairedByDeviceId, baseDir = "/fixture") {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
  files.set(pendingPath, cloneJson(pendingById));
  files.set(pairedPath, cloneJson(pairedByDeviceId));
}
function setFile(file, value) { files.set(file, cloneJson(value)); }
function getFile(file) { return files.has(file) ? cloneJson(files.get(file)) : null; }
function getPairingPaths(baseDir = "/fixture") {
  const paths = resolvePairingPaths(baseDir, "devices");
  return { ...paths, journalPath: \`\${paths.pendingPath}.nemoclaw-self-approval-journal\` };
}
function armLateWriterFailure() {
  failNextPendingWrite = true;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const startedPromise = new Promise((resolve) => { started = resolve; });
  delayedPairedWrite = { armed: true, gate, release, started };
  return startedPromise;
}
function releaseLateWriter() { delayedPairedWrite?.release(); }
function armCommittedJournalFailure() { failCommittedJournalAfterWrite = true; }
function armStateDrift(file, value) { driftOnBuild = { file, value: cloneJson(value) }; }
async function loadState(baseDir) {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
  const [pending, paired] = await Promise.all([readJsonIfExists(pendingPath), readJsonIfExists(pairedPath)]);
  const state = {
    pendingById: coercePairingStateRecord(pending),
    pairedByDeviceId: coercePairingStateRecord(paired)
  };
  pruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);
  return state;
}
async function persistState(state, baseDir, target) {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
  if (target === "pending") {
    await writeJson(pendingPath, state.pendingById);
    return;
  }
  if (target === "paired") {
    await writeJson(pairedPath, state.pairedByDeviceId);
    return;
  }
  await Promise.all([writeJson(pendingPath, state.pendingById), writeJson(pairedPath, state.pairedByDeviceId)]);
}
function normalizeDeviceId(deviceId) { return deviceId.trim(); }
function mergeRoles(...values) { return values.flat().filter(Boolean); }
function normalizeDeviceAuthScopes(scopes) { return scopes ?? []; }
function resolveScopeOutsideRequestedRoles() { return null; }
function mergeScopes(...values) { return [...new Set(values.flat().filter(Boolean))]; }
function resolveApprovedTokenScopes({ pending }) { return pending.scopes; }
function resolveRoleScopedDeviceTokenScopes(_role, scopes) { return scopes; }
function resolveMissingRequestedScope({ requestedScopes, allowedScopes }) { return requestedScopes.find((scope) => !allowedScopes.includes(scope)); }
function newToken() { return "token"; }
function buildApprovedPairedDevice({ pending, roles, approvedScopes, tokens, now }) {
  if (driftOnBuild) {
    files.set(driftOnBuild.file, cloneJson(driftOnBuild.value));
    driftOnBuild = null;
  }
  return { ...pending, roles, approvedScopes, scopes: approvedScopes, tokens, approvedAtMs: now };
}
async function listDevicePairing(baseDir) {
  const state = await loadState(baseDir);
  return {
    pending: Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts),
    paired: Object.values(state.pairedByDeviceId).toSorted((a, b) => b.approvedAtMs - a.approvedAtMs)
  };
}
/** Return one paired device by normalized device id. */
async function getPairedDevice(deviceId, baseDir) {
  return (await loadState(baseDir)).pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
}
/** Return one pending pairing request by request id. */
async function getPendingDevicePairing(requestId, baseDir) {
  return (await loadState(baseDir)).pendingById[requestId] ?? null;
}
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
    for (const [roleForToken, nextScopes] of nextTokenScopesByRole) {
      tokens[roleForToken] = { token: newToken(), role: roleForToken, scopes: nextScopes };
    }
    const device = buildApprovedPairedDevice({ pending, roles, approvedScopes, tokens, now });
    delete state.pendingById[requestId];
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, baseDir, "both");
    return {
      status: "approved",
      requestId,
      device
    };
  });
}
async function approveBootstrapDevicePairing(requestId, bootstrapProfile, optionsOrBaseDir, maybeBaseDir) {
  const baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) return null;
    const device = { ...pending, bootstrapProfile, approvedAtMs: Date.now() };
    delete state.pendingById[requestId];
    state.pairedByDeviceId[device.deviceId] = device;
    await persistState(state, baseDir, "both");
    return { status: "approved", requestId, device };
  });
}
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

export function validPaired(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: "device-1",
    publicKey: "public-key-1",
    clientId: "cli",
    clientMode: "cli",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.pairing"],
    approvedScopes: ["operator.pairing"],
    tokens: [{ role: "operator", scopes: ["operator.pairing"] }],
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
