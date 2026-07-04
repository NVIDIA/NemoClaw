// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * Temporary compatibility patch for OpenClaw 2026.6.10 device scope upgrades.
 *
 * The 2026.6.10 devices CLI asks for the scopes it is trying to approve. A
 * device that currently has only operator.pairing is therefore rejected by
 * the gateway handshake before device.pair.approve can run. Its operator.admin
 * retry fails the same way, after which NemoClaw historically repaired the two
 * JSON state files directly. A configured gateway.auth.token would otherwise
 * take precedence over the already-issued device credential and reach the
 * handler as shared-token auth. Keep the entire approval in OpenClaw instead:
 * for the exact same-device CLI repair, explicitly use OpenClaw's stored device
 * credential with operator.pairing, then let the gateway's canonical
 * approveDevicePairing path reload, lock, rotate the token, persist, broadcast,
 * and respond.
 *
 * Remove this patch when upstream OpenClaw supports same-device, operator-only
 * scope approval through the gateway using the already-approved pairing scope
 * and publishes the pending/paired transition atomically or with equivalent
 * durable restart recovery.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const AUDIT_FLAG = "--audit";
const EXIT_APPLY_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_AUDIT_FAILURE = 3;
const CLI_MARKER = "nemoclaw: forward stored device auth for bounded same-device scope approval";
const CLI_APPROVE_MARKER =
  "nemoclaw: select stored device auth for bounded same-device scope approval";
const CLI_SCOPE_MARKER = "nemoclaw: reach gateway for bounded same-device scope approval";
const CLI_RETRY_MARKER = "nemoclaw: keep bounded stored device auth fail closed";
const CLI_LIST_MARKER = "nemoclaw: preflight bounded stored device auth before live pairing list";
const CLI_APPLIED_MARKERS = [
  CLI_MARKER,
  CLI_APPROVE_MARKER,
  CLI_SCOPE_MARKER,
  CLI_RETRY_MARKER,
  CLI_LIST_MARKER,
] as const;
const HANDLER_MARKER = "nemoclaw: bounded same-device scope approval";
const STATE_MARKER = "nemoclaw: validate bounded self-approval inside pairing lock";
const STATE_TRANSACTION_MARKER = "nemoclaw: recover bounded self-approval state transaction";
const STATE_APPLIED_MARKERS = [STATE_MARKER, STATE_TRANSACTION_MARKER] as const;
const CLI_SELECTOR_DEPENDENCIES = [
  "normalizeDeviceRoles",
  "resolvePairedOperatorScopes",
  "GATEWAY_CLIENT_NAMES",
  "GATEWAY_CLIENT_MODES",
  "OPERATOR_ROLE",
  "PAIRING_SCOPE",
  "normalizeOptionalString",
  "listDevicePairing",
] as const;

type PatchStatus = "already-applied" | "no-match" | "would-apply";

interface ReplacementResult {
  source: string;
  error?: string;
}

interface PatchResult extends ReplacementResult {
  status: PatchStatus;
}

interface FileSpec {
  id: string;
  label: string;
  marker: string;
  selector(source: string): boolean;
  patch(source: string, file: string): PatchResult;
}

interface ResolvedSpecFile {
  file: string | null;
  error?: string;
}

const args = process.argv.slice(2);
const auditMode = args.includes(AUDIT_FLAG);
const positional = args.filter((value) => value !== AUDIT_FLAG);
const distDir = positional[0];

if (!distDir || positional.length !== 1) {
  console.error("Usage: patch-openclaw-device-self-approval.ts [--audit] <openclaw-dist-dir>");
  process.exit(EXIT_USAGE);
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(EXIT_APPLY_FAILURE);
}

function listJsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry: import("node:fs").Dirent) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry: import("node:fs").Dirent) => path.join(dir, entry.name));
}

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let offset = source.indexOf(needle);
  while (offset !== -1) {
    count += 1;
    offset = source.indexOf(needle, offset + needle.length);
  }
  return count;
}

function replaceExactlyOnce(
  source: string,
  needle: string,
  replacement: string,
  label: string,
  file: string,
): ReplacementResult {
  const count = countOccurrences(source, needle);
  if (count !== 1) {
    return {
      source,
      error: `${label} in ${file}: expected exactly one target, found ${count}`,
    };
  }
  return { source: source.replace(needle, replacement) };
}

const CLI_TARGET = [
  "\tfor (const scope of operatorScopes) {",
  "\t\tif (!isKnownNonAdminOperatorScope(scope)) return [ADMIN_SCOPE];",
  "\t\tout.add(scope);",
  "\t}",
  "\treturn [...out];",
].join("\n");

const CLI_HELPER_ANCHOR = "function resolveApprovePairingScopesForRequest(request, paired) {";
const CLI_HELPER = [
  "function resolveNemoClawSelfRepairPairingContext(request, paired) {",
  "\tconst nemoclawRawScopes = request.scopes;",
  "\tconst nemoclawRoles = normalizeDeviceRoles(request);",
  "\tconst nemoclawPairedTokens = paired?.tokens;",
  '\tconst nemoclawPairedView = nemoclawPairedTokens && typeof nemoclawPairedTokens === "object" && !Array.isArray(nemoclawPairedTokens) ? { ...paired, tokens: Object.values(nemoclawPairedTokens) } : paired;',
  "\tconst nemoclawPairedScopes = resolvePairedOperatorScopes(nemoclawPairedView);",
  "\tconst nemoclawPairingBaselineVisible = nemoclawPairedScopes.length > 0;",
  '\tconst nemoclawNormalizedRawScopes = Array.isArray(nemoclawRawScopes) ? nemoclawRawScopes.map((scope) => typeof scope === "string" ? scope.trim() : "") : [];',
  "\tconst nemoclawUsePairingTransport =",
  "\t\tArray.isArray(nemoclawRawScopes) &&",
  "\t\tnemoclawRawScopes.length > 0 &&",
  '\t\tnemoclawRawScopes.every((scope) => typeof scope === "string" && scope.trim() && isKnownNonAdminOperatorScope(scope.trim())) &&',
  "\t\trequest.clientId === GATEWAY_CLIENT_NAMES.CLI &&",
  "\t\trequest.clientMode === GATEWAY_CLIENT_MODES.CLI &&",
  "\t\trequest.isRepair === true &&",
  "\t\tnemoclawRoles.length === 1 &&",
  "\t\tnemoclawRoles[0] === OPERATOR_ROLE &&",
  "\t\t(!nemoclawPairingBaselineVisible || nemoclawPairedScopes.includes(PAIRING_SCOPE));",
  '\tconst nemoclawStoredAuthAllowedScopes = new Set([PAIRING_SCOPE, "operator.read", "operator.write"]);',
  "\tconst nemoclawRequestDeviceId = normalizeOptionalString(request.deviceId);",
  "\tconst nemoclawPairedDeviceId = normalizeOptionalString(nemoclawPairedView?.deviceId);",
  "\tconst nemoclawRequestPublicKey = normalizeOptionalString(request.publicKey);",
  "\tconst nemoclawPairedPublicKey = normalizeOptionalString(nemoclawPairedView?.publicKey);",
  "\treturn {",
  "\t\tusePairingTransport: nemoclawUsePairingTransport,",
  "\t\tuseStoredDeviceAuth:",
  "\t\t\tnemoclawUsePairingTransport &&",
  "\t\t\tnemoclawNormalizedRawScopes.length === new Set(nemoclawNormalizedRawScopes).size &&",
  "\t\t\tnemoclawNormalizedRawScopes.every((scope) => nemoclawStoredAuthAllowedScopes.has(scope)) &&",
  "\t\t\tnemoclawPairedScopes.includes(PAIRING_SCOPE) &&",
  "\t\t\tBoolean(nemoclawRequestDeviceId) &&",
  "\t\t\tnemoclawRequestDeviceId === nemoclawPairedDeviceId &&",
  "\t\t\tBoolean(nemoclawRequestPublicKey) &&",
  "\t\t\tnemoclawRequestPublicKey === nemoclawPairedPublicKey",
  "\t};",
  "}",
  "",
].join("\n");

