// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared security payloads for readable and archived OpenClaw runtime copies.
export const CALL_FORCE_IDENTITY_MARKER =
  "nemoclaw: force device identity for loopback pairing bootstrap";
export const CALL_STORED_IDENTITY_MARKER =
  "nemoclaw: retain stored CLI device identity for loopback shared-token scope enforcement";

export const CALL_EXPECTED_IDENTITY_MARKER =
  "nemoclaw: require the pinned clone identity for forced pairing";

export const DEVICE_IDENTITY_FD_MARKER =
  "nemoclaw: load the forced clone identity from its inherited descriptor";

export const AUTH_SCOPE_UPGRADE_MARKER =
  "nemoclaw: route bounded CLI device-token scope upgrade into pairing";

export const AUTH_DEFER_SILENT_SCOPE_UPGRADE_MARKER =
  "nemoclaw: defer bounded silent CLI scope upgrade to pairing watcher";

export const AUTH_REQUIRE_EXPLICIT_ADMIN_UPGRADE_MARKER =
  "nemoclaw: require explicit approval for CLI operator.admin upgrade";

export const STATE_TRANSACTION_MARKER = "nemoclaw: recover bounded self-approval state transaction";

export const CALL_STORED_IDENTITY_TARGET =
  "\tconst isLocalCliSharedAuth = mode === GATEWAY_CLIENT_MODES.CLI && clientName === GATEWAY_CLIENT_NAMES.CLI && hasSharedSecretAuth && isLoopback;";

export const CALL_IDENTITY_RESOLVER_SQLITE_REPLACEMENT = [
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
  '\t\tconst nemoclawFs = process.getBuiltinModule("node:fs");',
  "\t\tconst nemoclawBefore = nemoclawFs.fstatSync(nemoclawDescriptor);",
  "\t\tif (!nemoclawBefore.isFile() || (nemoclawBefore.nlink !== 0 && nemoclawBefore.nlink !== 1) || !Number.isSafeInteger(nemoclawBefore.size) || nemoclawBefore.size < 2 || nemoclawBefore.size > 1048576) throw new Error();",
  "\t\tconst nemoclawBuffer = Buffer.alloc(nemoclawBefore.size);",
  "\t\tlet nemoclawOffset = 0;",
  "\t\twhile (nemoclawOffset < nemoclawBuffer.length) {",
  "\t\t\tconst nemoclawRead = nemoclawFs.readSync(nemoclawDescriptor, nemoclawBuffer, nemoclawOffset, nemoclawBuffer.length - nemoclawOffset, nemoclawOffset);",
  "\t\t\tif (nemoclawRead <= 0) throw new Error();",
  "\t\t\tnemoclawOffset += nemoclawRead;",
  "\t\t}",
  "\t\tconst nemoclawAfter = nemoclawFs.fstatSync(nemoclawDescriptor);",
  "\t\tif (!nemoclawAfter.isFile() || (nemoclawAfter.nlink !== 0 && nemoclawAfter.nlink !== 1) || nemoclawAfter.nlink !== nemoclawBefore.nlink || nemoclawAfter.dev !== nemoclawBefore.dev || nemoclawAfter.ino !== nemoclawBefore.ino || nemoclawAfter.size !== nemoclawBefore.size || nemoclawAfter.mtimeMs !== nemoclawBefore.mtimeMs) throw new Error();",
  '\t\tnemoclawParsedIdentity = JSON.parse(nemoclawBuffer.toString("utf8"));',
  "\t\tconst nemoclawIdentityKeys = Object.keys(nemoclawParsedIdentity ?? {}).toSorted();",
  '\t\tif (nemoclawParsedIdentity?.version !== 1 || nemoclawIdentityKeys.join("\\0") !== ["deviceId", "privateKeyPem", "publicKeyPem", "version"].join("\\0")) throw new Error();',
  '\t\tif (typeof nemoclawParsedIdentity.deviceId !== "string" || !/^[a-f0-9]{64}$/.test(nemoclawParsedIdentity.deviceId) || typeof nemoclawParsedIdentity.publicKeyPem !== "string" || typeof nemoclawParsedIdentity.privateKeyPem !== "string") throw new Error();',
  '\t\tconst nemoclawCrypto = process.getBuiltinModule("node:crypto");',
  "\t\tconst nemoclawPublicKey = nemoclawCrypto.createPublicKey(nemoclawParsedIdentity.publicKeyPem);",
  "\t\tconst nemoclawPrivateKey = nemoclawCrypto.createPrivateKey(nemoclawParsedIdentity.privateKeyPem);",
  '\t\tif (nemoclawPublicKey.asymmetricKeyType !== "ed25519" || nemoclawPrivateKey.asymmetricKeyType !== "ed25519") throw new Error();',
  '\t\tconst nemoclawPublicDer = nemoclawPublicKey.export({ type: "spki", format: "der" });',
  '\t\tconst nemoclawDerivedPublicDer = nemoclawCrypto.createPublicKey(nemoclawPrivateKey).export({ type: "spki", format: "der" });',
  '\t\tif (!Buffer.from(nemoclawPublicDer).equals(Buffer.from(nemoclawDerivedPublicDer)) || nemoclawCrypto.createHash("sha256").update(Buffer.from(nemoclawPublicDer).subarray(-32)).digest("hex") !== nemoclawParsedIdentity.deviceId) throw new Error();',
  "\t} catch {",
  '\t\tthrow new Error("forced pairing identity descriptor is invalid");',
  "\t}",
  `\treturn { deviceId: nemoclawParsedIdentity.deviceId, publicKeyPem: nemoclawParsedIdentity.publicKeyPem, privateKeyPem: nemoclawParsedIdentity.privateKeyPem }; // ${DEVICE_IDENTITY_FD_MARKER} (#4462)`,
  "}",
  "function resolveDeviceIdentityForGatewayCall(sharedStateMode) {",
  '\tif (process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1") {',
  "\t\tconst nemoclawExpectedDeviceId = normalizeOptionalString(process.env.NEMOCLAW_OPENCLAW_EXPECTED_DEVICE_ID);",
  '\t\tif (!nemoclawExpectedDeviceId) throw new Error("forced pairing expected device identity is unavailable");',
  "\t\tconst nemoclawDeviceIdentity = loadNemoClawForcedDeviceIdentity();",
  `\t\tif (nemoclawDeviceIdentity.deviceId !== nemoclawExpectedDeviceId) throw new Error("forced pairing device identity does not match the clone"); // ${CALL_EXPECTED_IDENTITY_MARKER} (#4462)`,
  "\t\treturn nemoclawDeviceIdentity;",
  "\t}",
  '\tif (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1") return loadOrCreateDeviceIdentity();',
  "\ttry {",
  '\t\treturn sharedStateMode === "read-only" ? loadDeviceIdentityIfPresent() : loadOrCreateDeviceIdentity();',
  "\t} catch {",
  "\t\treturn null;",
  "\t}",
  "}",
].join("\n");

