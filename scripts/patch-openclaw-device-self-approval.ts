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
 * scope approval through the gateway using the already-approved pairing scope.
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
const CLI_APPLIED_MARKERS = [
  CLI_MARKER,
  CLI_APPROVE_MARKER,
  CLI_SCOPE_MARKER,
  CLI_RETRY_MARKER,
] as const;
const HANDLER_MARKER = "nemoclaw: bounded same-device scope approval";
const STATE_MARKER = "nemoclaw: validate bounded self-approval inside pairing lock";
const CLI_SELECTOR_DEPENDENCIES = [
  "normalizeDeviceRoles",
  "resolvePairedOperatorScopes",
  "GATEWAY_CLIENT_NAMES",
  "GATEWAY_CLIENT_MODES",
  "OPERATOR_ROLE",
  "PAIRING_SCOPE",
  "normalizeOptionalString",
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
  "\ttry {",
  "\t\tconst list = await listPairingWithFallback(opts);",
  "\t\tconst request = findPendingRequestById(list.pending, requestId);",
  "\t\tif (!request) return {",
  "\t\t\toriginalRequest: null,",
  "\t\t\tscopes: void 0,",
  "\t\t\tnemoclawUseStoredDeviceAuth: false",
  "\t\t};",
  "\t\tconst paired = lookupPairedDevice(indexPairedDevices(list.paired), request);",
  "\t\tconst nemoclawSelfRepairContext = resolveNemoClawSelfRepairPairingContext(request, paired);",
  "\t\treturn {",
  "\t\t\toriginalRequest: request,",
  "\t\t\tscopes: resolveApprovePairingScopesForRequest(request, paired),",
  "\t\t\tnemoclawUseStoredDeviceAuth: nemoclawSelfRepairContext.useStoredDeviceAuth",
  "\t\t};",
  "\t} catch {",
  "\t\treturn {",
  "\t\t\toriginalRequest: null,",
  "\t\t\tscopes: void 0,",
  "\t\t\tnemoclawUseStoredDeviceAuth: false",
  "\t\t};",
  "\t}",
  "}",
].join("\n");

const CLI_APPROVE_HEADER_TARGET =
  "\tconst { scopes, originalRequest } = await resolveApprovePairingGatewayContext(opts, requestId);";
const CLI_APPROVE_HEADER_REPLACEMENT =
  "\tconst { scopes, originalRequest, nemoclawUseStoredDeviceAuth } = await resolveApprovePairingGatewayContext(opts, requestId);";
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
  `${STATE_HELPER}${STATE_FUNCTION_ANCHOR}`,
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
      if (source.includes(STATE_MARKER)) return { source, status: "already-applied" };
      let result = replaceExactlyOnce(
        source,
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