const CLI_REPLACEMENT = [
  "\tfor (const scope of operatorScopes) {",
  "\t\tif (!isKnownNonAdminOperatorScope(scope)) return [ADMIN_SCOPE];",
  "\t\tout.add(scope);",
  "\t}",
  "\tif (resolveNemoClawSelfRepairPairingContext(request, paired).usePairingTransport) return [PAIRING_SCOPE]; // nemoclaw: reach gateway for bounded same-device scope approval (#4462)",
  "\treturn [...out];",
].join("\n");

const CLI_CALL_GATEWAY_TARGET = [
  "\tclientName: GATEWAY_CLIENT_NAMES.CLI,",
  "\tmode: GATEWAY_CLIENT_MODES.CLI,",
  "\tscopes: callOpts?.scopes",
  "}));",
].join("\n");
const CLI_CALL_GATEWAY_REPLACEMENT = [
  "\tclientName: GATEWAY_CLIENT_NAMES.CLI,",
  "\tmode: GATEWAY_CLIENT_MODES.CLI,",
  "\tscopes: callOpts?.scopes,",
  "\t...(callOpts?.useStoredDeviceAuth === true ? {",
  "\t\tuseStoredDeviceAuth: true, // nemoclaw: forward stored device auth for bounded same-device scope approval (#4462)",
  "\t\trequiredStoredDeviceAuthScopes: callOpts.requiredStoredDeviceAuthScopes",
  "\t} : {})",
  "}));",
].join("\n");

const CLI_LIST_SIGNATURE_TARGET = "async function listPairingWithFallback(opts) {";
const CLI_LIST_SIGNATURE_REPLACEMENT =
  "async function listPairingWithFallback(opts, callOpts) { // nemoclaw: preflight bounded stored device auth before live pairing list (#4462)";
const CLI_LIST_CALL_TARGET =
  '\t\treturn parseDevicePairingList(await callGatewayCli("device.pair.list", opts, {}));';
const CLI_LIST_CALL_REPLACEMENT =
  '\t\treturn parseDevicePairingList(await callGatewayCli("device.pair.list", opts, {}, callOpts));';

const CLI_CONTEXT_TARGET = [
  "async function resolveApprovePairingGatewayContext(opts, requestId) {",
  "\ttry {",
  "\t\tconst list = await listPairingWithFallback(opts);",
  "\t\tconst request = findPendingRequestById(list.pending, requestId);",
  "\t\tif (!request) return {",
  "\t\t\toriginalRequest: null,",
  "\t\t\tscopes: void 0",
  "\t\t};",
  "\t\treturn {",
  "\t\t\toriginalRequest: request,",
  "\t\t\tscopes: resolveApprovePairingScopesForRequest(request, lookupPairedDevice(indexPairedDevices(list.paired), request))",
  "\t\t};",
  "\t} catch {",
  "\t\treturn {",
  "\t\t\toriginalRequest: null,",
  "\t\t\tscopes: void 0",
  "\t\t};",
  "\t}",
  "}",
].join("\n");
const CLI_CONTEXT_REPLACEMENT = [
  "async function resolveApprovePairingGatewayContext(opts, requestId) {",
  "\tlet nemoclawLocalStoredAuthCandidate = false;",
  "\ttry {",
  "\t\tconst nemoclawLocalList = await listDevicePairing();",
  "\t\tconst nemoclawLocalRequest = findPendingRequestById(nemoclawLocalList.pending, requestId);",
  "\t\tif (nemoclawLocalRequest) {",
  "\t\t\tconst nemoclawLocalPaired = lookupPairedDevice(indexPairedDevices(nemoclawLocalList.paired), nemoclawLocalRequest);",
  "\t\t\tnemoclawLocalStoredAuthCandidate = resolveNemoClawSelfRepairPairingContext(nemoclawLocalRequest, nemoclawLocalPaired).useStoredDeviceAuth;",
  "\t\t}",
  "\t} catch {}",
  "\ttry {",
  "\t\tconst nemoclawListCallOpts = nemoclawLocalStoredAuthCandidate ? {",
  "\t\t\tscopes: [PAIRING_SCOPE],",
  "\t\t\tuseStoredDeviceAuth: true,",
  "\t\t\trequiredStoredDeviceAuthScopes: [PAIRING_SCOPE]",
  "\t\t} : void 0;",
  "\t\tconst list = await listPairingWithFallback(opts, nemoclawListCallOpts);",
  "\t\tconst request = findPendingRequestById(list.pending, requestId);",
  "\t\tif (!request) return {",
  "\t\t\toriginalRequest: null,",
  "\t\t\tscopes: void 0,",
  "\t\t\tnemoclawUseStoredDeviceAuth: false,",
  "\t\t\tnemoclawRefuseUnsafeApproval: nemoclawLocalStoredAuthCandidate",
  "\t\t};",
  "\t\tconst paired = lookupPairedDevice(indexPairedDevices(list.paired), request);",
  "\t\tconst nemoclawSelfRepairContext = resolveNemoClawSelfRepairPairingContext(request, paired);",
  "\t\tconst nemoclawUseStoredDeviceAuth = nemoclawLocalStoredAuthCandidate && nemoclawSelfRepairContext.useStoredDeviceAuth;",
  "\t\treturn {",
  "\t\t\toriginalRequest: request,",
  "\t\t\tscopes: resolveApprovePairingScopesForRequest(request, paired),",
  "\t\t\tnemoclawUseStoredDeviceAuth,",
  "\t\t\tnemoclawRefuseUnsafeApproval: nemoclawLocalStoredAuthCandidate && !nemoclawUseStoredDeviceAuth",
  "\t\t};",
  "\t} catch {",
  "\t\treturn {",
  "\t\t\toriginalRequest: null,",
  "\t\t\tscopes: void 0,",
  "\t\t\tnemoclawUseStoredDeviceAuth: false,",
  "\t\t\tnemoclawRefuseUnsafeApproval: nemoclawLocalStoredAuthCandidate",
  "\t\t};",
  "\t}",
  "}",
].join("\n");