export const AUTH_DEVICE_TOKEN_SQLITE_TARGET = [
  "\t\tasync verifyDeviceToken(paramsLocal) {",
  "\t\t\treturn await verifyDeviceToken({",
  "\t\t\t\t...paramsLocal,",
  "\t\t\t\trequiredSharedGatewaySessionGeneration: getRequiredSharedGatewaySessionGeneration?.()",
  "\t\t\t});",
  "\t\t}",
].join("\n");

export const AUTH_DEVICE_TOKEN_SQLITE_REPLACEMENT_PREVIOUS = [
  "\t\tasync verifyDeviceToken(paramsLocal) {",
  "\t\t\tconst nemoclawTokenCheck = await verifyDeviceToken({",
  "\t\t\t\t...paramsLocal,",
  "\t\t\t\trequiredSharedGatewaySessionGeneration: getRequiredSharedGatewaySessionGeneration?.()",
  "\t\t\t});",
  '\t\t\tconst nemoclawAllowedUpgradeScopes = new Set(["operator.pairing", "operator.read", "operator.write"]);',
  '\t\t\tconst nemoclawScopeUpgradeScopes = Array.isArray(paramsLocal.scopes) ? paramsLocal.scopes.map((scope) => typeof scope === "string" ? scope.trim() : "") : [];',
  "\t\t\tconst nemoclawCliScopeUpgrade =",
  "\t\t\t\t!nemoclawTokenCheck.ok &&",
  '\t\t\t\t(nemoclawTokenCheck.reason === "scope-mismatch" || nemoclawTokenCheck.reason === "scope_mismatch") &&',
  "\t\t\t\tconnectParams.client.id === GATEWAY_CLIENT_IDS.CLI &&",
  "\t\t\t\tconnectParams.client.mode === GATEWAY_CLIENT_MODES.CLI &&",
  '\t\t\t\tparamsLocal.role === "operator" &&',
  "\t\t\t\tnemoclawScopeUpgradeScopes.length > 0 &&",
  "\t\t\t\tnemoclawScopeUpgradeScopes.length === new Set(nemoclawScopeUpgradeScopes).size &&",
  "\t\t\t\tnemoclawScopeUpgradeScopes.every((scope) => scope && nemoclawAllowedUpgradeScopes.has(scope));",
  `\t\t\treturn nemoclawCliScopeUpgrade ? { ...nemoclawTokenCheck, ok: true } : nemoclawTokenCheck; // ${AUTH_SCOPE_UPGRADE_MARKER} (#4462)`,
  "\t\t}",
].join("\n");

