// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const PATCH_SCRIPT = path.resolve(
  import.meta.dirname,
  "../../scripts/patch-openclaw-device-self-approval.mts",
);

function compiledIndent(source: string): string {
  return source.replace(/^( +)/gmu, (indent) => "\t".repeat(Math.floor(indent.length / 2)));
}

function gatewayCallFixture(): string {
  return compiledIndent(`
const process = { env: {} };
const GATEWAY_CLIENT_NAMES = { CLI: "cli", GATEWAY_CLIENT: "gateway-client" };
const GATEWAY_CLIENT_MODES = { CLI: "cli", BACKEND: "backend" };
let storedOperatorDeviceAuthToken = false;
let forcedDeviceIdentity = { deviceId: "device-1" };
let deviceIdentityLoadCount = 0;
const gatewayCallDeps = {
  createGatewayClient(options) {
    return options;
  },
  loadOrCreateDeviceIdentity() {
    deviceIdentityLoadCount += 1;
    return forcedDeviceIdentity;
  }
};
function isLoopbackGatewayUrl(url) { return url.startsWith("ws://127.0.0.1:"); }
function normalizeOptionalString(value) {
  if (typeof value !== "string") return;
  const normalized = value.trim();
  return normalized || undefined;
}
function resolveDeviceIdentityForGatewayCall() {
  try {
    return gatewayCallDeps.loadOrCreateDeviceIdentity();
  } catch {
    return null;
  }
}
function hasStoredOperatorDeviceAuthToken() { return storedOperatorDeviceAuthToken; }
function shouldOmitDeviceIdentityForGatewayCall(params) {
  const mode = params.opts.mode ?? GATEWAY_CLIENT_MODES.CLI;
  const clientName = params.opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI;
  const hasSharedSecretAuth = params.authMode === "token" && Boolean(params.token) || params.authMode === "password" && Boolean(params.password);
  const isLoopback = isLoopbackGatewayUrl(params.url);
  const isLocalBackendSharedAuth = mode === GATEWAY_CLIENT_MODES.BACKEND && clientName === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT && (hasSharedSecretAuth || params.allowAuthNone === true) && isLoopback;
  const isLocalCliSharedAuth = mode === GATEWAY_CLIENT_MODES.CLI && clientName === GATEWAY_CLIENT_NAMES.CLI && hasSharedSecretAuth && isLoopback;
  return isLocalBackendSharedAuth || isLocalCliSharedAuth;
}
async function executeGatewayRequestWithScopes(params) {
  const { opts, deviceIdentity } = params;
  return await new Promise((resolve) => {
    const client = gatewayCallDeps.createGatewayClient({
      url: opts.url,
      deviceIdentity,
      minProtocol: opts.minProtocol ?? 4,
      maxProtocol: opts.maxProtocol ?? 4
    });
    resolve(client);
  });
}
function gatewayClientOptions(opts) {
  return executeGatewayRequestWithScopes({ opts, deviceIdentity: forcedDeviceIdentity });
}
function setForceDevicePairing(value) {
  if (value) process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING = "1";
  else delete process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING;
}
function setForcedDeviceIdentity(identity, expectedDeviceId) {
  forcedDeviceIdentity = identity;
  process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING = "1";
  if (expectedDeviceId === undefined) delete process.env.NEMOCLAW_OPENCLAW_EXPECTED_DEVICE_ID;
  else process.env.NEMOCLAW_OPENCLAW_EXPECTED_DEVICE_ID = expectedDeviceId;
}
function getDeviceIdentityLoadCount() { return deviceIdentityLoadCount; }
function setStoredOperatorDeviceAuthToken(value) { storedOperatorDeviceAuthToken = value; }
`);
}

