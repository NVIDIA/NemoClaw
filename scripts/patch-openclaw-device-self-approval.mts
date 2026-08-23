// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * Temporary compatibility patch for OpenClaw 2026.6.10 through 2026.7.1 device
 * scope upgrades.
 *
 * The devices CLI asks for the scopes it is trying to approve. A device that
 * currently has only operator.pairing is therefore rejected by the gateway
 * handshake before device.pair.approve can run. OpenClaw 2026.7.1 also rejects
 * that valid device token during authentication, before its canonical pairing
 * path can create the scope-upgrade request. Its operator.admin retry fails the
 * same way, after which NemoClaw historically repaired the two JSON state files
 * directly. OpenClaw 2026.7.1 also omits CLI identity for loopback shared-token
 * calls. Preserve that identity whenever a stored operator device credential
 * exists, while retaining the upstream omission during bootstrap and for the
 * local backend. The shared token may authenticate the connection, but the
 * signed identity keeps the paired-device scope check authoritative and lets
 * OpenClaw create a canonical pending scope-upgrade request. Keep the entire
 * approval in OpenClaw instead: for the exact bounded CLI mismatch, continue
 * only into OpenClaw's pairing gate. For the resulting same-device scope
 * transition, use OpenClaw's stored device credential with operator.pairing.
 * NemoClaw's settlement list uses the same pairing-only stored credential so
 * it can observe that transition without a shared gateway credential.
 * A restored clone whose paired server state exists before its client-auth
 * store converges instead opts into one narrower path: its pairing state and
 * signed identity are loaded only from inherited clone-file descriptors, the
 * exact pairing-only device token is forwarded in memory to the pinned
 * loopback gateway, and a direct live pairing list must exactly match that
 * descriptor-backed preflight before one canonical approval can run. Then let
 * the gateway's canonical approveDevicePairing path reload, lock, rotate the
 * token, persist, broadcast, and respond.
 * The ordinary patch tests and pinned real-dist proof cover this paired
 * pre-convergence transition separately from a cold clone, which has no paired
 * record and must not select stored device authentication.
 *
 * Remove this patch when upstream OpenClaw supports same-device, operator-only
 * scope approval through the gateway using the already-approved pairing scope
 * and publishes the pending/paired transition atomically or with equivalent
 * durable restart recovery.
 */

import fs from "node:fs";
import path from "node:path";

const AUDIT_FLAG = "--audit";
const EXIT_APPLY_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_AUDIT_FAILURE = 3;
const CLI_MARKER = "nemoclaw: forward stored device auth for bounded same-device scope approval";
const CLI_APPROVE_MARKER =
  "nemoclaw: select stored device auth for bounded same-device scope approval";
const CLI_SCOPE_MARKER = "nemoclaw: reach gateway for bounded same-device scope approval";
const CLI_RETRY_MARKER = "nemoclaw: keep bounded device auth fail closed";
const CLI_LIST_MARKER = "nemoclaw: preflight bounded stored device auth before live pairing list";
const CLI_SETTLEMENT_LIST_MARKER = "nemoclaw: use stored device auth for pairing settlement list";
const CLI_PAIRED_TOKEN_MARKER = "nemoclaw: preflight bounded paired token before live pairing list";
const CALL_FORCE_IDENTITY_MARKER = "nemoclaw: force device identity for loopback pairing bootstrap";
const CALL_STORED_IDENTITY_MARKER =
  "nemoclaw: retain stored CLI device identity for loopback shared-token scope enforcement";
const CALL_EXPECTED_IDENTITY_MARKER =
  "nemoclaw: require the pinned clone identity for forced pairing";
const CALL_DISABLE_STORED_AUTH_MARKER =
  "nemoclaw: disable pathname-backed device auth for forced pairing";
const DEVICE_IDENTITY_FD_MARKER =
  "nemoclaw: load the forced clone identity from its inherited descriptor";
const CLI_APPLIED_MARKERS = [
  CLI_MARKER,
  CLI_APPROVE_MARKER,
  CLI_SCOPE_MARKER,
  CLI_RETRY_MARKER,
  CLI_LIST_MARKER,
  CLI_SETTLEMENT_LIST_MARKER,
  CLI_PAIRED_TOKEN_MARKER,
] as const;
const AUTH_SCOPE_UPGRADE_MARKER =
  "nemoclaw: route bounded CLI device-token scope upgrade into pairing";
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

const CALL_OMIT_IDENTITY_TARGET = [
  "function shouldOmitDeviceIdentityForGatewayCall(params) {",
  "\tconst mode = params.opts.mode ?? GATEWAY_CLIENT_MODES.CLI;",
].join("\n");
const CALL_OMIT_IDENTITY_LEGACY_FORCE_LINE = `\tif (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1") return false; // ${CALL_FORCE_IDENTITY_MARKER} (#4462)`;
const CALL_OMIT_IDENTITY_MODE_LINE = `\tif (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1" || process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1") return false; // ${CALL_FORCE_IDENTITY_MARKER} (#4462)`;
const CALL_OMIT_IDENTITY_REPLACEMENT = [
  "function shouldOmitDeviceIdentityForGatewayCall(params) {",
  CALL_OMIT_IDENTITY_MODE_LINE,
  "\tconst mode = params.opts.mode ?? GATEWAY_CLIENT_MODES.CLI;",
].join("\n");
const CALL_STORED_IDENTITY_TARGET =
  "\tconst isLocalCliSharedAuth = mode === GATEWAY_CLIENT_MODES.CLI && clientName === GATEWAY_CLIENT_NAMES.CLI && hasSharedSecretAuth && isLoopback;";
const CALL_STORED_IDENTITY_REPLACEMENT = [
  "\tconst isLocalCliSharedAuth =",
  "\t\tmode === GATEWAY_CLIENT_MODES.CLI &&",
  "\t\tclientName === GATEWAY_CLIENT_NAMES.CLI &&",
  "\t\thasSharedSecretAuth &&",
  "\t\tisLoopback &&",
  `\t\t!hasStoredOperatorDeviceAuthToken(resolveDeviceIdentityForGatewayCall()); // ${CALL_STORED_IDENTITY_MARKER} (#4462)`,
].join("\n");
const CALL_IDENTITY_RESOLVER_TARGET = [
  "function resolveDeviceIdentityForGatewayCall() {",
  "\ttry {",
  "\t\treturn gatewayCallDeps.loadOrCreateDeviceIdentity();",
  "\t} catch {",
  "\t\treturn null;",
  "\t}",
  "}",
].join("\n");
const CALL_IDENTITY_RESOLVER_LEGACY_FORCE_LINE =
  '\tif (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1") {';
const CALL_IDENTITY_RESOLVER_MODE_LINE =
  '\tif (process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1") {';
const CALL_IDENTITY_RESOLVER_REPLACEMENT = [
  "function resolveDeviceIdentityForGatewayCall() {",
  CALL_IDENTITY_RESOLVER_MODE_LINE,
  "\t\tconst nemoclawExpectedDeviceId = normalizeOptionalString(process.env.NEMOCLAW_OPENCLAW_EXPECTED_DEVICE_ID);",
  '\t\tif (!nemoclawExpectedDeviceId) throw new Error("forced pairing expected device identity is unavailable");',
  "\t\tlet nemoclawDeviceIdentity;",
  "\t\ttry {",
  "\t\t\tnemoclawDeviceIdentity = gatewayCallDeps.loadOrCreateDeviceIdentity();",
  "\t\t} catch {",
  '\t\t\tthrow new Error("forced pairing device identity is unavailable");',
  "\t\t}",
  `\t\tif (nemoclawDeviceIdentity?.deviceId !== nemoclawExpectedDeviceId) throw new Error("forced pairing device identity does not match the clone"); // ${CALL_EXPECTED_IDENTITY_MARKER} (#4462)`,
  "\t\treturn nemoclawDeviceIdentity;",
  "\t}",
  "\ttry {",
  "\t\treturn gatewayCallDeps.loadOrCreateDeviceIdentity();",
  "\t} catch {",
  "\t\treturn null;",
  "\t}",
  "}",
].join("\n");
const CALL_DISABLE_STORED_AUTH_TARGET = [
  "\t\t\tdeviceIdentity,",
  "\t\t\tminProtocol: opts.minProtocol ?? 4,",
].join("\n");
const CALL_DISABLE_STORED_AUTH_REPLACEMENT = [
  "\t\t\tdeviceIdentity,",
  "\t\t\t...(opts.nemoclawDisableStoredDeviceAuth === true ? {",
  "\t\t\t\thostDeps: {",
  "\t\t\t\t\tloadDeviceAuthToken: () => null,",
  "\t\t\t\t\tstoreDeviceAuthToken: () => {},",
  "\t\t\t\t\tclearDeviceAuthToken: () => {}",
  "\t\t\t\t}",
  `\t\t\t} : {}), // ${CALL_DISABLE_STORED_AUTH_MARKER} (#4462)`,
  "\t\t\tminProtocol: opts.minProtocol ?? 4,",
].join("\n");

const DEVICE_IDENTITY_LOAD_TARGET = [
  "function loadOrCreateDeviceIdentity(filePath = resolveDefaultIdentityPath()) {",
  "\ttry {",
].join("\n");
const DEVICE_IDENTITY_LOAD_LEGACY_FORCE_LINE =
  '\tif (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1") return loadNemoClawForcedDeviceIdentity();';