export const AUTH_DEVICE_TOKEN_SQLITE_REPLACEMENT =
  AUTH_DEVICE_TOKEN_SQLITE_REPLACEMENT_PREVIOUS.replace(
    'new Set(["operator.pairing", "operator.read", "operator.write"])',
    'new Set(["operator.pairing", "operator.read", "operator.write", "operator.admin"])',
  );

export const AUTH_LOCAL_PAIRING_REPLACEMENT =
  '\t\t\t\t(plan.allowSilentLocalPairing === true || plan.localApproval === "silent") &&';

export const AUTH_INLINE_APPROVAL_REPLACEMENT_PREVIOUS = [
  "\t\t\tconst nemoclawExistingScopes = normalizeSortedUniqueTrimmedStringList(existingPairedDevice ? resolvePairedAccessScopes(existingPairedDevice) : []);",
  "\t\t\tconst nemoclawRequestedScopes = normalizeSortedUniqueTrimmedStringList(scopes);",
  '\t\t\tconst nemoclawAllowedUpgradeScopes = new Set(["operator.pairing", "operator.read", "operator.write"]);',
  "\t\t\tconst nemoclawDeferSilentCliScopeUpgrade =",
  '\t\t\t\treason === "scope-upgrade" &&',
  "\t\t\t\tpairing.request.isRepair === true &&",
  "\t\t\t\tpairing.request.silent === true &&",
  AUTH_LOCAL_PAIRING_REPLACEMENT,
  '\t\t\t\t(authMethod === "device-token" || authMethod === "token") &&',
  "\t\t\t\tconnectParams.client.id === GATEWAY_CLIENT_IDS.CLI &&",
  "\t\t\t\tconnectParams.client.mode === GATEWAY_CLIENT_MODES.CLI &&",
  '\t\t\t\trole === "operator" &&',
  "\t\t\t\texistingPairedDevice?.publicKey === devicePublicKey &&",
  "\t\t\t\tnemoclawExistingScopes.length === 1 &&",
  '\t\t\t\tnemoclawExistingScopes[0] === "operator.pairing" &&',
  "\t\t\t\tArray.isArray(scopes) &&",
  "\t\t\t\tnemoclawRequestedScopes.length > 0 &&",
  "\t\t\t\tnemoclawRequestedScopes.length === scopes.length &&",
  "\t\t\t\tnemoclawRequestedScopes.every((scope) => nemoclawAllowedUpgradeScopes.has(scope));",
  `\t\t\tconst inlineApprovalAttempted = trustedProxyApprovalScopes !== null || pairing.request.silent === true && !nemoclawDeferSilentCliScopeUpgrade; // ${AUTH_DEFER_SILENT_SCOPE_UPGRADE_MARKER} (#9844)`,
].join("\n");