function cliFixture(): string {
  return compiledIndent(`
const descriptorFiles = new Map();
const descriptorReads = [];
const process = {
  env: {},
  getBuiltinModule(name) {
    if (name !== "node:fs") throw new Error("unexpected builtin module");
    return {
      fstatSync(fd) {
        const value = descriptorFiles.get(fd);
        if (value === undefined) throw new Error("unknown descriptor");
        return {
          dev: 1,
          ino: fd,
          size: Buffer.byteLength(value),
          nlink: 1,
          mtimeMs: 1,
          isFile: () => true
        };
      },
      readSync(fd, buffer, offset, length, position) {
        const value = descriptorFiles.get(fd);
        if (value === undefined) throw new Error("unknown descriptor");
        descriptorReads.push({ fd, position });
        const source = Buffer.from(value);
        const count = Math.min(length, Math.max(0, source.length - position));
        if (count > 0) source.copy(buffer, offset, position, position + count);
        return count;
      }
    };
  }
};
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
let gatewayListFailure = null;
let localPairingReadCount = 0;
let localApprovalCount = 0;
function setPairingLists(localList, liveList = localList) {
  localPairingList = localList;
  pairingList = liveList;
}
function setPairedTokenEnvironment(overrides = {}) {
  process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING = "1";
  descriptorFiles.clear();
  descriptorReads.length = 0;
  const pendingFd = Object.hasOwn(overrides, "pendingFd") ? overrides.pendingFd : "41";
  const pairedFd = Object.hasOwn(overrides, "pairedFd") ? overrides.pairedFd : "42";
  if (pendingFd === undefined) delete process.env.NEMOCLAW_OPENCLAW_PENDING_FD;
  else process.env.NEMOCLAW_OPENCLAW_PENDING_FD = pendingFd;
  if (pairedFd === undefined) delete process.env.NEMOCLAW_OPENCLAW_PAIRED_FD;
  else process.env.NEMOCLAW_OPENCLAW_PAIRED_FD = pairedFd;
  const pendingJson = Object.hasOwn(overrides, "pendingJson")
    ? overrides.pendingJson
    : JSON.stringify(Object.fromEntries(localPairingList.pending.map((request) => [request.requestId, request])));
  const pairedJson = Object.hasOwn(overrides, "pairedJson")
    ? overrides.pairedJson
    : JSON.stringify(Object.fromEntries(localPairingList.paired.map((device) => [device.deviceId, device])));
  if (typeof pendingFd === "string" && /^[1-9]\\d*$/.test(pendingFd) && pendingJson !== undefined) descriptorFiles.set(Number(pendingFd), pendingJson);
  if (typeof pairedFd === "string" && /^[1-9]\\d*$/.test(pairedFd) && pairedJson !== undefined) descriptorFiles.set(Number(pairedFd), pairedJson);
  const pinnedUrl = Object.hasOwn(overrides, "pinnedUrl") ? overrides.pinnedUrl : "ws://127.0.0.1:18789";
  const gatewayUrl = Object.hasOwn(overrides, "gatewayUrl") ? overrides.gatewayUrl : pinnedUrl;
  if (pinnedUrl === undefined) delete process.env.NEMOCLAW_OPENCLAW_PINNED_GATEWAY_URL;
  else process.env.NEMOCLAW_OPENCLAW_PINNED_GATEWAY_URL = pinnedUrl;
  if (gatewayUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
  else process.env.OPENCLAW_GATEWAY_URL = gatewayUrl;
  for (const [name, value] of [
    ["OPENCLAW_GATEWAY_TOKEN", overrides.envToken],
    ["OPENCLAW_GATEWAY_PASSWORD", overrides.password],
    ["OPENCLAW_GATEWAY_PORT", overrides.port]
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
function pairingDescriptorReads() { return [...descriptorReads]; }
function setGatewayListFailure(error) { gatewayListFailure = error; }
function setApprovalFailures(errors) { approvalFailures = [...errors]; }
function pairingStats() { return { localPairingReadCount, localApprovalCount }; }
function withProgress(_options, callback) { return callback(); }
function parseTimeoutMsWithFallback(value, fallback) { return value ?? fallback; }
async function callGateway(options) {
  gatewayCalls.push({
    ...options,
    credentialSource: options.token ? "option" : process.env.OPENCLAW_GATEWAY_TOKEN ? "environment" : "none",
    signedIdentityForced: process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1" || process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1",
    cliArgUrl: options.cliArgUrl,
    cliArgToken: options.cliArgToken,
    cliArgPassword: options.cliArgPassword
  });
  if (options.method === "device.pair.list") {
    if (gatewayListFailure) throw gatewayListFailure;
    return pairingList;
  }
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
  cliArgUrl: opts.url,
  cliArgToken: opts.token,
  cliArgPassword: opts.password,
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
  localPairingReadCount += 1;
  return localPairingList;
}
async function listPairingWithFallback(opts) {
  try {
    return parseDevicePairingList(await callGatewayCli("device.pair.list", opts, {}));
  } catch {
    return parseDevicePairingList(await listDevicePairing());
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
function isUnknownRequestIdError(error) {
  return String(error?.message ?? error).toLowerCase().includes("unknown requestid");
}
function resolveLocalPairingFallback(_opts, error) {
  return String(error?.message ?? error).toLowerCase().includes("scope-upgrade-pending") ? {} : null;
}
async function approveDevicePairing(requestId) {
  localApprovalCount += 1;
  return { status: "approved", requestId, device: { deviceId: "device-1" } };
}
async function approvePairingWithFallback(opts, requestId) {
  const { scopes, originalRequest } = await resolveApprovePairingGatewayContext(opts, requestId);
  try {
    return await callGatewayCli("device.pair.approve", opts, { requestId }, scopes ? { scopes } : void 0);
  } catch (error) {
    if (isDevicePairingApprovalDenied(error) && !scopes?.includes("operator.admin")) try {
      return await callGatewayCli("device.pair.approve", opts, { requestId }, { scopes: [ADMIN_SCOPE] });
    } catch (adminError) {
      if (isUnknownRequestIdError(adminError)) return null;
      throw adminError;
    }
    const fallback = resolveLocalPairingFallback(opts, error);
    if (!fallback) {
      if (isUnknownRequestIdError(error)) return null;
      throw error;
    }
    return await approveDevicePairing(originalRequest?.requestId ?? requestId);
  }
}
`);
}