const DEVICE_IDENTITY_LOAD_MODE_LINE =
  '\tif (process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1") return loadNemoClawForcedDeviceIdentity();';
const DEVICE_IDENTITY_LOAD_REPLACEMENT = [
  "function resolveNemoClawCanonicalIdentityDescriptor() {",
  "\tconst nemoclawRawDescriptor = process.env.NEMOCLAW_OPENCLAW_IDENTITY_FD;",
  '\tif (typeof nemoclawRawDescriptor !== "string" || !/^[1-9]\\d*$/.test(nemoclawRawDescriptor)) return null;',
  "\tconst nemoclawDescriptor = Number(nemoclawRawDescriptor);",
  "\treturn Number.isSafeInteger(nemoclawDescriptor) && nemoclawDescriptor >= 3 && nemoclawDescriptor <= 2147483647 && String(nemoclawDescriptor) === nemoclawRawDescriptor ? nemoclawDescriptor : null;",
  "}",
  "function loadNemoClawForcedDeviceIdentity() {",
  "\tconst nemoclawDescriptor = resolveNemoClawCanonicalIdentityDescriptor();",
  '\tif (nemoclawDescriptor === null) throw new Error("forced pairing identity descriptor is unavailable");',
  "\tlet nemoclawParsedIdentity;",
  "\ttry {",
  "\t\tconst nemoclawBefore = fs.fstatSync(nemoclawDescriptor);",
  "\t\tif (!nemoclawBefore.isFile() || nemoclawBefore.nlink !== 1 || !Number.isSafeInteger(nemoclawBefore.size) || nemoclawBefore.size < 2 || nemoclawBefore.size > 1048576) throw new Error();",
  "\t\tconst nemoclawBuffer = Buffer.alloc(nemoclawBefore.size);",
  "\t\tlet nemoclawOffset = 0;",
  "\t\twhile (nemoclawOffset < nemoclawBuffer.length) {",
  "\t\t\tconst nemoclawRead = fs.readSync(nemoclawDescriptor, nemoclawBuffer, nemoclawOffset, nemoclawBuffer.length - nemoclawOffset, nemoclawOffset);",
  "\t\t\tif (nemoclawRead <= 0) throw new Error();",
  "\t\t\tnemoclawOffset += nemoclawRead;",
  "\t\t}",
  "\t\tconst nemoclawAfter = fs.fstatSync(nemoclawDescriptor);",
  "\t\tif (!nemoclawAfter.isFile() || nemoclawAfter.nlink !== 1 || nemoclawAfter.dev !== nemoclawBefore.dev || nemoclawAfter.ino !== nemoclawBefore.ino || nemoclawAfter.size !== nemoclawBefore.size || nemoclawAfter.mtimeMs !== nemoclawBefore.mtimeMs) throw new Error();",
  '\t\tnemoclawParsedIdentity = JSON.parse(nemoclawBuffer.toString("utf8"));',
  "\t} catch {",
  '\t\tthrow new Error("forced pairing identity descriptor is invalid");',
  "\t}",
  "\tconst nemoclawNormalizedIdentity = normalizeStoredIdentity(nemoclawParsedIdentity);",
  '\tif (nemoclawNormalizedIdentity?.kind !== "identity" || nemoclawNormalizedIdentity.validForReadOnly !== true) throw new Error("forced pairing identity descriptor is invalid");',
  `\treturn nemoclawNormalizedIdentity.identity; // ${DEVICE_IDENTITY_FD_MARKER} (#4462)`,
  "}",
  "function loadOrCreateDeviceIdentity(filePath) {",
  DEVICE_IDENTITY_LOAD_MODE_LINE,
  "\tif (filePath === void 0) filePath = resolveDefaultIdentityPath();",
  "\ttry {",
].join("\n");

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
  console.error("Usage: patch-openclaw-device-self-approval.mts [--audit] <openclaw-dist-dir>");
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
  "function resolveNemoClawCanonicalPairingDescriptor(name) {",
  "\tconst nemoclawRawDescriptor = process.env[name];",
  '\tif (typeof nemoclawRawDescriptor !== "string" || !/^[1-9]\\d*$/.test(nemoclawRawDescriptor)) return null;',
  "\tconst nemoclawDescriptor = Number(nemoclawRawDescriptor);",
  "\treturn Number.isSafeInteger(nemoclawDescriptor) && nemoclawDescriptor >= 3 && nemoclawDescriptor <= 2147483647 && String(nemoclawDescriptor) === nemoclawRawDescriptor ? nemoclawDescriptor : null;",
  "}",
  "",
  "function readNemoClawPairingRecordFromDescriptor(name) {",
  "\tconst nemoclawDescriptor = resolveNemoClawCanonicalPairingDescriptor(name);",
  '\tif (nemoclawDescriptor === null) throw new Error("forced pairing state descriptor is unavailable");',
  "\tlet nemoclawRecord;",
  "\ttry {",
  '\t\tconst nemoclawFs = process.getBuiltinModule("node:fs");',
  "\t\tconst nemoclawBefore = nemoclawFs.fstatSync(nemoclawDescriptor);",
  "\t\tif (!nemoclawBefore.isFile() || nemoclawBefore.nlink !== 1 || !Number.isSafeInteger(nemoclawBefore.size) || nemoclawBefore.size < 2 || nemoclawBefore.size > 1048576) throw new Error();",
  "\t\tconst nemoclawBuffer = Buffer.alloc(nemoclawBefore.size);",
  "\t\tlet nemoclawOffset = 0;",
  "\t\twhile (nemoclawOffset < nemoclawBuffer.length) {",
  "\t\t\tconst nemoclawRead = nemoclawFs.readSync(nemoclawDescriptor, nemoclawBuffer, nemoclawOffset, nemoclawBuffer.length - nemoclawOffset, nemoclawOffset);",
  "\t\t\tif (nemoclawRead <= 0) throw new Error();",
  "\t\t\tnemoclawOffset += nemoclawRead;",
  "\t\t}",
  "\t\tconst nemoclawAfter = nemoclawFs.fstatSync(nemoclawDescriptor);",
  "\t\tif (!nemoclawAfter.isFile() || nemoclawAfter.nlink !== 1 || nemoclawAfter.dev !== nemoclawBefore.dev || nemoclawAfter.ino !== nemoclawBefore.ino || nemoclawAfter.size !== nemoclawBefore.size || nemoclawAfter.mtimeMs !== nemoclawBefore.mtimeMs) throw new Error();",
  '\t\tnemoclawRecord = JSON.parse(nemoclawBuffer.toString("utf8"));',
  "\t} catch {",
  '\t\tthrow new Error("forced pairing state descriptor is invalid");',
  "\t}",
  '\tif (!nemoclawRecord || typeof nemoclawRecord !== "object" || Array.isArray(nemoclawRecord) || Object.values(nemoclawRecord).some((value) => !value || typeof value !== "object" || Array.isArray(value))) throw new Error("forced pairing state descriptor is invalid");',
  "\treturn nemoclawRecord;",
  "}",
  "",
  "function readNemoClawPinnedPairingSnapshot() {",
  '\tconst nemoclawPending = readNemoClawPairingRecordFromDescriptor("NEMOCLAW_OPENCLAW_PENDING_FD");',
  '\tconst nemoclawPaired = readNemoClawPairingRecordFromDescriptor("NEMOCLAW_OPENCLAW_PAIRED_FD");',
  "\treturn {",
  "\t\tpending: Object.values(nemoclawPending),",
  "\t\tpaired: Object.values(nemoclawPaired)",
  "\t};",
  "}",
  "",
  "function resolveNemoClawPinnedGatewayUrl() {",
  "\tconst nemoclawPinnedUrl = process.env.NEMOCLAW_OPENCLAW_PINNED_GATEWAY_URL;",
  "\tconst nemoclawGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;",
  '\tif (typeof nemoclawPinnedUrl !== "string" || nemoclawPinnedUrl !== nemoclawGatewayUrl || normalizeOptionalString(nemoclawPinnedUrl) !== nemoclawPinnedUrl) return;',
  "\ttry {",
  "\t\tconst nemoclawUrl = new URL(nemoclawPinnedUrl);",
  "\t\tconst nemoclawHostname = nemoclawUrl.hostname.toLowerCase();",
  '\t\tconst nemoclawStrictLoopback = nemoclawHostname === "127.0.0.1" || nemoclawHostname === "[::1]" || nemoclawHostname === "::1";',
  '\t\tif (nemoclawUrl.protocol !== "ws:" || !nemoclawStrictLoopback || !nemoclawUrl.port || nemoclawUrl.username || nemoclawUrl.password || nemoclawUrl.pathname !== "/" || nemoclawUrl.search || nemoclawUrl.hash) return;',
  "\t\treturn nemoclawPinnedUrl;",
  "\t} catch {}",
  "}",
  "",
  "function resolveNemoClawExactScopes(rawScopes) {",
  "\tif (!Array.isArray(rawScopes) || rawScopes.length === 0) return null;",
  '\tconst normalized = rawScopes.map((scope) => typeof scope === "string" ? scope.trim() : "");',
  "\tif (normalized.some((scope) => !scope) || normalized.length !== new Set(normalized).size) return null;",
  "\treturn normalized.toSorted();",
  "}",
  "",
  "function resolveNemoClawSelfRepairPairingContext(request, paired, nemoclawAllowRedactedPaired = false) {",
  "\tconst nemoclawRawScopes = request.scopes;",
  "\tconst nemoclawRoles = normalizeDeviceRoles(request);",
  "\tconst nemoclawPairedTokens = paired?.tokens;",
  '\tconst nemoclawPairedView = nemoclawPairedTokens && typeof nemoclawPairedTokens === "object" && !Array.isArray(nemoclawPairedTokens) ? { ...paired, tokens: Object.values(nemoclawPairedTokens) } : paired;',
  "\tconst nemoclawPairedTokenList = Array.isArray(nemoclawPairedView?.tokens) ? nemoclawPairedView.tokens : [];",
  '\tconst nemoclawPairedOperatorTokens = nemoclawPairedTokenList.filter((token) => token && typeof token === "object" && normalizeOptionalString(token.role) === OPERATOR_ROLE && !token.revokedAtMs);',
  "\tconst nemoclawPairedOperatorToken = nemoclawPairedOperatorTokens.length === 1 && nemoclawPairedTokenList.length === 1 ? nemoclawPairedOperatorTokens[0] : null;",
  "\tconst nemoclawPairedScopes = resolvePairedOperatorScopes(nemoclawPairedView);",
  "\tconst nemoclawPairingBaselineVisible = nemoclawPairedScopes.length > 0;",
  "\tconst nemoclawNormalizedRawScopes = resolveNemoClawExactScopes(nemoclawRawScopes) ?? [];",
  "\tconst nemoclawNonRepairWriteTransition =",
  "\t\trequest.isRepair === false &&",
  '\t\tnemoclawNormalizedRawScopes.includes("operator.write") &&',
  "\t\tnemoclawPairedScopes.includes(PAIRING_SCOPE);",
  "\tconst nemoclawUsePairingTransport =",
  "\t\tArray.isArray(nemoclawRawScopes) &&",
  "\t\tnemoclawRawScopes.length > 0 &&",
  '\t\tnemoclawRawScopes.every((scope) => typeof scope === "string" && scope.trim() && isKnownNonAdminOperatorScope(scope.trim())) &&',
  "\t\trequest.clientId === GATEWAY_CLIENT_NAMES.CLI &&",
  "\t\trequest.clientMode === GATEWAY_CLIENT_MODES.CLI &&",
  "\t\t(request.isRepair === true || nemoclawNonRepairWriteTransition) &&",
  "\t\tnemoclawRoles.length === 1 &&",
  "\t\tnemoclawRoles[0] === OPERATOR_ROLE &&",
  "\t\t(!nemoclawPairingBaselineVisible || nemoclawPairedScopes.includes(PAIRING_SCOPE));",
  '\tconst nemoclawStoredAuthAllowedScopes = new Set([PAIRING_SCOPE, "operator.read", "operator.write"]);',
  "\tconst nemoclawRequestDeviceId = normalizeOptionalString(request.deviceId);",
  "\tconst nemoclawPairedDeviceId = normalizeOptionalString(nemoclawPairedView?.deviceId);",
  "\tconst nemoclawRequestPublicKey = normalizeOptionalString(request.publicKey);",
  "\tconst nemoclawPairedPublicKey = normalizeOptionalString(nemoclawPairedView?.publicKey);",
  "\tconst nemoclawPairedRoles = normalizeDeviceRoles(nemoclawPairedView ?? {});",
  "\tconst nemoclawPairedRawScopes = resolveNemoClawExactScopes(nemoclawPairedView?.scopes);",
  "\tconst nemoclawPairedApprovedScopes = resolveNemoClawExactScopes(nemoclawPairedView?.approvedScopes);",
  "\tconst nemoclawPairedTokenScopes = resolveNemoClawExactScopes(nemoclawPairedOperatorToken?.scopes);",
  "\tconst nemoclawRequestId = normalizeOptionalString(request.requestId);",
  "\tconst nemoclawPairedApprovedScopesMatch =",
  "\t\t(nemoclawPairedApprovedScopes?.length === 1 && nemoclawPairedApprovedScopes[0] === PAIRING_SCOPE) ||",
  "\t\t(nemoclawAllowRedactedPaired && nemoclawPairedView?.approvedScopes === void 0);",
  "\tconst nemoclawPairedTokenScopeUpgrade =",
  "\t\t(request.isRepair === true || request.isRepair === false) &&",
  '\t\tnemoclawNormalizedRawScopes.includes("operator.write") &&',
  "\t\tnemoclawNormalizedRawScopes.every((scope) => nemoclawStoredAuthAllowedScopes.has(scope)) &&",
  "\t\tnemoclawRoles.length === 1 &&",
  "\t\tnemoclawRoles[0] === OPERATOR_ROLE &&",
  "\t\tnemoclawPairedRoles.length === 1 &&",
  "\t\tnemoclawPairedRoles[0] === OPERATOR_ROLE &&",
  "\t\tnemoclawPairedRawScopes?.length === 1 &&",
  "\t\tnemoclawPairedRawScopes[0] === PAIRING_SCOPE &&",
  "\t\tnemoclawPairedApprovedScopesMatch &&",
  "\t\tnemoclawPairedTokenScopes?.length === 1 &&",
  "\t\tnemoclawPairedTokenScopes[0] === PAIRING_SCOPE &&",
  "\t\tBoolean(nemoclawRequestId) &&",
  "\t\tBoolean(nemoclawRequestDeviceId) &&",
  "\t\tnemoclawRequestDeviceId === nemoclawPairedDeviceId &&",
  "\t\tBoolean(nemoclawRequestPublicKey) &&",
  "\t\tnemoclawRequestPublicKey === nemoclawPairedPublicKey &&",
  "\t\trequest.clientId === GATEWAY_CLIENT_NAMES.CLI &&",
  "\t\trequest.clientMode === GATEWAY_CLIENT_MODES.CLI;",
  "\tconst nemoclawPairedTokenContext = nemoclawPairedTokenScopeUpgrade ? JSON.stringify([",
  "\t\tnemoclawRequestId,",
  "\t\tnemoclawRequestDeviceId,",
  "\t\tnemoclawRequestPublicKey,",
  "\t\trequest.clientId,",
  "\t\trequest.clientMode,",
  "\t\tnemoclawRoles,",
  "\t\tnemoclawNormalizedRawScopes,",
  "\t\tnemoclawPairedRoles,",
  "\t\tnemoclawPairedRawScopes,",
  "\t\tnemoclawPairedTokenScopes",
  "\t]) : null;",
  "\treturn {",
  "\t\tusePairingTransport: nemoclawUsePairingTransport,",
  "\t\tuseStoredDeviceAuth:",
  "\t\t\tnemoclawUsePairingTransport &&",
  "\t\t\tnemoclawNormalizedRawScopes.length > 0 &&",
  "\t\t\tnemoclawNormalizedRawScopes.length === new Set(nemoclawNormalizedRawScopes).size &&",
  "\t\t\tnemoclawNormalizedRawScopes.every((scope) => nemoclawStoredAuthAllowedScopes.has(scope)) &&",
  "\t\t\tnemoclawPairedScopes.includes(PAIRING_SCOPE) &&",
  "\t\t\tBoolean(nemoclawRequestDeviceId) &&",
  "\t\t\tnemoclawRequestDeviceId === nemoclawPairedDeviceId &&",
  "\t\t\tBoolean(nemoclawRequestPublicKey) &&",
  "\t\t\tnemoclawRequestPublicKey === nemoclawPairedPublicKey,",
  "\t\tpairedTokenContext: nemoclawPairedTokenContext,",
  "\t\tpairedDeviceToken: nemoclawPairedTokenContext ? normalizeOptionalString(nemoclawPairedOperatorToken?.token) : void 0",
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
  "\t...(callOpts?.usePairedToken === true ? {",
  "\t\turl: callOpts.pinnedGatewayUrl,",
  "\t\ttoken: callOpts.pairedToken,",
  "\t\tpassword: void 0,",
  "\t\tnemoclawDisableStoredDeviceAuth: true",
  "\t} : {}),",
  "\t...(callOpts?.useStoredDeviceAuth === true ? {",
  "\t\tuseStoredDeviceAuth: true, // nemoclaw: forward stored device auth for bounded same-device scope approval (#4462)",
  "\t\trequiredStoredDeviceAuthScopes: callOpts.requiredStoredDeviceAuthScopes",
  "\t} : {})",
  "}));",
].join("\n");