export const AUTH_INLINE_APPROVAL_REPLACEMENT = AUTH_INLINE_APPROVAL_REPLACEMENT_PREVIOUS.replace(
  '\t\t\tconst nemoclawAllowedUpgradeScopes = new Set(["operator.pairing", "operator.read", "operator.write"]);',
  [
    '\t\t\tconst nemoclawAllowedUpgradeScopes = new Set(["operator.pairing", "operator.read", "operator.write"]);',
    '\t\t\tconst nemoclawAllowedAdminUpgradeScopes = new Set([...nemoclawAllowedUpgradeScopes, "operator.admin"]);',
  ].join("\n"),
).replace(
  [
    "\t\t\t\tnemoclawExistingScopes.length === 1 &&",
    '\t\t\t\tnemoclawExistingScopes[0] === "operator.pairing" &&',
    "\t\t\t\tArray.isArray(scopes) &&",
    "\t\t\t\tnemoclawRequestedScopes.length > 0 &&",
    "\t\t\t\tnemoclawRequestedScopes.length === scopes.length &&",
    "\t\t\t\tnemoclawRequestedScopes.every((scope) => nemoclawAllowedUpgradeScopes.has(scope));",
  ].join("\n"),
  [
    "\t\t\t\tArray.isArray(scopes) &&",
    "\t\t\t\tnemoclawRequestedScopes.length > 0 &&",
    "\t\t\t\tnemoclawRequestedScopes.length === scopes.length &&",
    "\t\t\t\t(",
    "\t\t\t\t\t(",
    "\t\t\t\t\t\tnemoclawExistingScopes.length === 1 &&",
    '\t\t\t\t\t\tnemoclawExistingScopes[0] === "operator.pairing" &&',
    "\t\t\t\t\t\tnemoclawRequestedScopes.every((scope) => nemoclawAllowedUpgradeScopes.has(scope))",
    "\t\t\t\t\t) ||",
    "\t\t\t\t\t(",
    '\t\t\t\t\t\tnemoclawExistingScopes.includes("operator.pairing") &&',
    "\t\t\t\t\t\tnemoclawExistingScopes.every((scope) => nemoclawAllowedUpgradeScopes.has(scope)) &&",
    '\t\t\t\t\t\tnemoclawRequestedScopes.includes("operator.admin") &&',
    `\t\t\t\t\t\tnemoclawRequestedScopes.every((scope) => nemoclawAllowedAdminUpgradeScopes.has(scope)) // ${AUTH_REQUIRE_EXPLICIT_ADMIN_UPGRADE_MARKER} (#12064)`,
    "\t\t\t\t\t)",
    "\t\t\t\t);",
  ].join("\n"),
);

export const HANDLER_DEVICE_TOKEN_TARGET =
  '\tconst deviceToken = typeof client?.connect?.auth?.token === "string" ? client.connect.auth.token.trim() : "";';

export const HANDLER_DEVICE_TOKEN_REPLACEMENT = [
  '\tconst explicitDeviceToken = typeof client?.connect?.auth?.deviceToken === "string" ? client.connect.auth.deviceToken.trim() : "";',
  '\tconst deviceToken = explicitDeviceToken || (typeof client?.connect?.auth?.token === "string" ? client.connect.auth.token.trim() : "");',
].join("\n");