function deviceIdentityFixture(): string {
  return compiledIndent(`
const descriptorFiles = new Map();
const descriptorReads = [];
const process = { env: {} };
const fs = {
  fstatSync(fd) {
    const value = descriptorFiles.get(fd);
    if (value === undefined) throw new Error("unknown descriptor");
    return {
      dev: 1,
      ino: fd,
      size: Buffer.byteLength(value),
      nlink: 1,
      mtimeMs: 1,
      isFile: () => true
    };
  },
  readSync(fd, buffer, offset, length, position) {
    const value = descriptorFiles.get(fd);
    if (value === undefined) throw new Error("unknown descriptor");
    descriptorReads.push({ fd, position });
    const source = Buffer.from(value);
    const count = Math.min(length, Math.max(0, source.length - position));
    if (count > 0) source.copy(buffer, offset, position, position + count);
    return count;
  }
};
let ordinaryLoadCount = 0;
let defaultPathResolveCount = 0;
function resolveDefaultIdentityPath() {
  defaultPathResolveCount += 1;
  return "/ordinary/identity/device.json";
}
function normalizeStoredIdentity(parsed) {
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return null;
  if (parsed.validForReadOnly !== true || typeof parsed.deviceId !== "string") {
    return { kind: "recognized-invalid" };
  }
  return {
    kind: "identity",
    validForReadOnly: true,
    identity: {
      deviceId: parsed.deviceId,
      publicKeyPem: parsed.publicKeyPem,
      privateKeyPem: parsed.privateKeyPem
    }
  };
}
function loadOrCreateDeviceIdentity(filePath = resolveDefaultIdentityPath()) {
  try {
    ordinaryLoadCount += 1;
    return { deviceId: "ordinary-device", filePath };
  } catch {
    return { deviceId: "ordinary-fallback" };
  }
}
function setForcedIdentityDescriptor(fd, value) {
  process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING = "1";
  if (fd === undefined) delete process.env.NEMOCLAW_OPENCLAW_IDENTITY_FD;
  else process.env.NEMOCLAW_OPENCLAW_IDENTITY_FD = fd;
  descriptorFiles.clear();
  descriptorReads.length = 0;
  if (typeof fd === "string" && /^[1-9]\\d*$/.test(fd) && value !== undefined) {
    descriptorFiles.set(Number(fd), typeof value === "string" ? value : JSON.stringify(value));
  }
}
function clearForcedIdentityDescriptor() {
  delete process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING;
  delete process.env.NEMOCLAW_OPENCLAW_IDENTITY_FD;
}
function identityStats() {
  return { descriptorReads: [...descriptorReads], ordinaryLoadCount, defaultPathResolveCount };
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

function gatewayAuthFixture(): string {
  return compiledIndent(`
const GATEWAY_CLIENT_IDS = { CLI: "cli" };
const GATEWAY_CLIENT_MODES = { CLI: "cli" };
function mapDeviceTokenAuthFailureReason() { return "device_token_mismatch"; }
async function resolveConnectAuthDecisionCore(params) {
  let authResult = params.state.authResult;
  let authOk = params.state.authOk;
  let authMethod = params.state.authMethod;
  let deviceTokenSharedGatewaySessionGeneration;
  function finish() { return { authResult, authOk, authMethod, deviceTokenSharedGatewaySessionGeneration }; }
  const deviceTokenCandidate = params.state.deviceTokenCandidate;
  if (!params.hasDeviceIdentity || !params.deviceId || authOk || !deviceTokenCandidate) return finish();
  const tokenCheck = await params.verifyDeviceToken({
    deviceId: params.deviceId,
    token: deviceTokenCandidate,
    role: params.role,
    scopes: params.scopes
  });
    if (tokenCheck.ok) {
      authOk = true;
      authMethod = "device-token";
    if (tokenCheck.issuer?.kind === "shared-gateway-auth") deviceTokenSharedGatewaySessionGeneration = tokenCheck.issuer.generation;
    params.rateLimiter?.reset(params.clientIp, "device-token");
  } else {
    authResult = { ok: false, reason: mapDeviceTokenAuthFailureReason() };
    params.rateLimiter?.recordFailure(params.clientIp, "device-token");
  }
  return finish();
}
async function resolveConnectAuthDecision(params) { return resolveConnectAuthDecisionCore(params); }
async function connect(connectParams, verifyDeviceToken) {
  const role = connectParams.role;
  const scopes = connectParams.scopes;
  const authRateLimiter = null;
  const authDecision = await resolveConnectAuthDecision({
    state: {
      authResult: { ok: false },
      authOk: false,
      authMethod: "token",
      deviceTokenCandidate: "stored-token"
    },
    hasDeviceIdentity: true,
    deviceId: "device-1",
    publicKey: "public-key-1",
          role,
          scopes,
          rateLimiter: authRateLimiter,
    clientIp: "127.0.0.1",
    verifyBootstrapToken: async () => ({ ok: false }),
    verifyDeviceToken: async (paramsLocal) => await verifyDeviceToken(paramsLocal)
  });
  return authDecision;
}
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
let failNextIdleJournalWrite = false;
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
function resolvePairingPaths(baseDir, subdir = "devices") {
  const root = baseDir ?? "/fixture";
  const dir = \`\${root}/\${subdir}\`;
  return { dir, pendingPath: \`\${dir}/pending.json\`, pairedPath: \`\${dir}/paired.json\` };
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
  if (file.endsWith(".nemoclaw-self-approval-journal") && value?.phase === "idle" && failNextIdleJournalWrite) {
    failNextIdleJournalWrite = false;
    throw new Error("idle journal cleanup failed");
  }
  files.set(file, cloneJson(value));
  if (file.endsWith(".nemoclaw-self-approval-journal") && value?.phase === "committed" && failCommittedJournalAfterWrite) {
    failCommittedJournalAfterWrite = false;
    throw new Error("committed journal durability acknowledgement failed");
  }
}
function setPairingState(pendingById, pairedByDeviceId, baseDir = "/fixture") {
  const { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
  const authPath = \`\${resolvePairingPaths(baseDir, "identity").dir}/device-auth.json\`;
  files.set(pendingPath, cloneJson(pendingById));
  files.set(pairedPath, cloneJson(pairedByDeviceId));
  const pairedDevice = Object.values(pairedByDeviceId)[0];
  const tokens = pairedDevice?.tokens;
  const operator = Array.isArray(tokens)
    ? tokens.find((entry) => entry?.role === "operator")
    : tokens?.operator;
  if (typeof operator?.token === "string" && operator.token) {
    files.set(authPath, cloneJson({
      version: 1,
      deviceId: pairedDevice.deviceId,
      tokens: {
        operator: {
          token: operator.token,
          role: "operator",
          scopes: operator.scopes,
          updatedAtMs: 1,
        },
      },
    }));
  }
}
function setFile(file, value) { files.set(file, cloneJson(value)); }
function getFile(file) { return files.has(file) ? cloneJson(files.get(file)) : null; }
function getPairingPaths(baseDir = "/fixture") {
  const paths = resolvePairingPaths(baseDir, "devices");
  return {
    ...paths,
    authPath: \`\${resolvePairingPaths(baseDir, "identity").dir}/device-auth.json\`,
    journalPath: \`\${paths.pendingPath}.nemoclaw-self-approval-journal\`,
  };
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
function armIdleJournalFailure() { failNextIdleJournalWrite = true; }
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
  fs.writeFileSync(path.join(dist, "call-fixture.js"), gatewayCallFixture());
  fs.writeFileSync(path.join(dist, "device-identity-fixture.js"), deviceIdentityFixture());
  fs.writeFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), cliFixture());
  fs.writeFileSync(path.join(dist, "message-handler-fixture.js"), gatewayAuthFixture());
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
  return vm.runInNewContext(`${source}\n${expression}`, { Buffer, URL }) as T;
}

export interface PairingFixtureRuntime {
  writes: Array<{ file: string; value: unknown; options?: Record<string, unknown> }>;
  setPairingState(
    pendingById: Record<string, unknown>,
    pairedByDeviceId: Record<string, unknown>,
    baseDir?: string,
  ): void;
  setFile(file: string, value: unknown): void;
  getFile(file: string): unknown;
  getPairingPaths(baseDir?: string): {
    authPath: string;
    pendingPath: string;
    pairedPath: string;
    journalPath: string;
  };
  listDevicePairing(baseDir?: string): Promise<{
    pending: Array<Record<string, unknown>>;
    paired: Array<Record<string, unknown>>;
  }>;
  getPairedDevice(deviceId: string, baseDir?: string): Promise<Record<string, unknown> | null>;
  getPendingDevicePairing(
    requestId: string,
    baseDir?: string,
  ): Promise<Record<string, unknown> | null>;
  approveDevicePairing(
    requestId: string,
    options: Record<string, unknown>,
    baseDir?: string,
  ): Promise<Record<string, unknown> | null>;
  approveBootstrapDevicePairing(
    requestId: string,
    bootstrapProfile: Record<string, unknown>,
    baseDir?: string,
  ): Promise<Record<string, unknown> | null>;
  armLateWriterFailure(): Promise<void>;
  releaseLateWriter(): void;
  armCommittedJournalFailure(): void;
  armIdleJournalFailure(): void;
  armStateDrift(file: string, value: unknown): void;
}

export function openPatchedPairingFixture(): {
  runtime: PairingFixtureRuntime;
  source: string;
  tmp: string;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-state-runtime-"));
  const dist = path.join(tmp, "dist");
  fs.mkdirSync(dist);
  writeFixtureDist(dist);
  const apply = runPatch(dist);
  if (apply.status !== 0) {
    throw new Error(`OpenClaw pairing fixture patch failed: ${apply.stdout}${apply.stderr}`);
  }
  const source = fs.readFileSync(path.join(dist, "device-pairing-fixture.js"), "utf8");
  const runtime = runFixture<PairingFixtureRuntime>(
    source,
    `({
      writes,
      setPairingState,
      setFile,
      getFile,
      getPairingPaths,
      listDevicePairing,
      getPairedDevice,
      getPendingDevicePairing,
      approveDevicePairing,
      approveBootstrapDevicePairing,
      armLateWriterFailure,
      releaseLateWriter,
      armCommittedJournalFailure,
      armIdleJournalFailure,
      armStateDrift
    })`,
  );
  return { runtime, source, tmp };
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

export function selfApprovalTransactionSnapshots() {
  const pending = validPending({ ts: 100 });
  const pairedBefore = validPaired({
    approvedAtMs: 100,
    tokens: {
      operator: { token: "token-before", role: "operator", scopes: ["operator.pairing"] },
    },
  });
  const pairedAfter = validPaired({
    approvedAtMs: 200,
    scopes: ["operator.pairing", "operator.read", "operator.write"],
    approvedScopes: ["operator.pairing", "operator.read", "operator.write"],
    tokens: {
      operator: {
        token: "token-after",
        role: "operator",
        scopes: ["operator.pairing", "operator.read", "operator.write"],
      },
    },
  });
  return {
    before: {
      auth: {
        version: 1,
        deviceId: "device-1",
        tokens: {
          operator: {
            token: "token-before",
            role: "operator",
            scopes: ["operator.pairing"],
            updatedAtMs: 1,
          },
        },
      },
      pendingById: { "request-1": pending },
      pairedByDeviceId: { "device-1": pairedBefore },
    },
    after: {
      auth: {
        version: 1,
        deviceId: "device-1",
        tokens: {
          operator: {
            token: "token-after",
            role: "operator",
            scopes: ["operator.pairing", "operator.read", "operator.write"],
            updatedAtMs: 1,
          },
        },
      },
      pendingById: {},
      pairedByDeviceId: { "device-1": pairedAfter },
    },
  };
}

export function selfApprovalTransactionJournal(
  phase: "prepared" | "committed",
  snapshots: ReturnType<typeof selfApprovalTransactionSnapshots>,
) {
  return {
    version: 2,
    kind: "nemoclaw-self-approval",
    phase,
    requestId: "request-1",
    deviceId: "device-1",
    before: snapshots.before,
    after: snapshots.after,
  };
}

export function selfApprovalOptions() {
  return {
    callerScopes: ["operator.pairing"],
    nemoclawSelfApprovalIdentity: {
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      clientId: "cli",
      clientMode: "cli",
      deviceToken: "token-before",
    },
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
      auth: { token: "token-before" },
      device: { id: "device-1", publicKey: "public-key-1" },
      client: { id: "cli", mode: "cli" },
    },
    ...overrides,
  };
}