const CLI_APPROVE_HEADER_TARGET =
  "\tconst { scopes, originalRequest } = await resolveApprovePairingGatewayContext(opts, requestId);";
const CLI_APPROVE_HEADER_REPLACEMENT =
  '\tconst { scopes, originalRequest, nemoclawUseStoredDeviceAuth, nemoclawRefuseUnsafeApproval } = await resolveApprovePairingGatewayContext(opts, requestId);\n\tif (nemoclawRefuseUnsafeApproval) throw new Error("bounded same-device approval context changed before gateway approval");';
const CLI_APPROVE_CALL_TARGET =
  '\t\treturn await callGatewayCli("device.pair.approve", opts, { requestId }, scopes ? { scopes } : void 0);';
const CLI_APPROVE_CALL_REPLACEMENT = [
  '\t\treturn await callGatewayCli("device.pair.approve", opts, { requestId }, nemoclawUseStoredDeviceAuth ? {',
  "\t\t\tscopes,",
  "\t\t\tuseStoredDeviceAuth: true, // nemoclaw: select stored device auth for bounded same-device scope approval (#4462)",
  "\t\t\trequiredStoredDeviceAuthScopes: [PAIRING_SCOPE]",
  "\t\t} : scopes ? { scopes } : void 0);",
].join("\n");
const CLI_ADMIN_RETRY_TARGET =
  '\t\tif (isDevicePairingApprovalDenied(error) && !scopes?.includes("operator.admin")) return await callGatewayCli("device.pair.approve", opts, { requestId }, { scopes: [ADMIN_SCOPE] });';
const CLI_ADMIN_RETRY_REPLACEMENT = [
  "\t\tif (nemoclawUseStoredDeviceAuth) throw error; // nemoclaw: keep bounded stored device auth fail closed (#4462)",
  CLI_ADMIN_RETRY_TARGET,
].join("\n");

const HANDLER_HELPER = [
  "function resolveNemoClawSelfApprovalIdentity(pending, authz, client) {",
  "\tif (authz.isAdminCaller || client?.isDeviceTokenAuth !== true || pending?.isRepair !== true) return null;",
  '\tconst callerDeviceId = typeof authz.callerDeviceId === "string" ? authz.callerDeviceId.trim() : "";',
  '\tconst clientDeviceId = typeof client?.connect?.device?.id === "string" ? client.connect.device.id.trim() : "";',
  '\tconst pendingDeviceId = typeof pending?.deviceId === "string" ? pending.deviceId.trim() : "";',
  '\tconst clientPublicKey = typeof client?.connect?.device?.publicKey === "string" ? client.connect.device.publicKey.trim() : "";',
  '\tconst pendingPublicKey = typeof pending?.publicKey === "string" ? pending.publicKey.trim() : "";',
  '\tconst clientRole = typeof client?.connect?.role === "string" ? client.connect.role.trim() : "";',
  '\tconst clientId = typeof client?.connect?.client?.id === "string" ? client.connect.client.id.trim() : "";',
  '\tconst clientMode = typeof client?.connect?.client?.mode === "string" ? client.connect.client.mode.trim() : "";',
  '\tconst pendingClientId = typeof pending?.clientId === "string" ? pending.clientId.trim() : "";',
  '\tconst pendingClientMode = typeof pending?.clientMode === "string" ? pending.clientMode.trim() : "";',
  "\tif (",
  "\t\t!callerDeviceId ||",
  "\t\tcallerDeviceId !== clientDeviceId ||",
  "\t\tcallerDeviceId !== pendingDeviceId ||",
  "\t\t!clientPublicKey ||",
  "\t\tclientPublicKey !== pendingPublicKey ||",
  '\t\tclientRole !== "operator" ||',
  '\t\tclientId !== "cli" ||',
  '\t\tclientMode !== "cli" ||',
  "\t\tpendingClientId !== clientId ||",
  "\t\tpendingClientMode !== clientMode ||",
  "\t\t!Array.isArray(authz.callerScopes) ||",
  '\t\t!authz.callerScopes.includes("operator.pairing") ||',
  '\t\tauthz.callerScopes.some((scope) => !["operator.pairing", "operator.read", "operator.write"].includes(scope))',
  "\t) return null;",
  "\tconst roles = new Set();",
  "\tif (pending.role !== void 0) {",
  '\t\tif (typeof pending.role !== "string" || !pending.role.trim()) return null;',
  "\t\troles.add(pending.role.trim());",
  "\t}",
  "\tif (pending.roles !== void 0) {",
  "\t\tif (!Array.isArray(pending.roles)) return null;",
  "\t\tfor (const role of pending.roles) {",
  '\t\t\tif (typeof role !== "string" || !role.trim()) return null;',
  "\t\t\troles.add(role.trim());",
  "\t\t}",
  "\t}",
  '\tif (roles.size !== 1 || !roles.has("operator")) return null;',
  "\tif (!Array.isArray(pending.scopes) || pending.scopes.length === 0) return null;",
  "\treturn { deviceId: callerDeviceId, publicKey: clientPublicKey, role: clientRole, clientId, clientMode };",
  "} // nemoclaw: bounded same-device scope approval (#4462)",
  "",
].join("\n");

const HANDLER_HELPER_ANCHOR =
  "/** Gateway request handlers for device pair approval, removal, token rotation, and revocation. */";