export const HANDLER_HELPER = [
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
  HANDLER_DEVICE_TOKEN_REPLACEMENT,
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

export const STATE_HELPER = [
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

export const STATE_SQLITE_PERSISTENCE_TARGET = [
  "\t\tconst kysely = getNodeSqliteKysely(db);",
  '\t\tif (target !== "paired") {',
].join("\n");

export const STATE_SQLITE_PERSISTENCE_REPLACEMENT = [
  "\t\tconst kysely = getNodeSqliteKysely(db);",
  "\t\tconst nemoclawApproval = options?.nemoclawSelfApproval;",
  "\t\tlet nemoclawAuthTransition = null;",
  "\t\tif (nemoclawApproval) {",
  '\t\t\tif (target !== "both") throw new Error("bounded self-approval requires one complete SQLite transaction");',
  "\t\t\tconst nemoclawIdentity = nemoclawApproval.identity;",
  "\t\t\tconst nemoclawRequestId = nemoclawApproval.requestId;",
  '\t\t\tif (!nemoclawIdentity || typeof nemoclawRequestId !== "string" || !nemoclawRequestId.trim() || nemoclawRequestId !== nemoclawRequestId.trim()) throw new Error("invalid bounded self-approval transaction identity");',
  "\t\t\tconst nemoclawPendingRow = db.prepare(`SELECT device_id, public_key, client_id, client_mode FROM device_pairing_pending WHERE request_id = ?`).get(nemoclawRequestId);",
  "\t\t\tconst nemoclawPairedRow = db.prepare(`SELECT public_key, tokens_json FROM device_pairing_paired WHERE device_id = ?`).get(nemoclawIdentity.deviceId);",
  "\t\t\tconst nemoclawAuthRow = db.prepare(`SELECT token, scopes_json FROM device_auth_tokens WHERE device_id = ? AND role = 'operator'`).get(nemoclawIdentity.deviceId);",
  "\t\t\tlet nemoclawPairedTokens;",
  "\t\t\tlet nemoclawAuthScopes;",
  "\t\t\ttry {",
  "\t\t\t\tnemoclawPairedTokens = JSON.parse(nemoclawPairedRow?.tokens_json);",
  "\t\t\t\tnemoclawAuthScopes = JSON.parse(nemoclawAuthRow?.scopes_json);",
  "\t\t\t} catch {}",
  "\t\t\tconst nemoclawBeforeToken = nemoclawPairedTokens?.operator;",
  "\t\t\tconst nemoclawNextDevice = state.pairedByDeviceId[nemoclawIdentity.deviceId];",
  "\t\t\tconst nemoclawNextToken = nemoclawNextDevice?.tokens?.operator;",
  '\t\t\tconst nemoclawNormalizeScopes = (value) => Array.isArray(value) && value.length === new Set(value).size && value.every((scope) => typeof scope === "string" && ["operator.pairing", "operator.read", "operator.write"].includes(scope)) ? [...value].toSorted() : null;',
  "\t\t\tconst nemoclawBeforeScopes = nemoclawNormalizeScopes(nemoclawBeforeToken?.scopes);",
  "\t\t\tconst nemoclawStoredScopes = nemoclawNormalizeScopes(nemoclawAuthScopes);",
  "\t\t\tconst nemoclawAfterScopes = nemoclawNormalizeScopes(nemoclawNextToken?.scopes);",
  "\t\t\tif (",
  "\t\t\t\tnemoclawPendingRow?.device_id !== nemoclawIdentity.deviceId ||",
  "\t\t\t\tnemoclawPendingRow.public_key !== nemoclawIdentity.publicKey ||",
  "\t\t\t\tnemoclawPendingRow.client_id !== nemoclawIdentity.clientId ||",
  "\t\t\t\tnemoclawPendingRow.client_mode !== nemoclawIdentity.clientMode ||",
  "\t\t\t\tnemoclawPairedRow?.public_key !== nemoclawIdentity.publicKey ||",
  '\t\t\t\tnemoclawBeforeToken?.role !== "operator" ||',
  "\t\t\t\tnemoclawBeforeToken.token !== nemoclawIdentity.deviceToken ||",
  "\t\t\t\tnemoclawAuthRow?.token !== nemoclawIdentity.deviceToken ||",
  // A read grant can precede the CLI write request (#13100).
  '\t\t\t\t!(JSON.stringify(nemoclawBeforeScopes) === JSON.stringify(["operator.pairing"]) || JSON.stringify(nemoclawBeforeScopes) === JSON.stringify(["operator.pairing", "operator.read"])) ||',
  "\t\t\t\tJSON.stringify(nemoclawStoredScopes) !== JSON.stringify(nemoclawBeforeScopes) ||",
  "\t\t\t\tnemoclawNextDevice?.publicKey !== nemoclawIdentity.publicKey ||",
  '\t\t\t\tnemoclawNextToken?.role !== "operator" ||',
  '\t\t\t\ttypeof nemoclawNextToken.token !== "string" ||',
  "\t\t\t\t!nemoclawNextToken.token ||",
  "\t\t\t\tnemoclawNextToken.token === nemoclawIdentity.deviceToken ||",
  '\t\t\t\tJSON.stringify(nemoclawAfterScopes) !== JSON.stringify(["operator.pairing", "operator.read", "operator.write"])',
  '\t\t\t) throw new Error("bounded self-approval SQLite state changed before publication");',
  "\t\t\tnemoclawAuthTransition = { deviceId: nemoclawIdentity.deviceId, beforeToken: nemoclawIdentity.deviceToken, afterToken: nemoclawNextToken.token, scopes: nemoclawNextToken.scopes };",
  `\t\t} // ${STATE_TRANSACTION_MARKER} (#4462)`,
  '\t\tif (target !== "paired") {',
].join("\n");

export const STATE_SQLITE_AUTH_UPDATE_TARGET = [
  "\t\tfor (const nodeId of new Set(options?.clearApnsNodeIds ?? [])) clearApnsRegistrationFromDatabase(db, nodeId);",
].join("\n");

export const STATE_SQLITE_AUTH_UPDATE_REPLACEMENT = [
  "\t\tif (nemoclawAuthTransition) {",
  "\t\t\tconst nemoclawUpdatedAtMs = Date.now();",
  "\t\t\tconst nemoclawUpdate = db.prepare(`UPDATE device_auth_tokens SET token = ?, scopes_json = ?, updated_at_ms = ? WHERE device_id = ? AND role = 'operator' AND token = ?`).run(nemoclawAuthTransition.afterToken, JSON.stringify(nemoclawAuthTransition.scopes), nemoclawUpdatedAtMs, nemoclawAuthTransition.deviceId, nemoclawAuthTransition.beforeToken);",
  '\t\t\tif (nemoclawUpdate.changes !== 1) throw new Error("bounded self-approval stored-auth fence failed");',
  "\t\t\tconst nemoclawOriginRows = db.prepare(`SELECT token FROM gateway_origin_device_tokens WHERE device_id = ? AND role = 'operator'`).all(nemoclawAuthTransition.deviceId);",
  '\t\t\tif (nemoclawOriginRows.some((row) => row.token !== nemoclawAuthTransition.beforeToken)) throw new Error("bounded self-approval origin-auth precondition failed");',
  "\t\t\tconst nemoclawOriginUpdate = db.prepare(`UPDATE gateway_origin_device_tokens SET token = ?, scopes_json = ?, updated_at_ms = ? WHERE device_id = ? AND role = 'operator' AND token = ?`).run(nemoclawAuthTransition.afterToken, JSON.stringify(nemoclawAuthTransition.scopes), nemoclawUpdatedAtMs, nemoclawAuthTransition.deviceId, nemoclawAuthTransition.beforeToken);",
  '\t\t\tif (nemoclawOriginUpdate.changes !== nemoclawOriginRows.length) throw new Error("bounded self-approval origin-auth fence failed");',
  "\t\t}",
  "\t\tfor (const nodeId of new Set(options?.clearApnsNodeIds ?? [])) clearApnsRegistrationFromDatabase(db, nodeId);",
].join("\n");

export const ASYNC_IDENTITY_TARGET =
  'async function resolveDeviceIdentityForGatewayCall(sharedStateMode) {\n\ttry {\n\t\treturn sharedStateMode === "read-only" ? await loadDeviceIdentityIfPresentAsync() : await loadOrCreateDeviceIdentityAsync();\n\t} catch (cause) {\n\t\tthrow new Error("Cannot load device identity. Check access to your OpenClaw state directory and run \\"openclaw doctor --fix\\", then retry.", { cause });\n\t}\n}';

export const ASYNC_IDENTITY_REPLACEMENT =
  CALL_IDENTITY_RESOLVER_SQLITE_REPLACEMENT.slice(
    0,
    CALL_IDENTITY_RESOLVER_SQLITE_REPLACEMENT.indexOf(
      "\tif (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING",
    ),
  ).replace(
    "function resolveDeviceIdentityForGatewayCall(sharedStateMode)",
    "async function resolveDeviceIdentityForGatewayCall(sharedStateMode)",
  ) +
  '\tif (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1") return await loadOrCreateDeviceIdentityAsync();\n' +
  ASYNC_IDENTITY_TARGET.slice(ASYNC_IDENTITY_TARGET.indexOf("\ttry {"));

export const ASYNC_CALL_PAIRS = [
  [
    CALL_STORED_IDENTITY_TARGET,
    [
      '\tconst nemoclawForceIdentity = process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1" || process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1";',
      "\tconst isLocalCliSharedAuth = !nemoclawForceIdentity && mode === GATEWAY_CLIENT_MODES.CLI && clientName === GATEWAY_CLIENT_NAMES.CLI && hasSharedSecretAuth && isLoopback && !(await loadStoredOperatorDeviceAuthToken(await resolveDeviceIdentityForGatewayCall(opts.sharedStateMode), params.deviceAuthScope, opts.sharedStateMode));",
      `\t// ${CALL_STORED_IDENTITY_MARKER}`,
    ].join("\n"),
  ],
  [
    "\tconst omitDeviceIdentity = isLocalBackendSharedAuth || isLocalCliSharedAuth;",
    `\tconst omitDeviceIdentity = !nemoclawForceIdentity && (isLocalBackendSharedAuth || isLocalCliSharedAuth); // ${CALL_FORCE_IDENTITY_MARKER}`,
  ],
  [
    "\t\tdeviceIdentity: opts.deviceIdentity === void 0 ? omitDeviceIdentity ? null : await resolveDeviceIdentityForGatewayCall(opts.sharedStateMode) : opts.deviceIdentity",
    "\t\tdeviceIdentity: nemoclawForceIdentity ? await resolveDeviceIdentityForGatewayCall(opts.sharedStateMode) : opts.deviceIdentity === void 0 ? omitDeviceIdentity ? null : await resolveDeviceIdentityForGatewayCall(opts.sharedStateMode) : opts.deviceIdentity",
  ],
  [
    "\t\tisImplicitLocalTarget: !urlOverrideSource && !context.isRemoteMode,\n\t\ttoken,\n\t\tpassword\n\t});",
    "\t\tisImplicitLocalTarget: !urlOverrideSource && !context.isRemoteMode,\n\t\ttoken,\n\t\tpassword,\n\t\tdeviceAuthScope\n\t});",
  ],
] as const;

export const AUTH_INLINE_APPROVAL_105_TARGET =
  '\t\t\tconst inlineApprovalAttempted = trustedProxyApprovalScopes !== null || pairing.request.silent === true || role === "node" && reason === "role-upgrade" && plan.localApproval === "silent";';

export const AUTH_INLINE_APPROVAL_105_REPLACEMENT = AUTH_INLINE_APPROVAL_REPLACEMENT.replace(
  "pairing.request.silent === true && !nemoclawDeferSilentCliScopeUpgrade;",
  'pairing.request.silent === true && !nemoclawDeferSilentCliScopeUpgrade || role === "node" && reason === "role-upgrade" && plan.localApproval === "silent";',
);

const ASYNC_GATEWAY_AUTH_TARGET =
  'async function resolveGatewayCallDeviceAuth(params) {\n\tconst { opts } = params;\n\tconst isLoopback = isLoopbackGatewayUrl(params.url);\n\tconst clientOptions = {\n\t\tclientName: opts.clientName,\n\t\tmode: opts.mode,\n\t\trequireLocalBackendSharedAuth: opts.requireLocalBackendSharedAuth\n\t};\n\tif (opts.allowLocalBackendAuthNone && params.authMode === "none" && params.isImplicitLocalTarget && isLoopback && opts.clientName === GATEWAY_CLIENT_NAMES.CLI && opts.mode === GATEWAY_CLIENT_MODES.CLI && opts.deviceIdentity === void 0 && !opts.useStoredDeviceAuth && !opts.preparedDeviceAuth && !opts.approvalRuntimeToken && !opts.agentRuntimeIdentityToken) {\n\t\tclientOptions.clientName = GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT;\n\t\tclientOptions.mode = GATEWAY_CLIENT_MODES.BACKEND;\n\t\tclientOptions.requireLocalBackendSharedAuth = true;\n\t}\n\tconst mode = clientOptions.mode ?? GATEWAY_CLIENT_MODES.CLI;\n\tconst clientName = clientOptions.clientName ?? GATEWAY_CLIENT_NAMES.CLI;\n\tconst allowAuthNone = clientOptions.requireLocalBackendSharedAuth === true && params.authMode === "none";\n\tconst hasSharedSecretAuth = params.authMode === "token" && Boolean(params.token) || params.authMode === "password" && Boolean(params.password);\n\tconst isLocalBackendSharedAuth = mode === GATEWAY_CLIENT_MODES.BACKEND && clientName === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT && (hasSharedSecretAuth || allowAuthNone) && isLoopback;\n\tconst isLocalCliSharedAuth = mode === GATEWAY_CLIENT_MODES.CLI && clientName === GATEWAY_CLIENT_NAMES.CLI && hasSharedSecretAuth && isLoopback;\n\tconst omitDeviceIdentity = isLocalBackendSharedAuth || isLocalCliSharedAuth;\n\tif (clientOptions.requireLocalBackendSharedAuth && !omitDeviceIdentity) throw new GatewayLocalBackendSharedAuthUnavailableError("local backend shared auth requires a loopback gateway with token/password credentials or auth mode none");\n\treturn {\n\t\tclientOptions,\n\t\tomitDeviceIdentity,\n\t\tdeviceIdentity: opts.deviceIdentity === void 0 ? omitDeviceIdentity ? null : await resolveDeviceIdentityForGatewayCall(opts.sharedStateMode) : opts.deviceIdentity\n\t};\n}';
export const ASYNC_GATEWAY_AUTH_REPLACEMENT = ASYNC_CALL_PAIRS.slice(0, 3).reduce(
  (source, [target, replacement]) => source.replace(target, replacement),
  ASYNC_GATEWAY_AUTH_TARGET,
);