const CLI_LIST_SIGNATURE_TARGET = "async function listPairingWithFallback(opts) {";
const CLI_LIST_SIGNATURE_LEGACY_REPLACEMENT =
  "async function listPairingWithFallback(opts, callOpts) { // nemoclaw: preflight bounded stored device auth before live pairing list (#4462)";
const CLI_LIST_SIGNATURE_REPLACEMENT = [
  CLI_LIST_SIGNATURE_LEGACY_REPLACEMENT,
  '\tconst nemoclawSettlementListCallOpts = process.env.NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT === "1" ? {',
  "\t\tscopes: [PAIRING_SCOPE],",
  "\t\tuseStoredDeviceAuth: true,",
  "\t\trequiredStoredDeviceAuthScopes: [PAIRING_SCOPE]",
  `\t} : void 0; // ${CLI_SETTLEMENT_LIST_MARKER} (#9844)`,
  "\tcallOpts ??= nemoclawSettlementListCallOpts;",
].join("\n");
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
  '\tconst nemoclawPairedTokenRequested = process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1";',
  "\tlet nemoclawLocalStoredAuthCandidate = false;",
  "\tlet nemoclawLocalPairedTokenContext = null;",
  "\tlet nemoclawLocalPairedToken;",
  "\tlet nemoclawPinnedGatewayUrl;",
  "\tlet nemoclawPinnedRequestFound = false;",
  "\tlet nemoclawPinnedStateAllowed = false;",
  "\tlet nemoclawPinnedTransportClean = false;",
  "\ttry {",
  "\t\tconst nemoclawLocalList = nemoclawPairedTokenRequested ? readNemoClawPinnedPairingSnapshot() : await listDevicePairing();",
  "\t\tconst nemoclawLocalRequest = findPendingRequestById(nemoclawLocalList.pending, requestId);",
  "\t\tif (nemoclawLocalRequest) {",
  "\t\t\tnemoclawPinnedRequestFound = true;",
  "\t\t\tconst nemoclawLocalPaired = lookupPairedDevice(indexPairedDevices(nemoclawLocalList.paired), nemoclawLocalRequest);",
  "\t\t\tconst nemoclawLocalContext = resolveNemoClawSelfRepairPairingContext(nemoclawLocalRequest, nemoclawLocalPaired);",
  "\t\t\tnemoclawLocalStoredAuthCandidate = !nemoclawPairedTokenRequested && nemoclawLocalContext.useStoredDeviceAuth;",
  "\t\t\tnemoclawPinnedGatewayUrl = nemoclawPairedTokenRequested ? resolveNemoClawPinnedGatewayUrl() : void 0;",
  "\t\t\tconst nemoclawHasTransportOrCredentialOverride = Boolean(normalizeOptionalString(opts.url) || normalizeOptionalString(opts.token) || normalizeOptionalString(opts.password) || normalizeOptionalString(process.env.OPENCLAW_GATEWAY_TOKEN) || normalizeOptionalString(process.env.OPENCLAW_GATEWAY_PORT) || normalizeOptionalString(process.env.OPENCLAW_GATEWAY_PASSWORD));",
  "\t\t\tnemoclawPinnedStateAllowed = Boolean(nemoclawLocalContext.pairedTokenContext && nemoclawLocalContext.pairedDeviceToken);",
  "\t\t\tnemoclawPinnedTransportClean = !nemoclawHasTransportOrCredentialOverride;",
  "\t\t\tif (",
  "\t\t\t\tnemoclawPairedTokenRequested &&",
  "\t\t\t\t!nemoclawHasTransportOrCredentialOverride &&",
  "\t\t\t\tnemoclawPinnedGatewayUrl &&",
  "\t\t\t\tnemoclawLocalContext.pairedDeviceToken",
  "\t\t\t) {",
  "\t\t\t\tnemoclawLocalPairedTokenContext = nemoclawLocalContext.pairedTokenContext;",
  "\t\t\t\tnemoclawLocalPairedToken = nemoclawLocalContext.pairedDeviceToken;",
  "\t\t\t}",
  "\t\t}",
  "\t} catch {}",
  '\tif (nemoclawPairedTokenRequested && !nemoclawPinnedRequestFound) throw new Error("forced pairing pinned request is unavailable");',
  '\tif (nemoclawPairedTokenRequested && !nemoclawPinnedStateAllowed) throw new Error("forced pairing pinned state is rejected");',
  '\tif (nemoclawPairedTokenRequested && !nemoclawPinnedTransportClean) throw new Error("forced pairing pinned transport is overridden");',
  '\tif (nemoclawPairedTokenRequested && !nemoclawPinnedGatewayUrl) throw new Error("forced pairing pinned URL is rejected");',
  '\tif (nemoclawPairedTokenRequested && !nemoclawLocalPairedTokenContext) throw new Error("forced pairing pinned context is unavailable");',
  "\ttry {",
  "\t\tconst nemoclawListCallOpts = nemoclawLocalStoredAuthCandidate ? {",
  "\t\t\tscopes: [PAIRING_SCOPE],",
  "\t\t\tuseStoredDeviceAuth: true,",
  "\t\t\trequiredStoredDeviceAuthScopes: [PAIRING_SCOPE]",
  "\t\t} : void 0;",
  "\t\tconst nemoclawPairedTokenCallOpts = nemoclawPairedTokenRequested ? { scopes: [PAIRING_SCOPE], usePairedToken: true, pairedToken: nemoclawLocalPairedToken, pinnedGatewayUrl: nemoclawPinnedGatewayUrl } : void 0;",
  '\t\tconst list = nemoclawPairedTokenRequested ? parseDevicePairingList(await callGatewayCli("device.pair.list", opts, {}, nemoclawPairedTokenCallOpts)) : await listPairingWithFallback(opts, nemoclawListCallOpts); // nemoclaw: preflight bounded paired token before live pairing list (#4462)',
  "\t\tconst request = findPendingRequestById(list.pending, requestId);",
  "\t\tif (!request) return {",
  "\t\t\toriginalRequest: null,",
  "\t\t\tscopes: void 0,",
  "\t\t\tnemoclawUseStoredDeviceAuth: false,",
  "\t\t\tnemoclawUsePairedToken: false,",
  "\t\t\tnemoclawRefuseUnsafeApproval: nemoclawPairedTokenRequested || nemoclawLocalStoredAuthCandidate",
  "\t\t};",
  "\t\tconst paired = lookupPairedDevice(indexPairedDevices(list.paired), request);",
  "\t\tconst nemoclawSelfRepairContext = resolveNemoClawSelfRepairPairingContext(request, paired, nemoclawPairedTokenRequested);",
  "\t\tconst nemoclawUseStoredDeviceAuth = nemoclawLocalStoredAuthCandidate && nemoclawSelfRepairContext.useStoredDeviceAuth;",
  "\t\tconst nemoclawUsePairedToken = nemoclawPairedTokenRequested && nemoclawLocalPairedTokenContext === nemoclawSelfRepairContext.pairedTokenContext;",
  "\t\treturn {",
  "\t\t\toriginalRequest: request,",
  "\t\t\tscopes: resolveApprovePairingScopesForRequest(request, paired),",
  "\t\t\tnemoclawUseStoredDeviceAuth,",
  "\t\t\tnemoclawUsePairedToken,",
  "\t\t\tnemoclawPairedToken: nemoclawUsePairedToken ? nemoclawLocalPairedToken : void 0,",
  "\t\t\tnemoclawPinnedGatewayUrl: nemoclawUsePairedToken ? nemoclawPinnedGatewayUrl : void 0,",
  "\t\t\tnemoclawRefuseUnsafeApproval: nemoclawPairedTokenRequested ? !nemoclawUsePairedToken : nemoclawLocalStoredAuthCandidate && !nemoclawUseStoredDeviceAuth",
  "\t\t};",
  "\t} catch {",
  "\t\treturn {",
  "\t\t\toriginalRequest: null,",
  "\t\t\tscopes: void 0,",
  "\t\t\tnemoclawUseStoredDeviceAuth: false,",
  "\t\t\tnemoclawUsePairedToken: false,",
  "\t\t\tnemoclawRefuseUnsafeApproval: nemoclawPairedTokenRequested || nemoclawLocalStoredAuthCandidate",
  "\t\t};",
  "\t}",
  "}",
].join("\n");