const HANDLER_AUTHZ_TARGET = [
  "\t\tconst { requestId } = params;",
  "\t\tconst authz = resolveDeviceSessionAuthz(client);",
  "\t\tif (!authz.isAdminCaller) {",
].join("\n");
const HANDLER_AUTHZ_REPLACEMENT = [
  "\t\tconst { requestId } = params;",
  "\t\tconst authz = resolveDeviceSessionAuthz(client);",
  "\t\tlet nemoclawSelfApprovalIdentity = null;",
  "\t\tif (!authz.isAdminCaller) {",
].join("\n");
const HANDLER_ROLE_TARGET = [
  "\t\t\tif (requestsNonOperatorDeviceRole(pending)) {",
  "\t\t\t\tcontext.logGateway.warn(`device pairing approval denied request=${requestId} reason=role-management-requires-admin`);",
  "\t\t\t\temitDevicePairingDeniedSecurityEvent({",
  "\t\t\t\t\tauthz,",
  "\t\t\t\t\ttargetDeviceId: pending.deviceId,",
  '\t\t\t\t\tcontrolId: "device.pair.approve",',
  '\t\t\t\t\treason: "role-management-requires-admin"',
  "\t\t\t\t});",
  "\t\t\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_PAIR_APPROVAL_DENIED_MESSAGE));",
  "\t\t\t\treturn;",
  "\t\t\t}",
  "\t\t}",
].join("\n");
const HANDLER_ROLE_REPLACEMENT = [
  HANDLER_ROLE_TARGET.slice(0, -"\n\t\t}".length),
  "\t\t\tnemoclawSelfApprovalIdentity = resolveNemoClawSelfApprovalIdentity(pending, authz, client);",
  "\t\t}",
].join("\n");
const HANDLER_APPROVE_TARGET =
  "\t\tconst approved = await approveDevicePairing(requestId, { callerScopes: authz.callerScopes });";
const HANDLER_APPROVE_REPLACEMENT =
  "\t\tconst approved = await approveDevicePairing(requestId, { callerScopes: authz.callerScopes, nemoclawSelfApprovalIdentity });";

const STATE_TRANSACTION_HELPER = [
  "const NEMOCLAW_SELF_APPROVAL_JOURNAL_VERSION = 1;",
  'const NEMOCLAW_SELF_APPROVAL_JOURNAL_KIND = "nemoclaw-self-approval";',
  'const NEMOCLAW_SELF_APPROVAL_JOURNAL_SUFFIX = ".nemoclaw-self-approval-journal";',
  "const NEMOCLAW_SELF_APPROVAL_JOURNAL_WRITE_OPTIONS = { mode: 384, dirMode: 448, trailingNewline: true };",
  'const NEMOCLAW_SELF_APPROVAL_LOADED_SNAPSHOT = Symbol("nemoclaw-self-approval-loaded-snapshot");',
  "function nemoclawIsPlainRecord(value) {",
  '\tif (!value || typeof value !== "object" || Array.isArray(value)) return false;',
  "\tconst prototype = Object.getPrototypeOf(value);",
  "\treturn prototype === Object.prototype || prototype === null;",
  "}",
  "function nemoclawHasExactKeys(value, expected) {",
  "\tconst actual = Object.keys(value).toSorted();",
  "\tconst wanted = [...expected].toSorted();",
  "\treturn actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);",
  "}",
  "function nemoclawIsPairingRecord(value) {",
  "\treturn nemoclawIsPlainRecord(value) && Object.values(value).every((entry) => nemoclawIsPlainRecord(entry));",
  "}",
  "function nemoclawIsSnapshot(value) {",
  "\treturn (",
  "\t\tnemoclawIsPlainRecord(value) &&",
  '\t\tnemoclawHasExactKeys(value, ["pairedByDeviceId", "pendingById"]) &&',
  "\t\tnemoclawIsPairingRecord(value.pendingById) &&",
  "\t\tnemoclawIsPairingRecord(value.pairedByDeviceId)",
  "\t);",
  "}",
  "function nemoclawStatesEqual(left, right) {",
  "\tif (Object.is(left, right)) return true;",
  "\tif (Array.isArray(left) || Array.isArray(right)) {",
  "\t\treturn Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => nemoclawStatesEqual(value, right[index]));",
  "\t}",
  "\tif (!nemoclawIsPlainRecord(left) || !nemoclawIsPlainRecord(right)) return false;",
  "\tconst leftKeys = Object.keys(left).toSorted();",
  "\tconst rightKeys = Object.keys(right).toSorted();",
  "\treturn leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && nemoclawStatesEqual(left[key], right[key]));",
  "}",
  "function nemoclawResolveJournalPath(baseDir) {",
  '\treturn `${resolvePairingPaths(baseDir, "devices").pendingPath}${NEMOCLAW_SELF_APPROVAL_JOURNAL_SUFFIX}`;',
  "}",
  "function nemoclawIdleJournal() {",
  '\treturn { version: NEMOCLAW_SELF_APPROVAL_JOURNAL_VERSION, kind: NEMOCLAW_SELF_APPROVAL_JOURNAL_KIND, phase: "idle" };',
  "}",
  "function nemoclawValidateJournal(value) {",
  '\tif (!nemoclawIsPlainRecord(value)) throw new Error("invalid NemoClaw self-approval journal object");',
  '\tif (value.version !== NEMOCLAW_SELF_APPROVAL_JOURNAL_VERSION || value.kind !== NEMOCLAW_SELF_APPROVAL_JOURNAL_KIND) throw new Error("invalid NemoClaw self-approval journal identity");',
  '\tif (value.phase === "idle") {',
  '\t\tif (!nemoclawHasExactKeys(value, ["kind", "phase", "version"])) throw new Error("invalid NemoClaw idle self-approval journal");',
  "\t\treturn value;",
  "\t}",
  '\tif (value.phase !== "prepared" && value.phase !== "committed") throw new Error("invalid NemoClaw self-approval journal phase");',
  '\tif (!nemoclawHasExactKeys(value, ["after", "before", "deviceId", "kind", "phase", "requestId", "version"])) throw new Error("invalid NemoClaw self-approval journal schema");',
  '\tif (typeof value.requestId !== "string" || !value.requestId.trim() || value.requestId !== value.requestId.trim()) throw new Error("invalid NemoClaw self-approval journal request id");',
  '\tif (typeof value.deviceId !== "string" || !value.deviceId.trim() || value.deviceId !== value.deviceId.trim()) throw new Error("invalid NemoClaw self-approval journal device id");',
  '\tif (!nemoclawIsSnapshot(value.before) || !nemoclawIsSnapshot(value.after)) throw new Error("invalid NemoClaw self-approval journal snapshots");',
  "\tconst pendingBefore = value.before.pendingById[value.requestId];",
  "\tconst pairedBefore = value.before.pairedByDeviceId[value.deviceId];",
  "\tconst pairedAfter = value.after.pairedByDeviceId[value.deviceId];",
  "\tif (",
  "\t\t!nemoclawIsPlainRecord(pendingBefore) ||",
  "\t\tpendingBefore.deviceId !== value.deviceId ||",
  "\t\t!nemoclawIsPlainRecord(pairedBefore) ||",
  "\t\tpairedBefore.deviceId !== value.deviceId ||",
  "\t\tvalue.requestId in value.after.pendingById ||",
  "\t\t!nemoclawIsPlainRecord(pairedAfter) ||",
  "\t\tpairedAfter.deviceId !== value.deviceId",
  '\t) throw new Error("invalid NemoClaw self-approval journal transition");',
  "\treturn value;",
  "}",
  "async function nemoclawReadPairingSnapshot(baseDir) {",
  '\tconst { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");',
  "\tconst [pending, paired] = await Promise.all([readJsonIfExists(pendingPath), readJsonIfExists(pairedPath)]);",
  "\tconst snapshot = { pendingById: pending ?? {}, pairedByDeviceId: paired ?? {} };",
  '\tif (!nemoclawIsSnapshot(snapshot)) throw new Error("invalid device pairing state during NemoClaw self-approval transaction");',
  "\treturn snapshot;",
  "}",
  "async function nemoclawWritePairingSnapshot(snapshot, baseDir) {",
  '\tconst { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");',
  "\tconst settled = await Promise.allSettled([writeJson(pendingPath, snapshot.pendingById), writeJson(pairedPath, snapshot.pairedByDeviceId)]);",
  '\tconst failures = settled.filter((result) => result.status === "rejected").map((result) => result.reason);',
  '\tif (failures.length > 0) throw new AggregateError(failures, "failed to publish both device pairing state files");',
  "}",
  "function nemoclawCurrentMatchesJournal(current, journal) {",
  "\treturn (",
  "\t\t(nemoclawStatesEqual(current.pendingById, journal.before.pendingById) || nemoclawStatesEqual(current.pendingById, journal.after.pendingById)) &&",
  "\t\t(nemoclawStatesEqual(current.pairedByDeviceId, journal.before.pairedByDeviceId) || nemoclawStatesEqual(current.pairedByDeviceId, journal.after.pairedByDeviceId))",
  "\t);",
  "}",
  "async function recoverNemoClawSelfApprovalTransaction(baseDir) {",
  "\tconst journalPath = nemoclawResolveJournalPath(baseDir);",
  "\tconst rawJournal = await readJsonIfExists(journalPath);",
  "\tif (rawJournal === null) return null;",
  "\tconst journal = nemoclawValidateJournal(rawJournal);",
  '\tif (journal.phase === "idle") return "idle";',
  "\tconst current = await nemoclawReadPairingSnapshot(baseDir);",
  '\tif (!nemoclawCurrentMatchesJournal(current, journal)) throw new Error("device pairing state does not match the NemoClaw self-approval journal");',
  '\tawait nemoclawWritePairingSnapshot(journal.phase === "prepared" ? journal.before : journal.after, baseDir);',
  "\tawait writeJson(journalPath, nemoclawIdleJournal(), NEMOCLAW_SELF_APPROVAL_JOURNAL_WRITE_OPTIONS);",
  "\treturn journal.phase;",
  "} // nemoclaw: recover bounded self-approval state transaction (#4462)",
  "async function persistNemoClawSelfApprovalState(state, baseDir, requestId, deviceId, before) {",
  "\tconst journalPath = nemoclawResolveJournalPath(baseDir);",
  "\tconst current = await nemoclawReadPairingSnapshot(baseDir);",
  '\tif (!nemoclawIsSnapshot(before) || !nemoclawStatesEqual(current, before)) throw new Error("device pairing state changed before NemoClaw self-approval publication");',
  "\tconst after = { pendingById: state.pendingById, pairedByDeviceId: state.pairedByDeviceId };",
  "\tconst prepared = nemoclawValidateJournal({",
  "\t\tversion: NEMOCLAW_SELF_APPROVAL_JOURNAL_VERSION,",
  "\t\tkind: NEMOCLAW_SELF_APPROVAL_JOURNAL_KIND,",
  '\t\tphase: "prepared",',
  "\t\trequestId,",
  "\t\tdeviceId,",
  "\t\tbefore,",
  "\t\tafter",
  "\t});",
  "\tawait writeJson(journalPath, prepared, NEMOCLAW_SELF_APPROVAL_JOURNAL_WRITE_OPTIONS);",
  "\ttry {",
  "\t\tawait nemoclawWritePairingSnapshot(after, baseDir);",
  '\t\tawait writeJson(journalPath, { ...prepared, phase: "committed" }, NEMOCLAW_SELF_APPROVAL_JOURNAL_WRITE_OPTIONS);',
  "\t} catch (error) {",
  "\t\ttry {",
  "\t\t\tconst recoveredPhase = await recoverNemoClawSelfApprovalTransaction(baseDir);",
  '\t\t\tif (recoveredPhase === "committed") return;',
  "\t\t} catch (recoveryError) {",
  '\t\t\tthrow new AggregateError([error, recoveryError], "device self-approval publication and rollback both failed");',
  "\t\t}",
  "\t\tthrow error;",
  "\t}",
  "\ttry {",
  "\t\tawait writeJson(journalPath, nemoclawIdleJournal(), NEMOCLAW_SELF_APPROVAL_JOURNAL_WRITE_OPTIONS);",
  "\t} catch {}",
  "}",
  "",
].join("\n");