const CLI_APPROVE_HEADER_TARGET =
  "\tconst { scopes, originalRequest } = await resolveApprovePairingGatewayContext(opts, requestId);";
const CLI_APPROVE_HEADER_REPLACEMENT =
  '\tconst { scopes, originalRequest, nemoclawUseStoredDeviceAuth, nemoclawUsePairedToken, nemoclawPairedToken, nemoclawPinnedGatewayUrl, nemoclawRefuseUnsafeApproval } = await resolveApprovePairingGatewayContext(opts, requestId);\n\tif (nemoclawRefuseUnsafeApproval) throw new Error("bounded same-device approval context changed before gateway approval");';
const CLI_APPROVE_CALL_TARGET =
  '\t\treturn await callGatewayCli("device.pair.approve", opts, { requestId }, scopes ? { scopes } : void 0);';
const CLI_APPROVE_CALL_REPLACEMENT = [
  '\t\treturn await callGatewayCli("device.pair.approve", opts, { requestId }, nemoclawUsePairedToken ? { scopes: [PAIRING_SCOPE], usePairedToken: true, pairedToken: nemoclawPairedToken, pinnedGatewayUrl: nemoclawPinnedGatewayUrl } : nemoclawUseStoredDeviceAuth ? {',
  "\t\t\tscopes,",
  "\t\t\tuseStoredDeviceAuth: true, // nemoclaw: select stored device auth for bounded same-device scope approval (#4462)",
  "\t\t\trequiredStoredDeviceAuthScopes: [PAIRING_SCOPE]",
  "\t\t} : scopes ? { scopes } : void 0);",
].join("\n");
const CLI_ADMIN_RETRY_TARGET =
  '\t\tif (isDevicePairingApprovalDenied(error) && !scopes?.includes("operator.admin")) return await callGatewayCli("device.pair.approve", opts, { requestId }, { scopes: [ADMIN_SCOPE] });';
const CLI_ADMIN_RETRY_TARGET_2026_7_1 =
  '\t\tif (isDevicePairingApprovalDenied(error) && !scopes?.includes("operator.admin")) try {';