const STATE_HELPER = [
  'const NEMOCLAW_SELF_APPROVAL_SCOPE_ORDER = ["operator.pairing", "operator.read", "operator.write"];',
  "const NEMOCLAW_SELF_APPROVAL_ALLOWED_SCOPES = new Set(NEMOCLAW_SELF_APPROVAL_SCOPE_ORDER);",
  "function resolveNemoClawSelfApprovalScopes(pending, callerScopes, identity) {",
  '\tif (!identity || !Array.isArray(callerScopes) || !callerScopes.includes("operator.pairing") || pending?.isRepair !== true) return null;',
  '\tconst expectedDeviceId = typeof identity.deviceId === "string" ? identity.deviceId.trim() : "";',
  '\tconst expectedPublicKey = typeof identity.publicKey === "string" ? identity.publicKey.trim() : "";',
  '\tconst expectedRole = typeof identity.role === "string" ? identity.role.trim() : "";',
  '\tconst expectedClientId = typeof identity.clientId === "string" ? identity.clientId.trim() : "";',
  '\tconst expectedClientMode = typeof identity.clientMode === "string" ? identity.clientMode.trim() : "";',
  "\tif (",
  "\t\t!expectedDeviceId ||",
  "\t\t!expectedPublicKey ||",
  '\t\texpectedRole !== "operator" ||',
  '\t\texpectedClientId !== "cli" ||',
  '\t\texpectedClientMode !== "cli" ||',
  '\t\ttypeof pending?.deviceId !== "string" ||',
  "\t\tpending.deviceId.trim() !== expectedDeviceId ||",
  '\t\ttypeof pending.publicKey !== "string" ||',
  "\t\tpending.publicKey.trim() !== expectedPublicKey ||",
  '\t\ttypeof pending.clientId !== "string" ||',
  "\t\tpending.clientId.trim() !== expectedClientId ||",
  '\t\ttypeof pending.clientMode !== "string" ||',
  "\t\tpending.clientMode.trim() !== expectedClientMode ||",
  "\t\tcallerScopes.some((scope) => !NEMOCLAW_SELF_APPROVAL_ALLOWED_SCOPES.has(scope))",
  "\t) return null;",
  "\tconst roles = new Set();",
  "\tif (pending.role !== void 0) {",
  '\t\tif (typeof pending.role !== "string" || !pending.role.trim()) return null;',
  "\t\troles.add(pending.role.trim());",
  "\t}",
  "\tif (pending.roles !== void 0) {",
  "\t\tif (!Array.isArray(pending.roles)) return null;",
  "\t\tfor (const role of pending.roles) {",
  '\t\t\tif (typeof role !== "string" || !role.trim()) return null;',
  "\t\t\troles.add(role.trim());",
  "\t\t}",
  "\t}",
  '\tif (roles.size !== 1 || !roles.has("operator")) return null;',
  "\tif (!Array.isArray(pending.scopes) || pending.scopes.length === 0) return null;",
  "\tconst scopes = new Set();",
  "\tfor (const scope of pending.scopes) {",
  '\t\tif (typeof scope !== "string") return null;',
  "\t\tconst normalized = scope.trim();",
  "\t\tif (!normalized || !NEMOCLAW_SELF_APPROVAL_ALLOWED_SCOPES.has(normalized) || scopes.has(normalized)) return null;",
  "\t\tscopes.add(normalized);",
  "\t}",
  '\tif (scopes.has("operator.write")) scopes.add("operator.read");',
  '\tif (scopes.has("operator.read") || scopes.has("operator.write")) scopes.add("operator.pairing");',
  "\treturn NEMOCLAW_SELF_APPROVAL_SCOPE_ORDER.filter((scope) => scopes.has(scope));",
  "} // nemoclaw: validate bounded self-approval inside pairing lock (#4462)",
  "",
].join("\n");
const STATE_LOAD_TARGET = [
  "async function loadState(baseDir) {",
  '\tconst { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");',
  "\tconst [pending, paired] = await Promise.all([readJsonIfExists(pendingPath), readJsonIfExists(pairedPath)]);",
  "\tconst state = {",
  "\t\tpendingById: coercePairingStateRecord(pending),",
  "\t\tpairedByDeviceId: coercePairingStateRecord(paired)",
  "\t};",
  "\tpruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);",
  "\treturn state;",
  "}",
].join("\n");
const STATE_LOAD_REPLACEMENT = [
  "async function loadState(baseDir) {",
  "\tawait recoverNemoClawSelfApprovalTransaction(baseDir);",
  '\tconst { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");',
  "\tconst [pending, paired] = await Promise.all([readJsonIfExists(pendingPath), readJsonIfExists(pairedPath)]);",
  "\tconst state = {",
  "\t\tpendingById: coercePairingStateRecord(pending),",
  "\t\tpairedByDeviceId: coercePairingStateRecord(paired)",
  "\t};",
  "\tObject.defineProperty(state, NEMOCLAW_SELF_APPROVAL_LOADED_SNAPSHOT, {",
  "\t\tvalue: { pendingById: { ...state.pendingById }, pairedByDeviceId: { ...state.pairedByDeviceId } }",
  "\t});",
  "\tpruneExpiredPending(state.pendingById, Date.now(), PENDING_TTL_MS);",
  "\treturn state;",
  "}",
].join("\n");
const STATE_LIST_TARGET = [
  "async function listDevicePairing(baseDir) {",
  "\tconst state = await loadState(baseDir);",
  "\treturn {",
  "\t\tpending: Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts),",
  "\t\tpaired: Object.values(state.pairedByDeviceId).toSorted((a, b) => b.approvedAtMs - a.approvedAtMs)",
  "\t};",
  "}",
].join("\n");
const STATE_LIST_REPLACEMENT = [
  "async function listDevicePairing(baseDir) {",
  "\treturn await withLock(async () => {",
  "\t\tconst state = await loadState(baseDir);",
  "\t\treturn {",
  "\t\t\tpending: Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts),",
  "\t\t\tpaired: Object.values(state.pairedByDeviceId).toSorted((a, b) => b.approvedAtMs - a.approvedAtMs)",
  "\t\t};",
  "\t});",
  "}",
].join("\n");
const STATE_GET_PAIRED_TARGET = [
  "/** Return one paired device by normalized device id. */",
  "async function getPairedDevice(deviceId, baseDir) {",
  "\treturn (await loadState(baseDir)).pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;",
  "}",
].join("\n");
const STATE_GET_PAIRED_REPLACEMENT = [
  "/** Return one paired device by normalized device id. */",
  "async function getPairedDevice(deviceId, baseDir) {",
  "\treturn await withLock(async () => (await loadState(baseDir)).pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null);",
  "}",
].join("\n");
const STATE_GET_PENDING_TARGET = [
  "/** Return one pending pairing request by request id. */",
  "async function getPendingDevicePairing(requestId, baseDir) {",
  "\treturn (await loadState(baseDir)).pendingById[requestId] ?? null;",
  "}",
].join("\n");
const STATE_GET_PENDING_REPLACEMENT = [
  "/** Return one pending pairing request by request id. */",
  "async function getPendingDevicePairing(requestId, baseDir) {",
  "\treturn await withLock(async () => (await loadState(baseDir)).pendingById[requestId] ?? null);",
  "}",
].join("\n");
const STATE_FUNCTION_ANCHOR =
  "async function approveDevicePairing(requestId, optionsOrBaseDir, maybeBaseDir) {";