const CLI_ADMIN_RETRY_REPLACEMENT = [
  "\t\tif (nemoclawUseStoredDeviceAuth || nemoclawUsePairedToken) throw error; // nemoclaw: keep bounded device auth fail closed (#4462)",
  CLI_ADMIN_RETRY_TARGET,
].join("\n");
const CLI_ADMIN_RETRY_REPLACEMENT_2026_7_1 = [
  "\t\tif (nemoclawUseStoredDeviceAuth || nemoclawUsePairedToken) throw error; // nemoclaw: keep bounded device auth fail closed (#4462)",
  CLI_ADMIN_RETRY_TARGET_2026_7_1,
].join("\n");

const AUTH_DECISION_CALL_TARGET = [
  "\t\t\t\t\trole,",
  "\t\t\t\t\tscopes,",
  "\t\t\t\t\trateLimiter: authRateLimiter,",
].join("\n");
const AUTH_DECISION_CALL_REPLACEMENT = [
  "\t\t\t\t\trole,",
  "\t\t\t\t\tscopes,",
  "\t\t\t\t\tclientId: connectParams.client.id,",
  "\t\t\t\t\tclientMode: connectParams.client.mode,",
  "\t\t\t\t\trateLimiter: authRateLimiter,",
].join("\n");
const AUTH_DEVICE_TOKEN_TARGET = [
  "\t\tif (tokenCheck.ok) {",
  "\t\t\tauthOk = true;",
  '\t\t\tauthMethod = "device-token";',
].join("\n");
const AUTH_DEVICE_TOKEN_REPLACEMENT = [
  '\t\tconst nemoclawAllowedUpgradeScopes = new Set(["operator.pairing", "operator.read", "operator.write"]);',
  '\t\tconst nemoclawScopeUpgradeScopes = Array.isArray(params.scopes) ? params.scopes.map((scope) => typeof scope === "string" ? scope.trim() : "") : [];',
  "\t\tconst nemoclawCliScopeUpgrade =",
  "\t\t\t!tokenCheck.ok &&",
  '\t\t\t(tokenCheck.reason === "scope-mismatch" || tokenCheck.reason === "scope_mismatch") &&',
  "\t\t\tparams.clientId === GATEWAY_CLIENT_IDS.CLI &&",
  "\t\t\tparams.clientMode === GATEWAY_CLIENT_MODES.CLI &&",
  '\t\t\tparams.role === "operator" &&',
  "\t\t\tnemoclawScopeUpgradeScopes.length > 0 &&",
  "\t\t\tnemoclawScopeUpgradeScopes.length === new Set(nemoclawScopeUpgradeScopes).size &&",
  "\t\t\tnemoclawScopeUpgradeScopes.every((scope) => scope && nemoclawAllowedUpgradeScopes.has(scope));",
  "\t\tif (tokenCheck.ok || nemoclawCliScopeUpgrade) { // nemoclaw: route bounded CLI device-token scope upgrade into pairing (#4462)",
  "\t\t\tauthOk = true;",
  '\t\t\tauthMethod = "device-token";',
].join("\n");

const HANDLER_HELPER = [
  "function resolveNemoClawSelfApprovalIdentity(pending, authz, client) {",
  "\tif (authz.isAdminCaller || client?.isDeviceTokenAuth !== true) return null;",
  '\tconst callerDeviceId = typeof authz.callerDeviceId === "string" ? authz.callerDeviceId.trim() : "";',
  '\tconst clientDeviceId = typeof client?.connect?.device?.id === "string" ? client.connect.device.id.trim() : "";',
  '\tconst pendingDeviceId = typeof pending?.deviceId === "string" ? pending.deviceId.trim() : "";',
  '\tconst clientPublicKey = typeof client?.connect?.device?.publicKey === "string" ? client.connect.device.publicKey.trim() : "";',
  '\tconst pendingPublicKey = typeof pending?.publicKey === "string" ? pending.publicKey.trim() : "";',
  '\tconst clientRole = typeof client?.connect?.role === "string" ? client.connect.role.trim() : "";',
  '\tconst clientId = typeof client?.connect?.client?.id === "string" ? client.connect.client.id.trim() : "";',
  '\tconst clientMode = typeof client?.connect?.client?.mode === "string" ? client.connect.client.mode.trim() : "";',
  '\tconst deviceToken = typeof client?.connect?.auth?.token === "string" ? client.connect.auth.token.trim() : "";',
  '\tconst pendingClientId = typeof pending?.clientId === "string" ? pending.clientId.trim() : "";',
  '\tconst pendingClientMode = typeof pending?.clientMode === "string" ? pending.clientMode.trim() : "";',
  "\tif (",
  "\t\t!callerDeviceId ||",
  "\t\tcallerDeviceId !== clientDeviceId ||",
  "\t\tcallerDeviceId !== pendingDeviceId ||",
  "\t\t!clientPublicKey ||",
  "\t\t!deviceToken ||",
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
  "\tconst nemoclawPendingScopes = new Set();",
  "\tfor (const scope of pending.scopes) {",
  '\t\tif (typeof scope !== "string") return null;',
  "\t\tconst normalized = scope.trim();",
  '\t\tif (!normalized || !["operator.pairing", "operator.read", "operator.write"].includes(normalized) || nemoclawPendingScopes.has(normalized)) return null;',
  "\t\tnemoclawPendingScopes.add(normalized);",
  "\t}",
  '\tif (pending.isRepair !== true && (pending.isRepair !== false || !nemoclawPendingScopes.has("operator.write"))) return null;',
  "\treturn { deviceId: callerDeviceId, publicKey: clientPublicKey, role: clientRole, clientId, clientMode, deviceToken };",
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
  "const NEMOCLAW_SELF_APPROVAL_JOURNAL_VERSION = 2;",
  "const NEMOCLAW_SELF_APPROVAL_LEGACY_JOURNAL_VERSION = 1;",
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
  "function nemoclawOperatorToken(value) {",
  "\tif (!nemoclawIsPlainRecord(value?.tokens)) return null;",
  "\tconst token = value.tokens.operator;",
  '\treturn nemoclawIsPlainRecord(token) && typeof token.token === "string" && token.token.trim() === token.token && token.token ? token : null;',
  "}",
  "function nemoclawExactOperatorScopes(value) {",
  "\tif (!Array.isArray(value) || value.length === 0) return null;",
  "\tconst scopes = new Set();",
  "\tfor (const scope of value) {",
  '\t\tif (typeof scope !== "string" || scope.trim() !== scope || (scope !== "operator.pairing" && scope !== "operator.read" && scope !== "operator.write") || scopes.has(scope)) return null;',
  "\t\tscopes.add(scope);",
  "\t}",
  "\treturn [...scopes].toSorted();",
  "}",
  "function nemoclawIsDeviceAuthStore(value) {",
  '\tif (!nemoclawIsPlainRecord(value) || !nemoclawHasExactKeys(value, ["deviceId", "tokens", "version"])) return false;',
  '\tif (value.version !== 1 || typeof value.deviceId !== "string" || !value.deviceId.trim() || value.deviceId.trim() !== value.deviceId) return false;',
  '\tif (!nemoclawIsPlainRecord(value.tokens) || !nemoclawHasExactKeys(value.tokens, ["operator"])) return false;',
  "\tconst operator = nemoclawOperatorToken(value);",
  '\treturn Boolean(operator && operator.role === "operator" && nemoclawExactOperatorScopes(operator.scopes));',
  "}",
  "function nemoclawIsLegacySnapshot(value) {",
  "\treturn (",
  "\t\tnemoclawIsPlainRecord(value) &&",
  '\t\tnemoclawHasExactKeys(value, ["pairedByDeviceId", "pendingById"]) &&',
  "\t\tnemoclawIsPairingRecord(value.pendingById) &&",
  "\t\tnemoclawIsPairingRecord(value.pairedByDeviceId)",
  "\t);",
  "}",
  "function nemoclawIsSnapshot(value) {",
  "\treturn (",
  "\t\tnemoclawIsPlainRecord(value) &&",
  '\t\tnemoclawHasExactKeys(value, ["auth", "pairedByDeviceId", "pendingById"]) &&',
  "\t\tnemoclawIsDeviceAuthStore(value.auth) &&",
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
  "function nemoclawAuthMatchesPairedDevice(auth, paired) {",
  "\tconst authToken = nemoclawOperatorToken(auth);",
  "\tconst pairedToken = nemoclawOperatorToken(paired);",
  "\tconst authScopes = nemoclawExactOperatorScopes(authToken?.scopes);",
  "\tconst pairedScopes = nemoclawExactOperatorScopes(pairedToken?.scopes);",
  "\treturn Boolean(",
  "\t\tnemoclawIsDeviceAuthStore(auth) &&",
  "\t\tnemoclawIsPlainRecord(paired) &&",
  '\t\ttypeof paired.deviceId === "string" &&',
  "\t\tauth.deviceId === paired.deviceId &&",
  '\t\tauthToken?.role === "operator" &&',
  '\t\tpairedToken?.role === "operator" &&',
  "\t\tauthToken.token === pairedToken.token &&",
  "\t\tauthScopes &&",
  "\t\tpairedScopes &&",
  "\t\tnemoclawStatesEqual(authScopes, pairedScopes)",
  "\t);",
  "}",
  "function nemoclawDeviceAuthForPairedDevice(currentAuth, paired) {",
  "\tif (nemoclawAuthMatchesPairedDevice(currentAuth, paired)) return currentAuth;",
  "\tconst pairedToken = nemoclawOperatorToken(paired);",
  "\tconst pairedScopes = nemoclawExactOperatorScopes(pairedToken?.scopes);",
  '\tif (!nemoclawIsPlainRecord(paired) || typeof paired.deviceId !== "string" || !paired.deviceId.trim() || paired.deviceId !== paired.deviceId.trim() || pairedToken?.role !== "operator" || !pairedScopes) throw new Error("invalid paired device while migrating the NemoClaw self-approval journal");',
  '\treturn { version: 1, deviceId: paired.deviceId, tokens: { operator: { token: pairedToken.token, role: "operator", scopes: [...pairedToken.scopes], updatedAtMs: Date.now() } } };',
  "}",
  "function nemoclawResolveJournalPath(baseDir) {",
  '\treturn `${resolvePairingPaths(baseDir, "devices").pendingPath}${NEMOCLAW_SELF_APPROVAL_JOURNAL_SUFFIX}`;',
  "}",
  "function nemoclawResolveDeviceAuthPath(baseDir) {",
  '\treturn `${resolvePairingPaths(baseDir, "identity").dir}/device-auth.json`;',
  "}",
  "function nemoclawIdleJournal() {",
  '\treturn { version: NEMOCLAW_SELF_APPROVAL_JOURNAL_VERSION, kind: NEMOCLAW_SELF_APPROVAL_JOURNAL_KIND, phase: "idle" };',
  "}",
  "function nemoclawValidateLegacyJournal(value) {",
  '\tif (value.version !== NEMOCLAW_SELF_APPROVAL_LEGACY_JOURNAL_VERSION || value.kind !== NEMOCLAW_SELF_APPROVAL_JOURNAL_KIND) throw new Error("invalid legacy NemoClaw self-approval journal identity");',
  '\tif (value.phase === "idle") {',
  '\t\tif (!nemoclawHasExactKeys(value, ["kind", "phase", "version"])) throw new Error("invalid legacy NemoClaw idle self-approval journal");',
  "\t\treturn value;",
  "\t}",
  '\tif (value.phase !== "prepared" && value.phase !== "committed") throw new Error("invalid legacy NemoClaw self-approval journal phase");',
  '\tif (!nemoclawHasExactKeys(value, ["after", "before", "deviceId", "kind", "phase", "requestId", "version"])) throw new Error("invalid legacy NemoClaw self-approval journal schema");',
  '\tif (typeof value.requestId !== "string" || !value.requestId.trim() || value.requestId !== value.requestId.trim()) throw new Error("invalid legacy NemoClaw self-approval journal request id");',
  '\tif (typeof value.deviceId !== "string" || !value.deviceId.trim() || value.deviceId !== value.deviceId.trim()) throw new Error("invalid legacy NemoClaw self-approval journal device id");',
  '\tif (!nemoclawIsLegacySnapshot(value.before) || !nemoclawIsLegacySnapshot(value.after)) throw new Error("invalid legacy NemoClaw self-approval journal snapshots");',
  "\tconst pendingBefore = value.before.pendingById[value.requestId];",
  "\tconst pairedBefore = value.before.pairedByDeviceId[value.deviceId];",
  "\tconst pairedAfter = value.after.pairedByDeviceId[value.deviceId];",
  "\tconst pairedTokenBefore = nemoclawOperatorToken(pairedBefore);",
  "\tconst pairedTokenAfter = nemoclawOperatorToken(pairedAfter);",
  "\tconst pairedScopesBefore = nemoclawExactOperatorScopes(pairedTokenBefore?.scopes);",
  "\tconst pairedScopesAfter = nemoclawExactOperatorScopes(pairedTokenAfter?.scopes);",
  "\tif (",
  "\t\t!nemoclawIsPlainRecord(pendingBefore) ||",
  "\t\tpendingBefore.deviceId !== value.deviceId ||",
  "\t\t!nemoclawIsPlainRecord(pairedBefore) ||",
  "\t\tpairedBefore.deviceId !== value.deviceId ||",
  "\t\tvalue.requestId in value.after.pendingById ||",
  "\t\t!nemoclawIsPlainRecord(pairedAfter) ||",
  "\t\tpairedAfter.deviceId !== value.deviceId ||",
  '\t\tpairedTokenBefore?.role !== "operator" ||',
  '\t\tpairedTokenAfter?.role !== "operator" ||',
  "\t\t!pairedScopesBefore ||",
  "\t\t!pairedScopesAfter ||",
  "\t\tpairedTokenBefore.token === pairedTokenAfter.token",
  '\t) throw new Error("invalid legacy NemoClaw self-approval journal transition");',
  "\treturn value;",
  "}",
  "function nemoclawValidateJournal(value) {",
  '\tif (!nemoclawIsPlainRecord(value)) throw new Error("invalid NemoClaw self-approval journal object");',
  "\tif (value.version === NEMOCLAW_SELF_APPROVAL_LEGACY_JOURNAL_VERSION) return nemoclawValidateLegacyJournal(value);",
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
  "\tconst authBefore = value.before.auth;",
  "\tconst authAfter = value.after.auth;",
  "\tconst pairedTokenBefore = nemoclawOperatorToken(pairedBefore);",
  "\tconst pairedTokenAfter = nemoclawOperatorToken(pairedAfter);",
  "\tconst authTokenBefore = nemoclawOperatorToken(authBefore);",
  "\tconst authTokenAfter = nemoclawOperatorToken(authAfter);",
  "\tconst pairedScopesBefore = nemoclawExactOperatorScopes(pairedTokenBefore?.scopes);",
  "\tconst pairedScopesAfter = nemoclawExactOperatorScopes(pairedTokenAfter?.scopes);",
  "\tconst authScopesBefore = nemoclawExactOperatorScopes(authTokenBefore?.scopes);",
  "\tconst authScopesAfter = nemoclawExactOperatorScopes(authTokenAfter?.scopes);",
  "\tif (",
  "\t\t!nemoclawIsPlainRecord(pendingBefore) ||",
  "\t\tpendingBefore.deviceId !== value.deviceId ||",
  "\t\t!nemoclawIsPlainRecord(pairedBefore) ||",
  "\t\tpairedBefore.deviceId !== value.deviceId ||",
  "\t\tvalue.requestId in value.after.pendingById ||",
  "\t\t!nemoclawIsPlainRecord(pairedAfter) ||",
  "\t\tpairedAfter.deviceId !== value.deviceId ||",
  "\t\tauthBefore.deviceId !== value.deviceId ||",
  "\t\tauthAfter.deviceId !== value.deviceId ||",
  "\t\t!pairedTokenBefore ||",
  "\t\t!pairedTokenAfter ||",
  "\t\t!authTokenBefore ||",
  "\t\t!authTokenAfter ||",
  "\t\t!pairedScopesBefore ||",
  "\t\t!pairedScopesAfter ||",
  "\t\t!authScopesBefore ||",
  "\t\t!authScopesAfter ||",
  "\t\tpairedTokenBefore.token !== authTokenBefore.token ||",
  "\t\tpairedTokenAfter.token !== authTokenAfter.token ||",
  "\t\tpairedTokenBefore.token === pairedTokenAfter.token ||",
  "\t\t!nemoclawStatesEqual(pairedScopesBefore, authScopesBefore) ||",
  "\t\t!nemoclawStatesEqual(pairedScopesAfter, authScopesAfter)",
  '\t) throw new Error("invalid NemoClaw self-approval journal transition");',
  "\treturn value;",
  "}",
  "async function nemoclawReadPairingSnapshot(baseDir) {",
  '\tconst { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");',
  "\tconst authPath = nemoclawResolveDeviceAuthPath(baseDir);",
  "\tconst [pending, paired, auth] = await Promise.all([readJsonIfExists(pendingPath), readJsonIfExists(pairedPath), readJsonIfExists(authPath)]);",
  "\tconst snapshot = { pendingById: pending ?? {}, pairedByDeviceId: paired ?? {}, auth };",
  '\tif (!nemoclawIsSnapshot(snapshot)) throw new Error("invalid device pairing state during NemoClaw self-approval transaction");',
  "\treturn snapshot;",
  "}",
  "async function nemoclawWritePairingSnapshot(snapshot, baseDir) {",
  '\tconst { pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");',
  "\tconst authPath = nemoclawResolveDeviceAuthPath(baseDir);",
  "\tconst settled = await Promise.allSettled([writeJson(pendingPath, snapshot.pendingById), writeJson(pairedPath, snapshot.pairedByDeviceId), writeJson(authPath, snapshot.auth, NEMOCLAW_SELF_APPROVAL_JOURNAL_WRITE_OPTIONS)]);",
  '\tconst failures = settled.filter((result) => result.status === "rejected").map((result) => result.reason);',
  '\tif (failures.length > 0) throw new AggregateError(failures, "failed to publish device pairing and stored-auth state");',
  "}",
  "function nemoclawCurrentMatchesJournal(current, journal) {",
  "\treturn (",
  "\t\t(nemoclawStatesEqual(current.pendingById, journal.before.pendingById) || nemoclawStatesEqual(current.pendingById, journal.after.pendingById)) &&",
  "\t\t(nemoclawStatesEqual(current.pairedByDeviceId, journal.before.pairedByDeviceId) || nemoclawStatesEqual(current.pairedByDeviceId, journal.after.pairedByDeviceId)) &&",
  "\t\t(nemoclawStatesEqual(current.auth, journal.before.auth) || nemoclawStatesEqual(current.auth, journal.after.auth))",
  "\t);",
  "}",
  "function nemoclawCurrentMatchesLegacyJournal(current, journal) {",
  "\treturn (",
  "\t\t(nemoclawStatesEqual(current.pendingById, journal.before.pendingById) || nemoclawStatesEqual(current.pendingById, journal.after.pendingById)) &&",
  "\t\t(nemoclawStatesEqual(current.pairedByDeviceId, journal.before.pairedByDeviceId) || nemoclawStatesEqual(current.pairedByDeviceId, journal.after.pairedByDeviceId)) &&",
  "\t\t(nemoclawAuthMatchesPairedDevice(current.auth, journal.before.pairedByDeviceId[journal.deviceId]) || nemoclawAuthMatchesPairedDevice(current.auth, journal.after.pairedByDeviceId[journal.deviceId]))",
  "\t);",
  "}",
  "async function nemoclawRecoverLegacySelfApprovalTransaction(journal, baseDir, journalPath) {",
  '\tif (journal.phase === "idle") {',
  "\t\tawait writeJson(journalPath, nemoclawIdleJournal(), NEMOCLAW_SELF_APPROVAL_JOURNAL_WRITE_OPTIONS);",
  '\t\treturn "idle";',
  "\t}",
  "\tconst current = await nemoclawReadPairingSnapshot(baseDir);",
  '\tif (!nemoclawCurrentMatchesLegacyJournal(current, journal)) throw new Error("device pairing or stored-auth state does not match the legacy NemoClaw self-approval journal");',
  '\tconst targetPairing = journal.phase === "prepared" ? journal.before : journal.after;',
  "\tconst targetPaired = targetPairing.pairedByDeviceId[journal.deviceId];",
  "\tconst target = { pendingById: targetPairing.pendingById, pairedByDeviceId: targetPairing.pairedByDeviceId, auth: nemoclawDeviceAuthForPairedDevice(current.auth, targetPaired) };",
  "\tawait nemoclawWritePairingSnapshot(target, baseDir);",
  "\tawait writeJson(journalPath, nemoclawIdleJournal(), NEMOCLAW_SELF_APPROVAL_JOURNAL_WRITE_OPTIONS);",
  "\treturn journal.phase;",
  "} // nemoclaw: migrate version 1 self-approval recovery state (#9844)",
  "async function recoverNemoClawSelfApprovalTransaction(baseDir) {",
  "\tconst journalPath = nemoclawResolveJournalPath(baseDir);",
  "\tconst rawJournal = await readJsonIfExists(journalPath);",
  "\tif (rawJournal === null) return null;",
  "\tconst journal = nemoclawValidateJournal(rawJournal);",
  "\tif (journal.version === NEMOCLAW_SELF_APPROVAL_LEGACY_JOURNAL_VERSION) return await nemoclawRecoverLegacySelfApprovalTransaction(journal, baseDir, journalPath);",
  '\tif (journal.phase === "idle") return "idle";',
  "\tconst current = await nemoclawReadPairingSnapshot(baseDir);",
  '\tif (!nemoclawCurrentMatchesJournal(current, journal)) throw new Error("device pairing state does not match the NemoClaw self-approval journal");',
  '\tawait nemoclawWritePairingSnapshot(journal.phase === "prepared" ? journal.before : journal.after, baseDir);',
  "\tawait writeJson(journalPath, nemoclawIdleJournal(), NEMOCLAW_SELF_APPROVAL_JOURNAL_WRITE_OPTIONS);",
  "\treturn journal.phase;",
  "} // nemoclaw: recover bounded self-approval state transaction (#4462)",
  "async function persistNemoClawSelfApprovalState(state, baseDir, requestId, deviceId, before, identity) {",
  "\tconst journalPath = nemoclawResolveJournalPath(baseDir);",
  "\tconst current = await nemoclawReadPairingSnapshot(baseDir);",
  "\tconst currentPairing = { pendingById: current.pendingById, pairedByDeviceId: current.pairedByDeviceId };",
  '\tif (!nemoclawIsPlainRecord(before) || !nemoclawStatesEqual(currentPairing, before)) throw new Error("device pairing state changed before NemoClaw self-approval publication");',
  "\tconst beforePairedToken = nemoclawOperatorToken(current.pairedByDeviceId[deviceId]);",
  "\tconst beforeAuthToken = nemoclawOperatorToken(current.auth);",
  "\tconst afterPairedToken = nemoclawOperatorToken(state.pairedByDeviceId[deviceId]);",
  "\tconst beforePairedScopes = nemoclawExactOperatorScopes(beforePairedToken?.scopes);",
  "\tconst beforeAuthScopes = nemoclawExactOperatorScopes(beforeAuthToken?.scopes);",
  "\tconst afterPairedScopes = nemoclawExactOperatorScopes(afterPairedToken?.scopes);",
  '\tif (!identity || identity.deviceId !== deviceId || !beforePairedToken || !beforeAuthToken || !afterPairedToken || !beforePairedScopes || !beforeAuthScopes || !afterPairedScopes || identity.deviceToken !== beforePairedToken.token || identity.deviceToken !== beforeAuthToken.token || !nemoclawStatesEqual(beforePairedScopes, beforeAuthScopes)) throw new Error("stored device auth changed before NemoClaw self-approval publication");',
  '\tconst afterAuth = { version: 1, deviceId, tokens: { operator: { token: afterPairedToken.token, role: "operator", scopes: [...afterPairedToken.scopes], updatedAtMs: Date.now() } } };',
  "\tconst beforeSnapshot = { ...currentPairing, auth: current.auth };",
  "\tconst after = { pendingById: state.pendingById, pairedByDeviceId: state.pairedByDeviceId, auth: afterAuth };",
  "\tconst prepared = nemoclawValidateJournal({",
  "\t\tversion: NEMOCLAW_SELF_APPROVAL_JOURNAL_VERSION,",
  "\t\tkind: NEMOCLAW_SELF_APPROVAL_JOURNAL_KIND,",
  '\t\tphase: "prepared",',
  "\t\trequestId,",
  "\t\tdeviceId,",
  "\t\tbefore: beforeSnapshot,",
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
  "\tawait writeJson(journalPath, nemoclawIdleJournal(), NEMOCLAW_SELF_APPROVAL_JOURNAL_WRITE_OPTIONS);",
  "}",
  "",
].join("\n");