const STATE_LOCKED_TARGET = [
  STATE_FUNCTION_ANCHOR,
  '\tconst options = typeof optionsOrBaseDir === "string" || optionsOrBaseDir === void 0 ? void 0 : optionsOrBaseDir;',
  '\tconst baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;',
  "\treturn await withLock(async () => {",
  "\t\tconst state = await loadState(baseDir);",
  "\t\tconst pending = state.pendingById[requestId];",
  "\t\tif (!pending) return null;",
].join("\n");
const STATE_LOCKED_REPLACEMENT = [
  `${STATE_TRANSACTION_HELPER}${STATE_HELPER}${STATE_FUNCTION_ANCHOR}`,
  '\tconst options = typeof optionsOrBaseDir === "string" || optionsOrBaseDir === void 0 ? void 0 : optionsOrBaseDir;',
  '\tconst baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;',
  "\treturn await withLock(async () => {",
  "\t\tconst state = await loadState(baseDir);",
  "\t\tconst pending = state.pendingById[requestId];",
  "\t\tif (!pending) return null;",
  "\t\tconst nemoclawSelfApprovalScopes = resolveNemoClawSelfApprovalScopes(pending, options?.callerScopes, options?.nemoclawSelfApprovalIdentity);",
].join("\n");
const STATE_CALLER_TARGET = [
  "\t\t\t\tif (!options?.callerScopes) return {",
  '\t\t\t\t\tstatus: "forbidden",',
  '\t\t\t\t\treason: "caller-scopes-required",',
  "\t\t\t\t\tscope: callerRequiredScopes[0]",
  "\t\t\t\t};",
  "\t\t\t\tconst missingScope = resolveMissingRequestedScope({",
  "\t\t\t\t\trole: OPERATOR_ROLE,",
  "\t\t\t\t\trequestedScopes: callerRequiredScopes,",
  "\t\t\t\t\tallowedScopes: options.callerScopes",
  "\t\t\t\t});",
].join("\n");
const STATE_CALLER_REPLACEMENT = [
  "\t\t\t\tconst nemoclawEffectiveCallerScopes = nemoclawSelfApprovalScopes ?? options?.callerScopes;",
  "\t\t\t\tif (!nemoclawEffectiveCallerScopes) return {",
  '\t\t\t\t\tstatus: "forbidden",',
  '\t\t\t\t\treason: "caller-scopes-required",',
  "\t\t\t\t\tscope: callerRequiredScopes[0]",
  "\t\t\t\t};",
  "\t\t\t\tconst missingScope = resolveMissingRequestedScope({",
  "\t\t\t\t\trole: OPERATOR_ROLE,",
  "\t\t\t\t\trequestedScopes: callerRequiredScopes,",
  "\t\t\t\t\tallowedScopes: nemoclawEffectiveCallerScopes",
  "\t\t\t\t});",
].join("\n");
const STATE_APPROVAL_PERSIST_TARGET = [
  "\t\tdelete state.pendingById[requestId];",
  "\t\tstate.pairedByDeviceId[device.deviceId] = device;",
  '\t\tawait persistState(state, baseDir, "both");',
  "\t\treturn {",
  '\t\t\tstatus: "approved",',
  "\t\t\trequestId,",
  "\t\t\tdevice",
  "\t\t};",
  "\t});",
  "}",
  "async function approveBootstrapDevicePairing(requestId, bootstrapProfile, optionsOrBaseDir, maybeBaseDir) {",
].join("\n");
const STATE_APPROVAL_PERSIST_REPLACEMENT = [
  "\t\tdelete state.pendingById[requestId];",
  "\t\tstate.pairedByDeviceId[device.deviceId] = device;",
  "\t\tif (nemoclawSelfApprovalScopes) await persistNemoClawSelfApprovalState(state, baseDir, requestId, device.deviceId, state[NEMOCLAW_SELF_APPROVAL_LOADED_SNAPSHOT]);",
  '\t\telse await persistState(state, baseDir, "both");',
  "\t\treturn {",
  '\t\t\tstatus: "approved",',
  "\t\t\trequestId,",
  "\t\t\tdevice",
  "\t\t};",
  "\t});",
  "}",
  "async function approveBootstrapDevicePairing(requestId, bootstrapProfile, optionsOrBaseDir, maybeBaseDir) {",
].join("\n");