const STATE_HELPER = [
  'const NEMOCLAW_SELF_APPROVAL_SCOPE_ORDER = ["operator.pairing", "operator.read", "operator.write"];',
  "const NEMOCLAW_SELF_APPROVAL_ALLOWED_SCOPES = new Set(NEMOCLAW_SELF_APPROVAL_SCOPE_ORDER);",
  "function resolveNemoClawSelfApprovalScopes(pending, callerScopes, identity) {",
  '\tif (!identity || !Array.isArray(callerScopes) || !callerScopes.includes("operator.pairing")) return null;',
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
  '\tif (pending.isRepair !== true && (pending.isRepair !== false || !scopes.has("operator.write"))) return null;',
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
const STATE_LIST_TARGET_2026_7_1 = [
  "async function listDevicePairing(baseDir) {",
  "\tconst state = await loadState(baseDir);",
  "\treturn {",
  "\t\tpending: Object.values(state.pendingById).map(toPublicPendingDevicePairingRequest).toSorted((a, b) => b.ts - a.ts),",
  "\t\tpaired: Object.values(state.pairedByDeviceId).toSorted((a, b) => b.approvedAtMs - a.approvedAtMs)",
  "\t};",
  "}",
].join("\n");
const STATE_LIST_REPLACEMENT_2026_7_1 = [
  "async function listDevicePairing(baseDir) {",
  "\treturn await withLock(async () => {",
  "\t\tconst state = await loadState(baseDir);",
  "\t\treturn {",
  "\t\t\tpending: Object.values(state.pendingById).map(toPublicPendingDevicePairingRequest).toSorted((a, b) => b.ts - a.ts),",
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
const STATE_GET_PENDING_TARGET_2026_7_1 = [
  "/** Return one pending pairing request by request id. */",
  "async function getPendingDevicePairing(requestId, baseDir) {",
  "\tconst pending = (await loadState(baseDir)).pendingById[requestId];",
  "\treturn pending ? toPublicPendingDevicePairingRequest(pending) : null;",
  "}",
].join("\n");
const STATE_GET_PENDING_REPLACEMENT_2026_7_1 = [
  "/** Return one pending pairing request by request id. */",
  "async function getPendingDevicePairing(requestId, baseDir) {",
  "\treturn await withLock(async () => {",
  "\t\tconst pending = (await loadState(baseDir)).pendingById[requestId];",
  "\t\treturn pending ? toPublicPendingDevicePairingRequest(pending) : null;",
  "\t});",
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
  "\t\tif (nemoclawSelfApprovalScopes) await persistNemoClawSelfApprovalState(state, baseDir, requestId, device.deviceId, state[NEMOCLAW_SELF_APPROVAL_LOADED_SNAPSHOT], options.nemoclawSelfApprovalIdentity);",
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
    id: "device-identity",
    label: "device identity runtime",
    marker: DEVICE_IDENTITY_FD_MARKER,
    selector(source) {
      return (
        source.includes("function normalizeStoredIdentity(parsed) {") &&
        (source.includes(DEVICE_IDENTITY_LOAD_TARGET) || source.includes(DEVICE_IDENTITY_FD_MARKER))
      );
    },
    patch(source, file) {
      if (source.includes(DEVICE_IDENTITY_FD_MARKER)) {
        if (source.includes(DEVICE_IDENTITY_LOAD_LEGACY_FORCE_LINE)) {
          const result = replaceExactlyOnce(
            source,
            DEVICE_IDENTITY_LOAD_LEGACY_FORCE_LINE,
            DEVICE_IDENTITY_LOAD_MODE_LINE,
            "restored-clone device-identity mode target",
            file,
          );
          return result.error
            ? { source, status: "no-match", error: result.error }
            : { source: result.source, status: "would-apply" };
        }
        return { source, status: "already-applied" };
      }
      const result = replaceExactlyOnce(
        source,
        DEVICE_IDENTITY_LOAD_TARGET,
        DEVICE_IDENTITY_LOAD_REPLACEMENT,
        "forced device-identity descriptor target",
        file,
      );
      return result.error
        ? { source, status: "no-match", error: result.error }
        : { source: result.source, status: "would-apply" };
    },
  },
  {
    id: "gateway-call-device-identity",
    label: "gateway call device-identity runtime",
    marker: CALL_STORED_IDENTITY_MARKER,
    selector(source) {
      return (
        source.includes("function shouldOmitDeviceIdentityForGatewayCall(params) {") &&
        source.includes("const isLocalCliSharedAuth =") &&
        (source.includes(CALL_OMIT_IDENTITY_TARGET) ||
          source.includes(CALL_FORCE_IDENTITY_MARKER)) &&
        (source.includes(CALL_STORED_IDENTITY_TARGET) ||
          source.includes(CALL_STORED_IDENTITY_MARKER)) &&
        (source.includes(CALL_IDENTITY_RESOLVER_TARGET) ||
          source.includes(CALL_EXPECTED_IDENTITY_MARKER)) &&
        (source.includes(CALL_DISABLE_STORED_AUTH_TARGET) ||
          source.includes(CALL_DISABLE_STORED_AUTH_MARKER))
      );
    },
    patch(source, file) {
      let result: ReplacementResult = { source };
      let changed = false;
      if (result.source.includes(CALL_OMIT_IDENTITY_LEGACY_FORCE_LINE)) {
        result = replaceExactlyOnce(
          result.source,
          CALL_OMIT_IDENTITY_LEGACY_FORCE_LINE,
          CALL_OMIT_IDENTITY_MODE_LINE,
          "restored-clone gateway call device-identity mode target",
          file,
        );
        if (result.error) return { source, status: "no-match", error: result.error };
        changed = true;
      } else if (!result.source.includes(CALL_FORCE_IDENTITY_MARKER)) {
        result = replaceExactlyOnce(
          result.source,
          CALL_OMIT_IDENTITY_TARGET,
          CALL_OMIT_IDENTITY_REPLACEMENT,
          "gateway call forced device-identity target",
          file,
        );
        if (result.error) return { source, status: "no-match", error: result.error };
        changed = true;
      }
      if (!result.source.includes(CALL_STORED_IDENTITY_MARKER)) {
        result = replaceExactlyOnce(
          result.source,
          CALL_STORED_IDENTITY_TARGET,
          CALL_STORED_IDENTITY_REPLACEMENT,
          "gateway call stored device-identity target",
          file,
        );
        if (result.error) return { source, status: "no-match", error: result.error };
        changed = true;
      }
      if (
        result.source.includes(CALL_EXPECTED_IDENTITY_MARKER) &&
        result.source.includes(CALL_IDENTITY_RESOLVER_LEGACY_FORCE_LINE)
      ) {
        result = replaceExactlyOnce(
          result.source,
          CALL_IDENTITY_RESOLVER_LEGACY_FORCE_LINE,
          CALL_IDENTITY_RESOLVER_MODE_LINE,
          "restored-clone gateway call expected identity mode target",
          file,
        );
        if (result.error) return { source, status: "no-match", error: result.error };
        changed = true;
      } else if (!result.source.includes(CALL_EXPECTED_IDENTITY_MARKER)) {
        result = replaceExactlyOnce(
          result.source,
          CALL_IDENTITY_RESOLVER_TARGET,
          CALL_IDENTITY_RESOLVER_REPLACEMENT,
          "gateway call expected clone-identity target",
          file,
        );
        if (result.error) return { source, status: "no-match", error: result.error };
        changed = true;
      }
      if (!result.source.includes(CALL_DISABLE_STORED_AUTH_MARKER)) {
        result = replaceExactlyOnce(
          result.source,
          CALL_DISABLE_STORED_AUTH_TARGET,
          CALL_DISABLE_STORED_AUTH_REPLACEMENT,
          "gateway call forced stored-auth suppression target",
          file,
        );
        if (result.error) return { source, status: "no-match", error: result.error };
        changed = true;
      }
      return { source: result.source, status: changed ? "would-apply" : "already-applied" };
    },
  },
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
        const settlementMarkerIndex = CLI_APPLIED_MARKERS.indexOf(CLI_SETTLEMENT_LIST_MARKER);
        const settlementMarkerCount = appliedMarkerCounts[settlementMarkerIndex];
        const priorMarkerCounts = appliedMarkerCounts.filter(
          (_count, index) => index !== settlementMarkerIndex,
        );
        if (priorMarkerCounts.every((count) => count === 1) && settlementMarkerCount! <= 1) {
          let upgradedSource = source;
          let changed = false;
          const legacyModeLine =
            '\tconst nemoclawPairedTokenRequested = process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1";';
          if (upgradedSource.includes(legacyModeLine)) {
            const result = replaceExactlyOnce(
              upgradedSource,
              legacyModeLine,
              '\tconst nemoclawPairedTokenRequested = process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1";',
              "restored-clone paired-token mode target",
              file,
            );
            if (result.error) return { source, status: "no-match", error: result.error };
            upgradedSource = result.source;
            changed = true;
          }
          if (settlementMarkerCount === 0) {
            const result = replaceExactlyOnce(
              upgradedSource,
              CLI_LIST_SIGNATURE_LEGACY_REPLACEMENT,
              CLI_LIST_SIGNATURE_REPLACEMENT,
              "devices CLI pairing-settlement list target",
              file,
            );
            if (result.error) return { source, status: "no-match", error: result.error };
            upgradedSource = result.source;
            changed = true;
          }
          return {
            source: upgradedSource,
            status: changed ? "would-apply" : "already-applied",
          };
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
      const retryTarget = result.source.includes(CLI_ADMIN_RETRY_TARGET)
        ? CLI_ADMIN_RETRY_TARGET
        : CLI_ADMIN_RETRY_TARGET_2026_7_1;
      const retryReplacement =
        retryTarget === CLI_ADMIN_RETRY_TARGET
          ? CLI_ADMIN_RETRY_REPLACEMENT
          : CLI_ADMIN_RETRY_REPLACEMENT_2026_7_1;
      result = replaceExactlyOnce(
        result.source,
        retryTarget,
        retryReplacement,
        "devices CLI stored-auth fail-closed retry target",
        file,
      );
      return result.error
        ? { source, status: "no-match", error: result.error }
        : { source: result.source, status: "would-apply" };
    },
  },
  {
    id: "gateway-auth-scope-upgrade",
    label: "device-token scope-upgrade gateway auth runtime",
    marker: AUTH_SCOPE_UPGRADE_MARKER,
    selector(source) {
      return (
        source.includes("async function resolveConnectAuthDecisionCore(params)") &&
        source.includes("const authDecision = await resolveConnectAuthDecision({") &&
        source.includes("verifyDeviceToken: async") &&
        (source.includes(AUTH_DEVICE_TOKEN_TARGET) || source.includes(AUTH_SCOPE_UPGRADE_MARKER))
      );
    },
    patch(source, file) {
      if (source.includes(AUTH_SCOPE_UPGRADE_MARKER)) {
        return { source, status: "already-applied" };
      }
      let result = replaceExactlyOnce(
        source,
        AUTH_DECISION_CALL_TARGET,
        AUTH_DECISION_CALL_REPLACEMENT,
        "gateway auth decision CLI identity target",
        file,
      );
      if (result.error) return { source, status: "no-match", error: result.error };
      result = replaceExactlyOnce(
        result.source,
        AUTH_DEVICE_TOKEN_TARGET,
        AUTH_DEVICE_TOKEN_REPLACEMENT,
        "gateway device-token scope-upgrade target",
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
      const listTarget = result.source.includes(STATE_LIST_TARGET)
        ? STATE_LIST_TARGET
        : STATE_LIST_TARGET_2026_7_1;
      result = replaceExactlyOnce(
        result.source,
        listTarget,
        listTarget === STATE_LIST_TARGET ? STATE_LIST_REPLACEMENT : STATE_LIST_REPLACEMENT_2026_7_1,
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
      const pendingTarget = result.source.includes(STATE_GET_PENDING_TARGET)
        ? STATE_GET_PENDING_TARGET
        : STATE_GET_PENDING_TARGET_2026_7_1;
      result = replaceExactlyOnce(
        result.source,
        pendingTarget,
        pendingTarget === STATE_GET_PENDING_TARGET
          ? STATE_GET_PENDING_REPLACEMENT
          : STATE_GET_PENDING_REPLACEMENT_2026_7_1,
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