const FILE_SPECS: FileSpec[] = [
  {
    id: "devices-cli",
    label: "devices CLI approval runtime",
    marker: CLI_MARKER,
    selector(source) {
      return (
        source.includes("async function approvePairingWithFallback(opts, requestId)") &&
        source.includes("function resolveApprovePairingScopesForRequest(request, paired)") &&
        source.includes('callGatewayCli("device.pair.approve"') &&
        CLI_SELECTOR_DEPENDENCIES.every((dependency) => source.includes(dependency))
      );
    },
    patch(source, file) {
      const appliedMarkerCounts = CLI_APPLIED_MARKERS.map((marker) =>
        countOccurrences(source, marker),
      );
      if (appliedMarkerCounts.some((count) => count > 0)) {
        if (appliedMarkerCounts.every((count) => count === 1)) {
          return { source, status: "already-applied" };
        }
        return {
          source,
          status: "no-match",
          error: `devices CLI approval runtime in ${file}: partial or duplicate patch markers (${appliedMarkerCounts.join(", ")})`,
        };
      }
      let result = replaceExactlyOnce(
        source,
        CLI_HELPER_ANCHOR,
        `${CLI_HELPER}${CLI_HELPER_ANCHOR}`,
        "bounded devices CLI classifier anchor",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        CLI_TARGET,
        CLI_REPLACEMENT,
        "bounded devices CLI scope-selection target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        CLI_CALL_GATEWAY_TARGET,
        CLI_CALL_GATEWAY_REPLACEMENT,
        "devices CLI gateway-call forwarding target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        CLI_LIST_SIGNATURE_TARGET,
        CLI_LIST_SIGNATURE_REPLACEMENT,
        "devices CLI bounded pairing-list signature target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        CLI_LIST_CALL_TARGET,
        CLI_LIST_CALL_REPLACEMENT,
        "devices CLI bounded pairing-list call target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        CLI_CONTEXT_TARGET,
        CLI_CONTEXT_REPLACEMENT,
        "devices CLI pairing-context target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        CLI_APPROVE_HEADER_TARGET,
        CLI_APPROVE_HEADER_REPLACEMENT,
        "devices CLI approval-context target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        CLI_APPROVE_CALL_TARGET,
        CLI_APPROVE_CALL_REPLACEMENT,
        "devices CLI stored-auth selection target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        CLI_ADMIN_RETRY_TARGET,
        CLI_ADMIN_RETRY_REPLACEMENT,
        "devices CLI stored-auth fail-closed retry target",
        file,
      );
      return result.error
        ? { source, status: "no-match", error: result.error }
        : { source: result.source, status: "would-apply" };
    },
  },
  {
    id: "gateway-handler",
    label: "device pairing gateway handler",
    marker: HANDLER_MARKER,
    selector(source) {
      return (
        source.includes('"device.pair.approve": async') &&
        source.includes("resolveDeviceSessionAuthz(client)") &&
        source.includes("approveDevicePairing(requestId") &&
        source.includes(HANDLER_HELPER_ANCHOR)
      );
    },
    patch(source, file) {
      if (source.includes(HANDLER_MARKER)) return { source, status: "already-applied" };
      let result = replaceExactlyOnce(
        source,
        HANDLER_HELPER_ANCHOR,
        `${HANDLER_HELPER}${HANDLER_HELPER_ANCHOR}`,
        "gateway helper anchor",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        HANDLER_AUTHZ_TARGET,
        HANDLER_AUTHZ_REPLACEMENT,
        "gateway authz target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        HANDLER_ROLE_TARGET,
        HANDLER_ROLE_REPLACEMENT,
        "gateway role-validation target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        HANDLER_APPROVE_TARGET,
        HANDLER_APPROVE_REPLACEMENT,
        "gateway canonical approval target",
        file,
      );
      return result.error
        ? { source, status: "no-match", error: result.error }
        : { source: result.source, status: "would-apply" };
    },
  },
  {
    id: "pairing-state",
    label: "canonical device pairing state runtime",
    marker: STATE_MARKER,
    selector(source) {
      return (
        source.includes(STATE_FUNCTION_ANCHOR) &&
        source.includes("const withLock = createAsyncLock();") &&
        source.includes('await persistState(state, baseDir, "both")')
      );
    },
    patch(source, file) {
      const appliedMarkerCounts = STATE_APPLIED_MARKERS.map((marker) =>
        countOccurrences(source, marker),
      );
      if (appliedMarkerCounts.some((count) => count > 0)) {
        if (appliedMarkerCounts.every((count) => count === 1)) {
          return { source, status: "already-applied" };
        }
        return {
          source,
          status: "no-match",
          error: `canonical device pairing state runtime in ${file}: partial or duplicate patch markers (${appliedMarkerCounts.join(", ")})`,
        };
      }
      let result = replaceExactlyOnce(
        source,
        STATE_LOAD_TARGET,
        STATE_LOAD_REPLACEMENT,
        "canonical pairing recovery-load target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        STATE_LIST_TARGET,
        STATE_LIST_REPLACEMENT,
        "canonical pairing list lock target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        STATE_GET_PAIRED_TARGET,
        STATE_GET_PAIRED_REPLACEMENT,
        "canonical paired-device reader lock target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        STATE_GET_PENDING_TARGET,
        STATE_GET_PENDING_REPLACEMENT,
        "canonical pending-device reader lock target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        STATE_LOCKED_TARGET,
        STATE_LOCKED_REPLACEMENT,
        "canonical pairing locked-state target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        STATE_CALLER_TARGET,
        STATE_CALLER_REPLACEMENT,
        "canonical pairing caller-scope target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        STATE_APPROVAL_PERSIST_TARGET,
        STATE_APPROVAL_PERSIST_REPLACEMENT,
        "canonical pairing bounded self-approval persistence target",
        file,
      );
      return result.error
        ? { source, status: "no-match", error: result.error }
        : { source: result.source, status: "would-apply" };
    },
  },
];

function resolveSpecFile(spec: FileSpec, dryRun: boolean): ResolvedSpecFile {
  const candidates = listJsFiles(distDir).filter((file) =>
    spec.selector(fs.readFileSync(file, "utf8")),
  );
  if (candidates.length !== 1) {
    const error = `expected exactly one OpenClaw ${spec.label} file, found ${candidates.length}`;
    if (!dryRun) fail(error);
    return { file: null, error };
  }
  return { file: candidates[0] };
}

function processSpec(spec: FileSpec, file: string, dryRun: boolean): PatchResult {
  const source = fs.readFileSync(file, "utf8");
  const result = spec.patch(source, file);
  if (result.status === "no-match") {
    if (!dryRun) fail(result.error ?? `${spec.label} shape not recognized`);
    return result;
  }
  if (!dryRun && result.source !== source) fs.writeFileSync(file, result.source);
  if (!dryRun) {
    const written = fs.readFileSync(file, "utf8");
    if (countOccurrences(written, spec.marker) !== 1) {
      fail(`${spec.label}: expected exactly one patch marker after apply`);
    }
  }
  return result;
}

function runApplyMode(): void {
  for (const spec of FILE_SPECS) {
    const { file, error } = resolveSpecFile(spec, false);
    if (!file) fail(error ?? `${spec.label} file unresolved`);
    processSpec(spec, file, false);
  }
  console.log("INFO: patched OpenClaw bounded device self-approval");
}

function runAuditMode(): void {
  console.log(`patch-openclaw-device-self-approval audit: ${distDir}`);
  let failures = 0;
  for (const spec of FILE_SPECS) {
    const { file, error } = resolveSpecFile(spec, true);
    if (!file) {
      failures += 1;
      console.log(`${spec.label}: NOT FOUND`);
      console.log(`  [MISS] ${error}`);
      continue;
    }
    const result = processSpec(spec, file, true);
    console.log(`${spec.label}: ${path.basename(file)}`);
    console.log(
      `  ${result.status === "no-match" ? "[MISS]" : "[OK]  "} ${spec.id}: ${result.error ?? result.status}`,
    );
    if (result.status === "no-match") failures += 1;
  }
  console.log(`Summary: ${FILE_SPECS.length - failures} OK · ${failures} missing`);
  if (failures > 0) process.exit(EXIT_AUDIT_FAILURE);
}

if (auditMode) runAuditMode();
else runApplyMode();
