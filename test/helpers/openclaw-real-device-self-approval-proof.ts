// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildAutoPairApprovalScript,
  parseAutoPairApprovalReceipt,
  readAutoPairApprovalPolicyModule,
  runPortableOpenClawPairingRequestProducer,
} from "../../src/lib/actions/sandbox/auto-pair-approval";
import { settlePortableOpenClawPairing } from "../../src/lib/actions/sandbox/launch-readiness";
import {
  buildOpenClawPairingObservationScript,
  observeOpenClawPairingRepairSettlement,
  observeOpenClawPairingSettlement,
  parseOpenClawPairingRepairObservation,
  parseOpenClawPairingSettlementObservation,
} from "../../src/lib/actions/sandbox/launch-readiness/openclaw-pairing-qualification";
import {
  CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  CONNECT_AUTO_PAIR_MAX_APPROVALS,
  CONNECT_AUTO_PAIR_TIMEOUT_MS,
} from "../../src/lib/actions/sandbox/connect-autopair-budget";
import { resolveGatewayName } from "../../src/lib/onboard/gateway-binding";

interface ProofOptions {
  dist: string;
  nodeExecutable: string;
  patchScript: string;
  timeoutMs: number;
  tmp: string;
  version: string;
}

function requireSuccess(
  result: { status: number | null; stdout?: string | null; stderr?: string | null },
  label: string,
): void {
  if (result.status === 0) return;
  const detail = String(result.stderr || result.stdout || "").trim();
  throw new Error(`${label}${detail ? `: ${detail}` : ""}: expected exit 0, got ${result.status}`);
}

function requireIncludes(actual: string | null, expected: string, label: string): void {
  if (String(actual ?? "").includes(expected)) return;
  throw new Error(`${label}: expected output containing ${expected}`);
}

interface DistSource {
  file: string;
  source: string;
}

function requireExactlyOneDistSource(
  sources: DistSource[],
  label: string,
  markers: string[],
): DistSource {
  const matches = sources.filter(({ source }) =>
    markers.every((marker) => source.includes(marker)),
  );
  if (matches.length !== 1) {
    throw new Error(
      `${label}: expected exactly one matching real-dist file, found ${matches.length}`,
    );
  }
  return matches[0] as DistSource;
}

function readDistSources(dist: string): DistSource[] {
  return fs
    .readdirSync(dist, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => {
      const file = path.join(dist, entry.name);
      return { file, source: fs.readFileSync(file, "utf8") };
    });
}

function requireOrderedMarkers(source: string, markers: string[], label: string): void {
  let offset = 0;
  for (const marker of markers) {
    const index = source.indexOf(marker, offset);
    if (index < 0) throw new Error(`${label}: expected ordered marker ${marker}`);
    offset = index + marker.length;
  }
}

function requireRealDeviceTokenAuthLinkage(sources: DistSource[]): string {
  const producer = requireExactlyOneDistSource(sources, "device-token session producer", [
    "const nextClient = {",
    'isDeviceTokenAuth: authMethod === "device-token"',
    "if (!setClient(nextClient))",
    "await handleGatewayRequest({",
  ]);
  const dispatcher = requireExactlyOneDistSource(sources, "gateway request dispatcher", [
    "async function handleGatewayRequest(opts)",
    "const loadDeviceHandlers = lazyHandlerModule",
    '"device.pair.approve"',
  ]);
  const handler = requireExactlyOneDistSource(sources, "device pairing gateway handler", [
    '"device.pair.approve": async',
    "resolveDeviceSessionAuthz(client)",
    "nemoclaw: bounded same-device scope approval",
  ]);
  const resolver = requireExactlyOneDistSource(sources, "canonical device-session authz resolver", [
    "function resolveDeviceSessionAuthz(client)",
    "callerDeviceId: client?.isDeviceTokenAuth",
  ]);

  requireOrderedMarkers(
    producer.source,
    [
      "const client = getClient();",
      "const nextClient = {",
      'isDeviceTokenAuth: authMethod === "device-token"',
      "if (!setClient(nextClient))",
      `await import("./${path.basename(dispatcher.file)}")`,
      "await handleGatewayRequest({",
      "client,",
    ],
    "device-token producer-to-dispatcher linkage",
  );
  requireOrderedMarkers(
    dispatcher.source,
    [
      `import("./${path.basename(handler.file)}")`,
      '"device.pair.approve"',
      "loadHandlers: loadDeviceHandlers",
      "async function handleGatewayRequest(opts)",
      "const invokeHandler = () => handler({",
      "client,",
    ],
    "dispatcher-to-device-handler linkage",
  );
  requireOrderedMarkers(
    handler.source,
    [
      `from "./${path.basename(resolver.file)}"`,
      '"device.pair.approve": async',
      "const authz = resolveDeviceSessionAuthz(client);",
      "nemoclawSelfApprovalIdentity = resolveNemoClawSelfApprovalIdentity(pending, authz, client);",
      "approveDevicePairing(requestId, { callerScopes: authz.callerScopes, nemoclawSelfApprovalIdentity })",
    ],
    "device-handler-to-authz-resolver linkage",
  );
  requireOrderedMarkers(
    resolver.source,
    [
      "function resolveDeviceSessionAuthz(client)",
      "const rawCallerDeviceId = client?.connect?.device?.id;",
      'callerDeviceId: client?.isDeviceTokenAuth && typeof rawCallerDeviceId === "string"',
      "resolveDeviceSessionAuthz as",
    ],
    "canonical device-token authz linkage",
  );
  return handler.file;
}

function requireRealStoredDeviceAuthLinkage(sources: DistSource[], cliSource: DistSource): void {
  const gatewayCall = requireExactlyOneDistSource(sources, "stored device-auth gateway call", [
    "const useStoredDeviceAuth = opts.useStoredDeviceAuth === true;",
    "const storedAuth = loadStoredOperatorDeviceAuthToken(deviceIdentity);",
    "opts.requiredStoredDeviceAuthScopes",
    "scopes: useStoredDeviceAuth ? void 0 : scopes",
  ]);
  const gatewayHandshake = requireExactlyOneDistSource(
    sources,
    "shared-auth paired-device scope enforcement",
    [
      "async function resolveConnectAuthDecisionCore(params)",
      "if (!params.hasDeviceIdentity || !params.deviceId || authOk || !deviceTokenCandidate) return finish();",
      "if (device && devicePublicKey) {",
      'if (!await requirePairing("scope-upgrade", paired)) return;',
    ],
  );
  requireOrderedMarkers(
    gatewayCall.source,
    [
      "function shouldOmitDeviceIdentityForGatewayCall(params)",
      "NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING",
      "nemoclaw: force device identity for loopback pairing bootstrap",
      "const mode = params.opts.mode",
      "const isLocalCliSharedAuth =",
      "!hasStoredOperatorDeviceAuthToken(resolveDeviceIdentityForGatewayCall())",
      "nemoclaw: retain stored CLI device identity for loopback shared-token scope enforcement",
      "return isLocalBackendSharedAuth || isLocalCliSharedAuth;",
    ],
    "loopback CLI shared-token stored device identity",
  );
  requireOrderedMarkers(
    gatewayHandshake.source,
    [
      "async function resolveConnectAuthDecisionCore(params)",
      "let authOk = params.state.authOk;",
      "if (!params.hasDeviceIdentity || !params.deviceId || authOk || !deviceTokenCandidate) return finish();",
      "if (device && devicePublicKey) {",
      "const paired = await getPairedDevice(device.id);",
      "const pairedScopes = resolvePairedAccessScopes(paired);",
      "if (scopes.length > 0) {",
      "requestedScopes: scopes,",
      "allowedScopes: pairedScopes",
      'if (!await requirePairing("scope-upgrade", paired)) return;',
    ],
    "shared-token identity to paired-scope upgrade linkage",
  );
  requireOrderedMarkers(
    gatewayCall.source,
    [
      "const useStoredDeviceAuth = opts.useStoredDeviceAuth === true;",
      "const resolvedCredentials = useStoredDeviceAuth ? {} : await resolveGatewayCredentials(context);",
      "const storedAuth = loadStoredOperatorDeviceAuthToken(deviceIdentity);",
      "opts.requiredStoredDeviceAuthScopes",
      "scopes: useStoredDeviceAuth ? void 0 : scopes",
    ],
    "stored device-auth credential selection",
  );
  requireOrderedMarkers(
    gatewayCall.source,
    [
      "deviceIdentity,",
      "opts.nemoclawDisableStoredDeviceAuth === true",
      "hostDeps:",
      "loadDeviceAuthToken: () => null",
      "storeDeviceAuthToken: () => {}",
      "clearDeviceAuthToken: () => {}",
      "minProtocol:",
    ],
    "forced paired-token pathname auth bypass",
  );
  requireOrderedMarkers(
    cliSource.source,
    [
      `from "./${path.basename(gatewayCall.file)}"`,
      "const callGatewayCli = async",
      "callOpts?.usePairedToken === true",
      "url: callOpts.pinnedGatewayUrl",
      "token: callOpts.pairedToken",
      "password: void 0",
      "nemoclawDisableStoredDeviceAuth: true",
      "callOpts?.useStoredDeviceAuth === true",
      "nemoclaw: forward stored device auth for bounded same-device scope approval",
      "requiredStoredDeviceAuthScopes: callOpts.requiredStoredDeviceAuthScopes",
    ],
    "devices CLI stored-auth bridge",
  );
  requireOrderedMarkers(
    cliSource.source,
    [
      "async function listPairingWithFallback(opts, callOpts)",
      "nemoclaw: preflight bounded stored device auth before live pairing list",
      "NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT",
      "useStoredDeviceAuth: true",
      "requiredStoredDeviceAuthScopes: [PAIRING_SCOPE]",
      "nemoclaw: use stored device auth for pairing settlement list",
      "callOpts ??= nemoclawSettlementListCallOpts",
      'callGatewayCli("device.pair.list", opts, {}, callOpts)',
      "const nemoclawLocalList = nemoclawPairedTokenRequested ? readNemoClawPinnedPairingSnapshot() : await listDevicePairing();",
      "nemoclawLocalStoredAuthCandidate = !nemoclawPairedTokenRequested && nemoclawLocalContext.useStoredDeviceAuth;",
      "const nemoclawListCallOpts = nemoclawLocalStoredAuthCandidate ?",
      ": await listPairingWithFallback(opts, nemoclawListCallOpts);",
      "nemoclawRefuseUnsafeApproval",
    ],
    "devices CLI bounded pairing-list preflight",
  );
  requireOrderedMarkers(
    cliSource.source,
    [
      "async function resolveApprovePairingGatewayContext(opts, requestId)",
      "nemoclawPairedTokenRequested",
      "nemoclawLocalPairedTokenContext",
      "nemoclawHasTransportOrCredentialOverride",
      "nemoclawLocalContext.pairedDeviceToken",
      "nemoclawLocalPairedToken = nemoclawLocalContext.pairedDeviceToken",
      "nemoclaw: preflight bounded paired token before live pairing list",
      "nemoclawUsePairedToken",
      "nemoclawRefuseUnsafeApproval",
    ],
    "devices CLI bounded paired-token preflight",
  );
  requireOrderedMarkers(
    cliSource.source,
    [
      "async function approvePairingWithFallback(opts, requestId)",
      "nemoclawUseStoredDeviceAuth",
      "nemoclawUsePairedToken",
      "nemoclawUsePairedToken ? { scopes: [PAIRING_SCOPE], usePairedToken: true",
      "nemoclaw: select stored device auth for bounded same-device scope approval",
      "requiredStoredDeviceAuthScopes: [PAIRING_SCOPE]",
      "if (nemoclawUseStoredDeviceAuth || nemoclawUsePairedToken) throw error;",
      "nemoclaw: keep bounded device auth fail closed",
    ],
    "devices CLI bounded device-auth selection",
  );
}

function failLiveProof(message: string): never {
  throw new Error(message);
}

function requireLiveProof(value: unknown, message: string): asserts value {
  value || failLiveProof(message);
}

function readJsonObject(file: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  requireLiveProof(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label}: expected a JSON object`,
  );
  return value as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireOperatorToken(
  container: Record<string, unknown> | null,
  label: string,
): Record<string, unknown> {
  requireLiveProof(container, `${label}: missing token container`);
  const tokens = asRecord(container.tokens);
  requireLiveProof(tokens, `${label}: missing role-keyed tokens`);
  const operator = asRecord(tokens.operator);
  requireLiveProof(operator, `${label}: missing operator token`);
  return operator;
}

function requireExactScopes(value: unknown, expected: string[], label: string): void {
  const raw = Array.isArray(value) ? value : [];
  const actual = raw.filter((entry): entry is string => typeof entry === "string").sort();
  requireLiveProof(
    actual.length === raw.length &&
      new Set(actual).size === actual.length &&
      JSON.stringify(actual) === JSON.stringify([...expected].sort()),
    `${label}: expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
  );
}

type PairingStateSide = "auth" | "pending" | "paired";

interface PairingTransactionFixture {
  authPath: string;
  beforeAuth: Record<string, unknown>;
  beforePaired: Record<string, unknown>;
  beforePending: Record<string, unknown>;
  deviceId: string;
  journalPath: string;
  pairedPath: string;
  pendingPath: string;
  publicKey: string;
  requestId: string;
  stateDir: string;
}

interface PreparedPairingJournal {
  afterAuth: Record<string, unknown>;
  afterPaired: Record<string, unknown>;
  afterPending: Record<string, unknown>;
  beforeAuth: Record<string, unknown>;
  beforePaired: Record<string, unknown>;
  beforePending: Record<string, unknown>;
}

function requireJsonEqual(actual: unknown, expected: unknown, label: string): void {
  requireLiveProof(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: JSON state did not match`,
  );
}

function requireOnlyAuthenticationAuditChanges(
  beforeSerialized: string,
  afterState: Record<string, unknown>,
  deviceId: string,
  label: string,
): void {
  const beforeState = asRecord(JSON.parse(beforeSerialized) as unknown);
  const normalizedAfterState = asRecord(JSON.parse(JSON.stringify(afterState)) as unknown);
  const beforeDevice = asRecord(beforeState?.[deviceId]);
  const afterDevice = asRecord(normalizedAfterState?.[deviceId]);
  const beforeOperator = asRecord(asRecord(beforeDevice?.tokens)?.operator);
  const afterOperator = asRecord(asRecord(afterDevice?.tokens)?.operator);
  requireLiveProof(
    beforeState &&
      normalizedAfterState &&
      beforeDevice &&
      afterDevice &&
      beforeOperator &&
      afterOperator,
    `${label}: paired authentication state shape changed`,
  );
  const deviceActivityChanged =
    afterDevice.lastSeenAtMs !== beforeDevice.lastSeenAtMs ||
    afterDevice.lastSeenReason !== beforeDevice.lastSeenReason;
  requireLiveProof(
    !deviceActivityChanged ||
      ((afterDevice.lastSeenReason === "device-token-auth" ||
        afterDevice.lastSeenReason === "connect") &&
        typeof afterDevice.lastSeenAtMs === "number"),
    `${label}: invalid device authentication activity`,
  );
  const tokenActivityChanged = afterOperator.lastUsedAtMs !== beforeOperator.lastUsedAtMs;
  requireLiveProof(
    !tokenActivityChanged || typeof afterOperator.lastUsedAtMs === "number",
    `${label}: invalid token authentication activity`,
  );
  afterDevice.lastSeenAtMs = beforeDevice.lastSeenAtMs;
  afterDevice.lastSeenReason = beforeDevice.lastSeenReason;
  afterOperator.lastUsedAtMs = beforeOperator.lastUsedAtMs;
  requireJsonEqual(normalizedAfterState, beforeState, `${label}: authorization state`);
}

function requireExactObjectKeys(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  requireLiveProof(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label}: object keys did not match`,
  );
}

function requireIdlePairingJournal(journalPath: string, label: string): void {
  const journal = readJsonObject(journalPath, label);
  requireExactObjectKeys(journal, ["version", "kind", "phase"], label);
  requireLiveProof(
    journal.version === 2 && journal.kind === "nemoclaw-self-approval" && journal.phase === "idle",
    `${label}: expected an idle v2 self-approval journal`,
  );
}

function requirePreparedPairingJournal(
  fixture: PairingTransactionFixture,
  label: string,
): PreparedPairingJournal {
  const journal = readJsonObject(fixture.journalPath, label);
  requireExactObjectKeys(
    journal,
    ["version", "kind", "phase", "requestId", "deviceId", "before", "after"],
    label,
  );
  requireLiveProof(
    journal.version === 2 &&
      journal.kind === "nemoclaw-self-approval" &&
      journal.phase === "prepared" &&
      journal.requestId === fixture.requestId &&
      journal.deviceId === fixture.deviceId,
    `${label}: expected the exact prepared self-approval transaction`,
  );
  const before = asRecord(journal.before);
  const after = asRecord(journal.after);
  requireLiveProof(before && after, `${label}: before/after snapshots missing`);
  requireExactObjectKeys(before, ["auth", "pendingById", "pairedByDeviceId"], `${label} before`);
  requireExactObjectKeys(after, ["auth", "pendingById", "pairedByDeviceId"], `${label} after`);
  const beforeAuth = asRecord(before.auth);
  const beforePending = asRecord(before.pendingById);
  const beforePaired = asRecord(before.pairedByDeviceId);
  const afterAuth = asRecord(after.auth);
  const afterPending = asRecord(after.pendingById);
  const afterPaired = asRecord(after.pairedByDeviceId);
  requireLiveProof(
    beforeAuth && beforePending && beforePaired && afterAuth && afterPending && afterPaired,
    `${label}: state snapshots must be plain records`,
  );
  requireJsonEqual(beforeAuth, fixture.beforeAuth, `${label} auth before-image`);
  requireJsonEqual(beforePending, fixture.beforePending, `${label} pending before-image`);
  requireJsonEqual(beforePaired, fixture.beforePaired, `${label} paired before-image`);
  requireLiveProof(
    !(fixture.requestId in afterPending),
    `${label}: pending after-image retained the approved request`,
  );
  const pairedAfter = asRecord(afterPaired[fixture.deviceId]);
  requireLiveProof(
    pairedAfter?.deviceId === fixture.deviceId && pairedAfter.publicKey === fixture.publicKey,
    `${label}: paired after-image identity changed`,
  );
  const operatorAfter = requireOperatorToken(pairedAfter, `${label} paired after-image`);
  const authOperatorAfter = requireOperatorToken(afterAuth, `${label} auth after-image`);
  const pairedBefore = asRecord(fixture.beforePaired[fixture.deviceId]);
  requireLiveProof(pairedBefore, `${label}: paired before-image device missing`);
  const operatorBefore = requireOperatorToken(pairedBefore, `${label} paired before-image`);
  requireLiveProof(
    typeof operatorAfter.token === "string" &&
      operatorAfter.token.length > 0 &&
      operatorAfter.token !== operatorBefore.token,
    `${label}: paired after-image did not rotate the operator token`,
  );
  requireExactScopes(
    operatorAfter.scopes,
    ["operator.pairing", "operator.read", "operator.write"],
    `${label} paired after-image operator scopes`,
  );
  requireLiveProof(
    afterAuth.deviceId === fixture.deviceId && authOperatorAfter.token === operatorAfter.token,
    `${label}: stored auth after-image did not match paired state`,
  );
  requireExactScopes(
    authOperatorAfter.scopes,
    ["operator.pairing", "operator.read", "operator.write"],
    `${label} auth after-image operator scopes`,
  );
  requireJsonEqual(
    afterPending.unrelated,
    fixture.beforePending.unrelated,
    `${label} unrelated pending after-image`,
  );
  requireJsonEqual(
    afterPaired["unrelated-device"],
    fixture.beforePaired["unrelated-device"],
    `${label} unrelated paired after-image`,
  );
  return { beforeAuth, beforePending, beforePaired, afterAuth, afterPending, afterPaired };
}

function requirePairingState(
  fixture: PairingTransactionFixture,
  expectedPending: Record<string, unknown>,
  expectedPaired: Record<string, unknown>,
  label: string,
): void {
  requireJsonEqual(readJsonObject(fixture.pendingPath, `${label} pending`), expectedPending, label);
  requireJsonEqual(readJsonObject(fixture.pairedPath, `${label} paired`), expectedPaired, label);
}

function requirePairingAuthState(
  fixture: PairingTransactionFixture,
  expectedAuth: Record<string, unknown>,
  label: string,
): void {
  requireJsonEqual(readJsonObject(fixture.authPath, `${label} auth`), expectedAuth, label);
}

function createPairingTransactionFixture(
  tmp: string,
  label: string,
  journalBasename: string,
): PairingTransactionFixture {
  const stateDir = path.join(tmp, `device-approval-transaction-${label}`);
  const devicesDir = path.join(stateDir, "devices");
  const identityDir = path.join(stateDir, "identity");
  fs.rmSync(stateDir, { force: true, recursive: true });
  fs.mkdirSync(devicesDir, { recursive: true });
  fs.mkdirSync(identityDir, { recursive: true });
  const requestId = `transaction-request-${label}`;
  const deviceId = `transaction-device-${label}`;
  const publicKey = `transaction-public-key-${label}`;
  const now = Date.now();
  const beforePending = {
    [requestId]: {
      requestId,
      deviceId,
      publicKey,
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.write"],
      isRepair: true,
      ts: now,
    },
    unrelated: {
      requestId: "unrelated",
      deviceId: "unrelated-device",
      publicKey: "unrelated-public-key",
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.pairing"],
      ts: now,
    },
  };
  const pairedDevice = (id: string, key: string, token: string) => ({
    deviceId: id,
    publicKey: key,
    clientId: "cli",
    clientMode: "cli",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.pairing"],
    approvedScopes: ["operator.pairing"],
    tokens: {
      operator: {
        token,
        role: "operator",
        scopes: ["operator.pairing"],
        createdAtMs: now,
      },
    },
    createdAtMs: now,
    approvedAtMs: now,
  });
  const beforePaired = {
    [deviceId]: pairedDevice(deviceId, publicKey, `baseline-token-${label}`),
    "unrelated-device": pairedDevice(
      "unrelated-device",
      "unrelated-public-key",
      `unrelated-token-${label}`,
    ),
  };
  const pendingPath = path.join(devicesDir, "pending.json");
  const pairedPath = path.join(devicesDir, "paired.json");
  const authPath = path.join(identityDir, "device-auth.json");
  const beforeAuth = {
    version: 1,
    deviceId,
    tokens: {
      operator: {
        token: `baseline-token-${label}`,
        role: "operator",
        scopes: ["operator.pairing"],
        updatedAtMs: now,
      },
    },
  };
  fs.writeFileSync(pendingPath, JSON.stringify(beforePending));
  fs.writeFileSync(pairedPath, JSON.stringify(beforePaired));
  fs.writeFileSync(authPath, JSON.stringify(beforeAuth));
  return {
    authPath,
    beforeAuth,
    beforePaired,
    beforePending,
    deviceId,
    journalPath: path.join(devicesDir, journalBasename),
    pairedPath,
    pendingPath,
    publicKey,
    requestId,
    stateDir,
  };
}

function discoverSelfApprovalJournalBasename(source: string): string {
  const candidates = [...source.matchAll(/["']([^"']*nemoclaw-self-approval-journal)["']/g)].map(
    (match) => match[1] as string,
  );
  const suffixes = [
    ...new Set(candidates.filter((candidate) => /^\.[a-z0-9.-]+$/.test(candidate))),
  ];
  requireLiveProof(
    suffixes.length === 1,
    `self-approval journal contract: expected one safe suffix literal, found ${suffixes.length}`,
  );
  return `pending.json${suffixes[0]}`;
}

function requireCompletedPairingApproval(fixture: PairingTransactionFixture, label: string): void {
  const pending = readJsonObject(fixture.pendingPath, `${label} pending`);
  const paired = readJsonObject(fixture.pairedPath, `${label} paired`);
  requireExactObjectKeys(pending, ["unrelated"], `${label} pending`);
  requireExactObjectKeys(paired, [fixture.deviceId, "unrelated-device"], `${label} paired`);
  requireJsonEqual(
    pending.unrelated,
    fixture.beforePending.unrelated,
    `${label} unrelated pending request`,
  );
  requireJsonEqual(
    paired["unrelated-device"],
    fixture.beforePaired["unrelated-device"],
    `${label} unrelated paired device`,
  );
  const pairedAfter = asRecord(paired[fixture.deviceId]);
  const pairedBefore = asRecord(fixture.beforePaired[fixture.deviceId]);
  requireLiveProof(
    pairedAfter?.deviceId === fixture.deviceId &&
      pairedAfter.publicKey === fixture.publicKey &&
      pairedBefore,
    `${label}: approved device identity changed`,
  );
  const operatorAfter = requireOperatorToken(pairedAfter, `${label} approved device`);
  const authAfter = readJsonObject(fixture.authPath, `${label} stored auth`);
  const authOperatorAfter = requireOperatorToken(authAfter, `${label} stored auth`);
  const operatorBefore = requireOperatorToken(pairedBefore, `${label} baseline device`);
  requireLiveProof(
    typeof operatorAfter.token === "string" &&
      operatorAfter.token.length > 0 &&
      operatorAfter.token !== operatorBefore.token,
    `${label}: approval did not rotate the operator token`,
  );
  requireExactScopes(
    operatorAfter.scopes,
    ["operator.pairing", "operator.read", "operator.write"],
    `${label} approved operator scopes`,
  );
  requireLiveProof(
    authAfter.deviceId === fixture.deviceId && authOperatorAfter.token === operatorAfter.token,
    `${label}: stored auth did not match the approved paired token`,
  );
  requireExactScopes(
    authOperatorAfter.scopes,
    ["operator.pairing", "operator.read", "operator.write"],
    `${label} stored auth scopes`,
  );
  requireIdlePairingJournal(fixture.journalPath, `${label} journal`);
}

function runPairingCrashDirectionProof(
  options: ProofOptions,
  deviceBootstrapUrl: string,
  journalBasename: string,
  durableSide: PairingStateSide,
): void {
  const fixture = createPairingTransactionFixture(
    options.tmp,
    `crash-${durableSide}`,
    journalBasename,
  );
  const statePaths = {
    auth: fixture.authPath,
    paired: fixture.pairedPath,
    pending: fixture.pendingPath,
  };
  const durablePath = statePaths[durableSide];
  const interruptedSide = durableSide === "pending" ? "paired" : "pending";
  const interruptedPath = statePaths[interruptedSide];
  const crash = spawnSync(
    options.nodeExecutable,
    [
      "--input-type=module",
      "-e",
      `
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error("missing " + name);
  return value;
};
const stateDir = requireEnv("NEMOCLAW_DEVICE_APPROVAL_STATE");
const durablePath = path.resolve(requireEnv("NEMOCLAW_DURABLE_STATE_PATH"));
const interruptedPath = path.resolve(requireEnv("NEMOCLAW_INTERRUPTED_STATE_PATH"));
const promises = fs.promises;
const rename = promises.rename.bind(promises);
let resolveDurable;
let rejectDurable;
const durableCompleted = new Promise((resolve, reject) => {
  resolveDurable = resolve;
  rejectDurable = reject;
});
let durableSeen = false;
let interruptedSeen = false;
Object.defineProperty(promises, "rename", {
  configurable: true,
  writable: true,
  value: async (source, destination) => {
    const target = path.resolve(String(destination));
    if (target === durablePath && !durableSeen) {
      durableSeen = true;
      try {
        await rename(source, destination);
        resolveDurable();
        return;
      } catch (error) {
        rejectDurable(error);
        throw error;
      }
    }
    if (target === interruptedPath && !interruptedSeen) {
      interruptedSeen = true;
      await durableCompleted;
      await delay(100);
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
    return await rename(source, destination);
  },
});
const { approveDevicePairing } = await import(requireEnv("NEMOCLAW_DEVICE_BOOTSTRAP_URL"));
const result = await approveDevicePairing(requireEnv("NEMOCLAW_REQUEST_ID"), {
  callerScopes: ["operator.pairing"],
  nemoclawSelfApprovalIdentity: {
    deviceId: requireEnv("NEMOCLAW_DEVICE_ID"),
    publicKey: requireEnv("NEMOCLAW_PUBLIC_KEY"),
    role: "operator",
    clientId: "cli",
    clientMode: "cli",
    deviceToken: requireEnv("NEMOCLAW_DEVICE_TOKEN"),
  },
}, stateDir);
if (result?.status !== "approved") throw new Error("injected crash path escaped approval");
throw new Error("injected crash did not terminate the process");
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_DEVICE_APPROVAL_STATE: fixture.stateDir,
        NEMOCLAW_DEVICE_BOOTSTRAP_URL: deviceBootstrapUrl,
        NEMOCLAW_DEVICE_ID: fixture.deviceId,
        NEMOCLAW_DEVICE_TOKEN: String(
          requireOperatorToken(
            asRecord(fixture.beforePaired[fixture.deviceId]),
            `real-dist ${durableSide}-first baseline`,
          ).token,
        ),
        NEMOCLAW_DURABLE_STATE_PATH: durablePath,
        NEMOCLAW_INTERRUPTED_STATE_PATH: interruptedPath,
        NEMOCLAW_PUBLIC_KEY: fixture.publicKey,
        NEMOCLAW_REQUEST_ID: fixture.requestId,
        OPENCLAW_STATE_DIR: fixture.stateDir,
      },
      timeout: options.timeoutMs,
    },
  );
  requireLiveProof(
    crash.status === null && crash.signal === "SIGKILL",
    `real-dist ${durableSide}-first transaction: expected the injected SIGKILL`,
  );

  const prepared = requirePreparedPairingJournal(
    fixture,
    `real-dist ${durableSide}-first transaction journal`,
  );
  const mixedState = {
    auth: readJsonObject(fixture.authPath, `real-dist ${durableSide}-first mixed auth`),
    paired: readJsonObject(fixture.pairedPath, `real-dist ${durableSide}-first mixed paired`),
    pending: readJsonObject(fixture.pendingPath, `real-dist ${durableSide}-first mixed pending`),
  };
  const beforeState = {
    auth: prepared.beforeAuth,
    paired: prepared.beforePaired,
    pending: prepared.beforePending,
  };
  const afterState = {
    auth: prepared.afterAuth,
    paired: prepared.afterPaired,
    pending: prepared.afterPending,
  };
  for (const side of ["auth", "paired", "pending"] as const) {
    if (side === durableSide) {
      requireJsonEqual(
        mixedState[side],
        afterState[side],
        `real-dist ${durableSide}-first durable ${side}`,
      );
      continue;
    }
    if (side === interruptedSide) {
      requireJsonEqual(
        mixedState[side],
        beforeState[side],
        `real-dist ${durableSide}-first interrupted ${side}`,
      );
      continue;
    }
    requireLiveProof(
      JSON.stringify(mixedState[side]) === JSON.stringify(beforeState[side]) ||
        JSON.stringify(mixedState[side]) === JSON.stringify(afterState[side]),
      `real-dist ${durableSide}-first sibling ${side} escaped journal images`,
    );
  }

  const restart = spawnSync(
    options.nodeExecutable,
    [
      "--input-type=module",
      "-e",
      `
import fs from "node:fs";
const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error("missing " + name);
  return value;
};
const stateDir = requireEnv("NEMOCLAW_DEVICE_APPROVAL_STATE");
const pendingPath = requireEnv("NEMOCLAW_PENDING_STATE_PATH");
const pairedPath = requireEnv("NEMOCLAW_PAIRED_STATE_PATH");
const authPath = requireEnv("NEMOCLAW_AUTH_STATE_PATH");
const journalPath = requireEnv("NEMOCLAW_JOURNAL_PATH");
const { listDevicePairing } = await import(requireEnv("NEMOCLAW_DEVICE_BOOTSTRAP_URL"));
if (typeof listDevicePairing !== "function") throw new Error("reviewed pairing list export missing");
await listDevicePairing(stateDir);
const first = [pendingPath, pairedPath, authPath, journalPath].map((file) => fs.readFileSync(file, "utf8"));
const journal = JSON.parse(first[3]);
if (journal?.version !== 2 || journal?.kind !== "nemoclaw-self-approval" || journal?.phase !== "idle") {
  throw new Error("fresh restart did not leave an idle transaction journal");
}
await listDevicePairing(stateDir);
const second = [pendingPath, pairedPath, authPath, journalPath].map((file) => fs.readFileSync(file, "utf8"));
if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("second recovery pass changed state");
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_DEVICE_APPROVAL_STATE: fixture.stateDir,
        NEMOCLAW_AUTH_STATE_PATH: fixture.authPath,
        NEMOCLAW_DEVICE_BOOTSTRAP_URL: deviceBootstrapUrl,
        NEMOCLAW_JOURNAL_PATH: fixture.journalPath,
        NEMOCLAW_PAIRED_STATE_PATH: fixture.pairedPath,
        NEMOCLAW_PENDING_STATE_PATH: fixture.pendingPath,
        OPENCLAW_STATE_DIR: fixture.stateDir,
      },
      timeout: options.timeoutMs,
    },
  );
  requireSuccess(restart, `recover real-dist ${durableSide}-first transaction`);
  requirePairingState(
    fixture,
    fixture.beforePending,
    fixture.beforePaired,
    `real-dist ${durableSide}-first rollback`,
  );
  requirePairingAuthState(fixture, fixture.beforeAuth, `real-dist ${durableSide}-first rollback`);
  requireIdlePairingJournal(fixture.journalPath, `real-dist ${durableSide}-first rollback journal`);

  const retry = spawnSync(
    options.nodeExecutable,
    [
      "--input-type=module",
      "-e",
      `
const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error("missing " + name);
  return value;
};
const stateDir = requireEnv("NEMOCLAW_DEVICE_APPROVAL_STATE");
const { approveDevicePairing, listDevicePairing } = await import(requireEnv("NEMOCLAW_DEVICE_BOOTSTRAP_URL"));
await listDevicePairing(stateDir);
const result = await approveDevicePairing(requireEnv("NEMOCLAW_REQUEST_ID"), {
  callerScopes: ["operator.pairing"],
  nemoclawSelfApprovalIdentity: {
    deviceId: requireEnv("NEMOCLAW_DEVICE_ID"),
    publicKey: requireEnv("NEMOCLAW_PUBLIC_KEY"),
    role: "operator",
    clientId: "cli",
    clientMode: "cli",
    deviceToken: requireEnv("NEMOCLAW_DEVICE_TOKEN"),
  },
}, stateDir);
if (result?.status !== "approved") throw new Error("approval retry did not succeed");
await listDevicePairing(stateDir);
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_DEVICE_APPROVAL_STATE: fixture.stateDir,
        NEMOCLAW_DEVICE_BOOTSTRAP_URL: deviceBootstrapUrl,
        NEMOCLAW_DEVICE_ID: fixture.deviceId,
        NEMOCLAW_DEVICE_TOKEN: String(
          requireOperatorToken(
            asRecord(fixture.beforePaired[fixture.deviceId]),
            `real-dist ${durableSide}-first retry baseline`,
          ).token,
        ),
        NEMOCLAW_PUBLIC_KEY: fixture.publicKey,
        NEMOCLAW_REQUEST_ID: fixture.requestId,
        OPENCLAW_STATE_DIR: fixture.stateDir,
      },
      timeout: options.timeoutMs,
    },
  );
  requireSuccess(retry, `retry real-dist ${durableSide}-first transaction`);
  requireCompletedPairingApproval(fixture, `real-dist ${durableSide}-first transaction retry`);
}

function runRejectedRenameRollbackProof(
  options: ProofOptions,
  deviceBootstrapUrl: string,
  journalBasename: string,
): void {
  const fixture = createPairingTransactionFixture(options.tmp, "rejected-rename", journalBasename);
  const proof = spawnSync(
    options.nodeExecutable,
    [
      "--input-type=module",
      "-e",
      `
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error("missing " + name);
  return value;
};
const stateDir = requireEnv("NEMOCLAW_DEVICE_APPROVAL_STATE");
const pendingPath = requireEnv("NEMOCLAW_PENDING_STATE_PATH");
const pairedPath = requireEnv("NEMOCLAW_PAIRED_STATE_PATH");
const authPath = requireEnv("NEMOCLAW_AUTH_STATE_PATH");
const journalPath = requireEnv("NEMOCLAW_JOURNAL_PATH");
const canonicalJson = (file) => JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")));
const pendingBefore = canonicalJson(pendingPath);
const pairedBefore = canonicalJson(pairedPath);
const authBefore = canonicalJson(authPath);
const promises = fs.promises;
const rename = promises.rename.bind(promises);
let rejectedOnce = false;
let delayedOnce = false;
let delayedCompleted = false;
Object.defineProperty(promises, "rename", {
  configurable: true,
  writable: true,
  value: async (source, destination) => {
    const target = path.resolve(String(destination));
    if (target === path.resolve(pendingPath) && !rejectedOnce) {
      rejectedOnce = true;
      const error = new Error("injected state rename rejection");
      error.code = "EIO";
      throw error;
    }
    if (target === path.resolve(pairedPath) && !delayedOnce) {
      delayedOnce = true;
      await delay(150);
      await rename(source, destination);
      delayedCompleted = true;
      return;
    }
    return await rename(source, destination);
  },
});
const { approveDevicePairing, listDevicePairing } = await import(requireEnv("NEMOCLAW_DEVICE_BOOTSTRAP_URL"));
let rejected = false;
try {
  await approveDevicePairing(requireEnv("NEMOCLAW_REQUEST_ID"), {
    callerScopes: ["operator.pairing"],
    nemoclawSelfApprovalIdentity: {
      deviceId: requireEnv("NEMOCLAW_DEVICE_ID"),
      publicKey: requireEnv("NEMOCLAW_PUBLIC_KEY"),
      role: "operator",
      clientId: "cli",
      clientMode: "cli",
      deviceToken: requireEnv("NEMOCLAW_DEVICE_TOKEN"),
    },
  }, stateDir);
} catch {
  rejected = true;
}
if (!rejected) throw new Error("injected rename rejection did not reject approval");
if (!delayedCompleted) throw new Error("approval rejected before the sibling rename settled");
if (canonicalJson(pendingPath) !== pendingBefore || canonicalJson(pairedPath) !== pairedBefore || canonicalJson(authPath) !== authBefore) {
  throw new Error("rename rejection was not rolled back before approval rejected");
}
const journalBeforeList = fs.readFileSync(journalPath, "utf8");
const journal = JSON.parse(journalBeforeList);
if (journal?.version !== 2 || journal?.kind !== "nemoclaw-self-approval" || journal?.phase !== "idle") {
  throw new Error("rename rejection did not leave an idle transaction journal");
}
await listDevicePairing(stateDir);
await listDevicePairing(stateDir);
if (
  canonicalJson(pendingPath) !== pendingBefore ||
  canonicalJson(pairedPath) !== pairedBefore ||
  canonicalJson(authPath) !== authBefore ||
  fs.readFileSync(journalPath, "utf8") !== journalBeforeList
) throw new Error("idle restart changed the rejected transaction rollback");
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_DEVICE_APPROVAL_STATE: fixture.stateDir,
        NEMOCLAW_AUTH_STATE_PATH: fixture.authPath,
        NEMOCLAW_DEVICE_BOOTSTRAP_URL: deviceBootstrapUrl,
        NEMOCLAW_DEVICE_ID: fixture.deviceId,
        NEMOCLAW_DEVICE_TOKEN: String(
          requireOperatorToken(
            asRecord(fixture.beforePaired[fixture.deviceId]),
            "real-dist rejected-rename baseline",
          ).token,
        ),
        NEMOCLAW_JOURNAL_PATH: fixture.journalPath,
        NEMOCLAW_PAIRED_STATE_PATH: fixture.pairedPath,
        NEMOCLAW_PENDING_STATE_PATH: fixture.pendingPath,
        NEMOCLAW_PUBLIC_KEY: fixture.publicKey,
        NEMOCLAW_REQUEST_ID: fixture.requestId,
        OPENCLAW_STATE_DIR: fixture.stateDir,
      },
      timeout: options.timeoutMs,
    },
  );
  requireSuccess(proof, "reject and roll back a one-sided real-dist state rename");
  requirePairingState(
    fixture,
    fixture.beforePending,
    fixture.beforePaired,
    "real-dist rejected-rename rollback",
  );
  requirePairingAuthState(fixture, fixture.beforeAuth, "real-dist rejected-rename rollback");
  requireIdlePairingJournal(fixture.journalPath, "real-dist rejected-rename rollback journal");
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  await (childExited(child)
    ? Promise.resolve()
    : Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        delay(timeoutMs),
      ]));
}

async function stopChild(child: ChildProcess): Promise<void> {
  childExited(child) || child.kill("SIGTERM");
  await waitForChildExit(child, 5_000);
  childExited(child) || child.kill("SIGKILL");
  await waitForChildExit(child, 2_000);
  requireLiveProof(childExited(child), "real OpenClaw gateway did not stop after SIGKILL");
}

async function waitForGatewayReady(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs, 60_000);
  let ready = false;
  while (!ready && Date.now() < deadline) {
    childExited(child) && failLiveProof("real OpenClaw gateway exited before readiness");
    ready = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(1_000),
    })
      .then((response) => response.ok)
      .catch(() => false);
    await (ready ? Promise.resolve() : delay(200));
  }
  requireLiveProof(ready, "real OpenClaw gateway did not become ready");
}

async function runLiveStoredDeviceAuthSelfApprovalProof(options: ProofOptions): Promise<void> {
  const packageDir = path.dirname(options.dist);
  const openclawEntry = path.join(packageDir, "openclaw.mjs");
  requireLiveProof(fs.existsSync(openclawEntry), "reviewed OpenClaw CLI entrypoint missing");

  const liveRoot = path.join(options.tmp, "device-approval-live-stored-auth");
  const stateDirPath = path.join(liveRoot, "state");
  const primaryStateDir = path.join(liveRoot, "primary-state");
  const homeDir = path.join(liveRoot, "home");
  const proofBin = path.join(liveRoot, "bin");
  const proofCallLog = path.join(liveRoot, "approval-calls.log");
  const proofCloneAuthReadMarker = path.join(liveRoot, "clone-auth-read.marker");
  const proofDefaultStateRaceMarker = path.join(liveRoot, "default-state-race.marker");
  const proofPrimaryAuthReadMarker = path.join(liveRoot, "primary-auth-read.marker");
  const proofStoredAuthGuard = path.join(proofBin, "deny-primary-device-auth.cjs");
  const configPath = path.join(liveRoot, "openclaw.json");
  const gatewayLog = path.join(liveRoot, "gateway.log");
  fs.mkdirSync(stateDirPath, { recursive: true });
  const stateDir = fs.realpathSync(stateDirPath);
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(proofBin, { recursive: true });
  fs.writeFileSync(
    proofStoredAuthGuard,
    `const fs = require("node:fs");
const guardedAuthPaths = new Map([
  [process.env.NEMOCLAW_PROOF_CLONE_DEVICE_AUTH, process.env.NEMOCLAW_PROOF_CLONE_AUTH_READ_MARKER],
  [process.env.NEMOCLAW_PROOF_PRIMARY_DEVICE_AUTH, process.env.NEMOCLAW_PROOF_PRIMARY_AUTH_READ_MARKER],
]);
const originalRealpathSync = fs.realpathSync.bind(fs);
const originalStatSync = fs.statSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
fs.statSync = function nemoclawProofStatSync(candidate, ...args) {
  let resolved = null;
  try {
    resolved = originalRealpathSync(candidate);
  } catch {}
  const marker = guardedAuthPaths.get(resolved);
  if (marker) {
    originalWriteFileSync(marker, "pathname-device-auth-read\\n");
    const error = new Error("pathname device auth is unavailable to the forced clone proof");
    error.code = "EACCES";
    throw error;
  }
  return originalStatSync(candidate, ...args);
};
`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(proofBin, "openclaw"),
    [
      "#!/bin/sh",
      'printf "%s:%s\\n" "${1:-missing}" "${2:-missing}" >> "$NEMOCLAW_PROOF_CALL_LOG"',
      '[ "$NODE_DISABLE_COMPILE_CACHE" = "1" ] || exit 97',
      '[ "$OPENCLAW_NO_RESPAWN" = "1" ] || exit 97',
      '[ -z "${OPENCLAW_CONFIG_PATH:-}" ] || exit 97',
      '[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ] || exit 97',
      '[ -z "${OPENCLAW_GATEWAY_PASSWORD:-}" ] || exit 97',
      '[ -z "${OPENCLAW_GATEWAY_PORT:-}" ] || exit 97',
      '[ -z "${NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING:-}" ] || exit 97',
      '[ "$NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING" = "1" ] || exit 97',
      '[ "$OPENCLAW_GATEWAY_URL" = "ws://127.0.0.1:$NEMOCLAW_PROOF_GATEWAY_PORT" ] || exit 97',
      'case "${OPENCLAW_STATE_DIR:-}" in /proc/self/fd/*) state_descriptor=${OPENCLAW_STATE_DIR##*/} ;; *) exit 97 ;; esac',
      'case "$state_descriptor" in ""|*[!0-9]*) exit 97 ;; esac',
      '[ "$state_descriptor" -ge 3 ] 2>/dev/null || exit 97',
      '[ -d "$OPENCLAW_STATE_DIR" ] || exit 97',
      "for descriptor_name in NEMOCLAW_OPENCLAW_PENDING_FD NEMOCLAW_OPENCLAW_PAIRED_FD NEMOCLAW_OPENCLAW_IDENTITY_FD; do",
      '  eval "descriptor_value=\\${$descriptor_name:-}"',
      '  case "$descriptor_value" in ""|*[!0-9]*) exit 97 ;; esac',
      '  [ "$descriptor_value" -ge 3 ] 2>/dev/null || exit 97',
      '  [ -r "/proc/self/fd/$descriptor_value" ] || exit 97',
      "done",
      'default_state="$HOME/.openclaw"',
      'restore_default_state() { if [ -L "$default_state" ]; then rm -f "$default_state"; fi; }',
      "trap restore_default_state EXIT HUP INT TERM",
      'test ! -e "$default_state"',
      'test -d "$NEMOCLAW_PRIMARY_STATE_DIR"',
      'ln -s "$NEMOCLAW_PRIMARY_STATE_DIR" "$default_state"',
      'printf "%s\\n" "default-state-swapped" > "$NEMOCLAW_PROOF_DEFAULT_STATE_RACE_MARKER"',
      'NODE_OPTIONS="--require=$NEMOCLAW_PROOF_STORED_AUTH_GUARD${NODE_OPTIONS:+ $NODE_OPTIONS}" "$NEMOCLAW_PROOF_NODE" "$NEMOCLAW_PROOF_OPENCLAW" "$@"',
      "status=$?",
      "restore_default_state",
      "trap - EXIT HUP INT TERM",
      'if [ "$status" -eq 0 ] && [ "${NEMOCLAW_PROOF_APPROVAL_EXIT_NONZERO:-0}" = "1" ]; then',
      '  printf "%s\\n" "raw concurrent approval output must stay private" >&2',
      "  exit 1",
      "fi",
      'exit "$status"',
    ].join("\n"),
    { mode: 0o700 },
  );
  const approvalPolicy = readAutoPairApprovalPolicyModule();
  requireLiveProof(approvalPolicy, "restored-clone approval policy module missing");
  const observeOrdinaryPairing = () => {
    const observation = spawnSync("sh", ["-s"], {
      encoding: "utf8",
      env,
      input: buildOpenClawPairingObservationScript(
        Buffer.from(approvalPolicy, "utf8").toString("base64"),
        stateDir,
        "ordinary-settlement",
      ),
      timeout: Math.min(options.timeoutMs, 60_000),
    });
    requireSuccess(observation, "observe real ordinary pairing settlement");
    const parsed = parseOpenClawPairingSettlementObservation(observation.stdout ?? "");
    requireLiveProof(parsed, "real ordinary pairing settlement returned no observation");
    return parsed;
  };
  const observePortableRepairPairing = () => {
    const observation = spawnSync("sh", ["-s"], {
      encoding: "utf8",
      env,
      input: buildOpenClawPairingObservationScript(
        Buffer.from(approvalPolicy, "utf8").toString("base64"),
        stateDir,
        "repair-settlement",
      ),
      timeout: Math.min(options.timeoutMs, 60_000),
    });
    requireSuccess(observation, "observe real Portable repair pairing state");
    const parsed = parseOpenClawPairingRepairObservation(observation.stdout ?? "");
    requireLiveProof(parsed, "real Portable repair pairing state returned no observation");
    return parsed;
  };
  const observeStrictPairing = () => {
    const observation = spawnSync("sh", ["-s"], {
      encoding: "utf8",
      env,
      input: buildOpenClawPairingObservationScript(
        Buffer.from(approvalPolicy, "utf8").toString("base64"),
        stateDir,
        "settlement",
      ),
      timeout: Math.min(options.timeoutMs, 60_000),
    });
    requireSuccess(observation, "observe real strict pairing settlement");
    const parsed = parseOpenClawPairingSettlementObservation(observation.stdout ?? "");
    requireLiveProof(parsed, "real strict pairing settlement returned no observation");
    return parsed;
  };
  const pairedTokenApprovalScript = buildAutoPairApprovalScript(
    Buffer.from(approvalPolicy, "utf8").toString("base64"),
    {
      budget: {
        maxApprovals: CONNECT_AUTO_PAIR_MAX_APPROVALS,
        listTimeoutS: CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
        approveTimeoutS: CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
      },
      emitReceipt: true,
      localDeviceOnly: true,
    },
  );
  const port = await reserveLoopbackPort();
  const gatewayToken = crypto.randomBytes(32).toString("hex");
  const writeGatewayConfig = (auth: Record<string, unknown>) =>
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth,
        },
      }),
    );
  writeGatewayConfig({ mode: "none" });
  const {
    OPENCLAW_GATEWAY_PASSWORD: _gatewayPassword,
    OPENCLAW_GATEWAY_PORT: _gatewayPort,
    OPENCLAW_GATEWAY_TOKEN: _gatewayToken,
    OPENCLAW_GATEWAY_URL: _gatewayUrl,
    NODE_DISABLE_COMPILE_CACHE: _nodeDisableCompileCache,
    OPENCLAW_PROFILE: _profile,
    ...inheritedEnv
  } = process.env;
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv,
    HOME: homeDir,
    NEMOCLAW_PROOF_CALL_LOG: proofCallLog,
    NEMOCLAW_PROOF_CLONE_AUTH_READ_MARKER: proofCloneAuthReadMarker,
    NEMOCLAW_PROOF_CLONE_STATE_DIR: stateDir,
    NEMOCLAW_PROOF_CLONE_DEVICE_AUTH: path.join(stateDir, "identity", "device-auth.json"),
    NEMOCLAW_PROOF_NODE: options.nodeExecutable,
    NEMOCLAW_PROOF_OPENCLAW: openclawEntry,
    NEMOCLAW_PROOF_PRIMARY_AUTH_READ_MARKER: proofPrimaryAuthReadMarker,
    NEMOCLAW_PROOF_PRIMARY_DEVICE_AUTH: path.join(primaryStateDir, "identity", "device-auth.json"),
    NEMOCLAW_PROOF_DEFAULT_STATE_RACE_MARKER: proofDefaultStateRaceMarker,
    NEMOCLAW_PROOF_STORED_AUTH_GUARD: proofStoredAuthGuard,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_STATE_DIR: stateDir,
    PATH: `${proofBin}:${inheritedEnv.PATH ?? ""}`,
  };
  const runCli = (args: string[], envOverrides: NodeJS.ProcessEnv = {}) =>
    spawnSync(options.nodeExecutable, [openclawEntry, ...args], {
      cwd: packageDir,
      encoding: "utf8",
      env: { ...env, ...envOverrides },
      timeout: Math.min(options.timeoutMs, 60_000),
    });

  const startGateway = (gatewayEnv: NodeJS.ProcessEnv, append: boolean) => {
    const gatewayLogFd = fs.openSync(gatewayLog, append ? "a" : "w");
    const child = spawn(options.nodeExecutable, [openclawEntry, "gateway", "run"], {
      cwd: packageDir,
      env: gatewayEnv,
      stdio: ["ignore", gatewayLogFd, gatewayLogFd],
    });
    fs.closeSync(gatewayLogFd);
    return child;
  };
  let gateway = startGateway(env, false);
  let proofPhase = "bootstrap";
  try {
    await waitForGatewayReady(gateway, port, options.timeoutMs);

    const bootstrap = runCli(["devices", "list", "--json"]);
    requireSuccess(bootstrap, "bootstrap real stored device identity through local pairing");
    const deviceAuthPath = path.join(stateDir, "identity", "device-auth.json");
    const identityPath = path.join(stateDir, "identity", "device.json");
    const authStore = readJsonObject(deviceAuthPath, "real stored device auth");
    const identity = readJsonObject(identityPath, "real device identity");
    requireLiveProof(
      authStore.deviceId === identity.deviceId && typeof identity.deviceId === "string",
      "real stored device auth is not bound to the generated device identity",
    );
    const storedOperatorBefore = requireOperatorToken(authStore, "real stored device auth");
    const storedTokenBefore = storedOperatorBefore.token;
    requireLiveProof(
      typeof storedTokenBefore === "string" && storedTokenBefore.length > 0,
      "bootstrap stored operator token missing",
    );
    requireExactScopes(
      storedOperatorBefore.scopes,
      ["operator.pairing"],
      "bootstrap stored operator scopes",
    );

    const pairedPath = path.join(stateDir, "devices", "paired.json");
    const pendingPath = path.join(stateDir, "devices", "pending.json");
    const pairedBefore = readJsonObject(pairedPath, "real paired device state");
    const pairedDeviceBefore = asRecord(pairedBefore[String(identity.deviceId)]);
    requireLiveProof(pairedDeviceBefore, "generated device missing from real paired state");
    const serverOperatorBefore = requireOperatorToken(
      pairedDeviceBefore,
      "real paired device state",
    );
    const serverTokenBefore = serverOperatorBefore.token;
    requireLiveProof(
      typeof serverTokenBefore === "string" && serverTokenBefore.length > 0,
      "real paired operator token missing before repair",
    );
    requireLiveProof(
      serverTokenBefore === storedTokenBefore,
      "stored device credential does not match the server pairing token before repair",
    );
    requireExactScopes(
      pairedDeviceBefore.scopes,
      ["operator.pairing"],
      "bootstrap paired device scopes",
    );
    requireExactScopes(
      pairedDeviceBefore.approvedScopes,
      ["operator.pairing"],
      "bootstrap paired approved scopes",
    );
    requireExactScopes(
      serverOperatorBefore.scopes,
      ["operator.pairing"],
      "bootstrap paired operator token scopes",
    );

    proofPhase = "pairing-settlement-list-gateway-restart";
    await stopChild(gateway);
    writeGatewayConfig({ mode: "token" });
    gateway = startGateway({ ...env, OPENCLAW_GATEWAY_TOKEN: gatewayToken }, true);
    await waitForGatewayReady(gateway, port, options.timeoutMs);

    proofPhase = "pairing-settlement-list";
    const pendingBeforeSettlementList = fs.readFileSync(pendingPath, "utf8");
    const pairedBeforeSettlementList = fs.readFileSync(pairedPath, "utf8");
    const settlementList = runCli(["devices", "list", "--json"], {
      NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT: "1",
      OPENCLAW_TEST_RUNTIME_LOG: "1",
    });
    proofPhase = `pairing-settlement-list-exit-${settlementList.status ?? "signal"}`;
    requireSuccess(settlementList, "list paired state with pairing-only stored device auth");
    proofPhase = "pairing-settlement-list-view";
    const settlementView = asRecord(JSON.parse(settlementList.stdout ?? "null") as unknown);
    const settlementPending = settlementView?.pending;
    const settlementPaired = settlementView?.paired;
    const settlementPairedDevice = asRecord(
      Array.isArray(settlementPaired) ? settlementPaired[0] : null,
    );
    requireLiveProof(
      Array.isArray(settlementPending) &&
        settlementPending.length === 0 &&
        Array.isArray(settlementPaired) &&
        settlementPaired.length === 1 &&
        settlementPaired.every((value) => asRecord(value) !== null) &&
        settlementPairedDevice?.deviceId === identity.deviceId,
      "pairing settlement list did not return the expected settled pairing records",
    );
    requireExactScopes(
      settlementPairedDevice?.scopes,
      ["operator.pairing"],
      "pairing settlement list paired scopes",
    );
    proofPhase = "pairing-settlement-list-server-state";
    const pendingAfterSettlementList = fs.readFileSync(pendingPath, "utf8");
    const pairedAfterSettlementList = readJsonObject(
      pairedPath,
      "real paired state after pairing settlement list",
    );
    const pairedDeviceAfterSettlementList = asRecord(
      pairedAfterSettlementList[String(identity.deviceId)],
    );
    requireLiveProof(
      pairedDeviceAfterSettlementList,
      "pairing settlement list removed the exact paired CLI device",
    );
    proofPhase = "pairing-settlement-list-pending-state";
    requireLiveProof(
      pendingAfterSettlementList === pendingBeforeSettlementList,
      "pairing settlement list changed canonical pending state bytes",
    );
    // Stored-device authentication can update only the gateway's last-seen
    // audit fields. Normalize those three optional writes, then require every
    // device, token, scope, and remaining metadata field to match the exact
    // before-image.
    proofPhase = "pairing-settlement-list-authorization-state";
    requireOnlyAuthenticationAuditChanges(
      pairedBeforeSettlementList,
      pairedAfterSettlementList,
      String(identity.deviceId),
      "pairing settlement list",
    );

    proofPhase = "portable-controller-delayed-settlement";
    const baselinePortableState = {
      auth: fs.readFileSync(deviceAuthPath, "utf8"),
      paired: fs.readFileSync(pairedPath, "utf8"),
      pending: fs.readFileSync(pendingPath, "utf8"),
    };
    const portableControllerBin = path.join(liveRoot, "portable-controller-bin");
    fs.mkdirSync(portableControllerBin);
    fs.writeFileSync(
      path.join(portableControllerBin, "openclaw"),
      [
        "#!/bin/sh",
        'exec "$NEMOCLAW_PROOF_NODE" "$NEMOCLAW_PROOF_OPENCLAW" "$@"',
      ].join("\n"),
      { mode: 0o700 },
    );
    const controllerEnv: NodeJS.ProcessEnv = {
      ...env,
      OPENCLAW_CONFIG_PATH: configPath,
      PATH: `${portableControllerBin}:${inheritedEnv.PATH ?? ""}`,
    };
    const runControllerScript = ((
      _binary: string,
      _args: readonly string[],
      spawnOptions: Parameters<typeof spawnSync>[2],
    ) =>
      spawnSync("sh", ["-s"], {
        ...(spawnOptions ?? {}),
        cwd: packageDir,
        env: controllerEnv,
      })) as typeof spawnSync;
    const controllerExecDeps = {
      getOpenshellBinary: () => "openshell",
      readApprovalPolicy: () => approvalPolicy,
      spawnSync: runControllerScript,
    };
    const controllerEntry = {
      name: "portable-controller-proof",
      agent: "openclaw",
      agentVersion: options.version,
      policyPresetsFinalized: true,
      lifecycleGeneration: "portable-controller-generation",
      lifecycleLiveIdentityFingerprint: "portable-controller-live-identity",
      gatewayName: resolveGatewayName(port),
      gatewayPort: port,
    };
    const controllerReceipt = {
      kind: "current" as const,
      registryGeneration: controllerEntry.lifecycleGeneration,
      runtimeAuthority: {
        schemaVersion: 1,
        kind: "podman",
        ownership: "current-user",
        uid: process.getuid?.() ?? 0,
        homeDir,
        configHome: homeDir,
        runtimeDir: liveRoot,
        socketPath: path.join(liveRoot, "podman.sock"),
      },
    };
    const delayedPairedPath = `${pairedPath}.not-yet-visible`;
    const delayedAuthPath = `${deviceAuthPath}.not-yet-visible`;
    fs.renameSync(pairedPath, delayedPairedPath);
    fs.renameSync(deviceAuthPath, delayedAuthPath);
    const restoreInitialState = () => {
      if (fs.existsSync(delayedPairedPath)) fs.renameSync(delayedPairedPath, pairedPath);
      if (fs.existsSync(delayedAuthPath)) fs.renameSync(delayedAuthPath, deviceAuthPath);
    };
    const delayedFinalState: { value: typeof baselinePortableState | null } = { value: null };
    let controllerNow = 0;
    let controllerSleeps = 0;
    let producerCalls = 0;
    let approvalCalls = 0;
    let controllerResult: Awaited<ReturnType<typeof settlePortableOpenClawPairing>>;
    try {
      controllerResult = await settlePortableOpenClawPairing(
        controllerEntry.name,
        { portableRequired: true },
        {
          classifyPortableLifecycleReceipt: () => controllerReceipt as never,
          getSandbox: () => controllerEntry as never,
          listAgents: () => ["openclaw"],
          loadAgent: () =>
            ({
              name: "openclaw",
              expected_version: options.version,
              config: { dir: stateDir },
              runtime: { interactive_command: "openclaw tui" },
            }) as never,
          observeOpenClawPairingRepairSettlement: (
            sandboxName,
            gatewayName,
            openclawVersion,
            stateDirectory,
          ) =>
            observeOpenClawPairingRepairSettlement(
              sandboxName,
              gatewayName,
              openclawVersion,
              stateDirectory,
              controllerExecDeps,
            ),
          observeOpenClawPairingSettlement: (
            sandboxName,
            gatewayName,
            openclawVersion,
            stateDirectory,
          ) =>
            observeOpenClawPairingSettlement(
              sandboxName,
              gatewayName,
              openclawVersion,
              stateDirectory,
              controllerExecDeps,
            ),
          runPortablePairingProducer: (sandboxName, gatewayName) => {
            producerCalls += 1;
            runPortableOpenClawPairingRequestProducer(
              sandboxName,
              gatewayName,
              controllerExecDeps,
            );
          },
          runPortablePairingApproval: (_sandboxName, _gatewayName, _expectedIdentity) => {
            approvalCalls += 1;
            const beforeApproval = {
              auth: fs.readFileSync(deviceAuthPath, "utf8"),
              paired: fs.readFileSync(pairedPath, "utf8"),
              pending: fs.readFileSync(pendingPath, "utf8"),
            };
            const pending = readJsonObject(
              pendingPath,
              "production Portable controller pending state",
            );
            const pendingRequests = Object.values(pending).map(asRecord);
            requireLiveProof(
              pendingRequests.length === 1 && pendingRequests[0],
              "production Portable controller did not produce one canonical request",
            );
            const requestId = pendingRequests[0].requestId;
            requireLiveProof(
              typeof requestId === "string" && requestId.length > 0,
              "production Portable controller request id was invalid",
            );
            const approval = runCli(["devices", "approve", requestId, "--json"]);
            requireLiveProof(
              approval.status === 0,
              "production Portable controller approval failed",
            );
            delayedFinalState.value = {
              auth: fs.readFileSync(deviceAuthPath, "utf8"),
              paired: fs.readFileSync(pairedPath, "utf8"),
              pending: fs.readFileSync(pendingPath, "utf8"),
            };
            fs.writeFileSync(deviceAuthPath, beforeApproval.auth);
            fs.writeFileSync(pairedPath, beforeApproval.paired);
            fs.writeFileSync(pendingPath, beforeApproval.pending);
            return "approved";
          },
          withSandboxLock: async (_name, operation) => operation(),
          withGatewayLock: async (_name, operation) => operation(),
          now: () => controllerNow,
          sleep: async (milliseconds) => {
            controllerNow += milliseconds;
            controllerSleeps += 1;
            if (controllerSleeps === 1) {
              restoreInitialState();
            } else if (controllerSleeps === 2 && delayedFinalState.value) {
              fs.writeFileSync(deviceAuthPath, delayedFinalState.value.auth);
              fs.writeFileSync(pairedPath, delayedFinalState.value.paired);
              fs.writeFileSync(pendingPath, delayedFinalState.value.pending);
              delayedFinalState.value = null;
            }
          },
        },
      );
    } finally {
      restoreInitialState();
      if (delayedFinalState.value) {
        fs.writeFileSync(deviceAuthPath, delayedFinalState.value.auth);
        fs.writeFileSync(pairedPath, delayedFinalState.value.paired);
        fs.writeFileSync(pendingPath, delayedFinalState.value.pending);
      }
    }
    proofPhase = [
      "portable-controller-result",
      controllerResult.kind,
      controllerResult.kind === "incomplete" ? controllerResult.reason : "complete",
      `producer-${producerCalls}`,
      `approval-${approvalCalls}`,
      `sleeps-${controllerSleeps}`,
    ].join("-");
    requireLiveProof(
      controllerResult.kind === "settled",
      "production Portable controller did not settle delayed canonical state",
    );
    requireLiveProof(
      producerCalls === 1 && approvalCalls === 1,
      "production Portable controller repeated its request producer or approval",
    );
    requireLiveProof(
      controllerSleeps === 2,
      "production Portable controller did not observe both delayed state transitions",
    );
    proofPhase = "portable-controller-state-reset";
    await stopChild(gateway);
    fs.writeFileSync(deviceAuthPath, baselinePortableState.auth);
    fs.writeFileSync(pairedPath, baselinePortableState.paired);
    fs.writeFileSync(pendingPath, baselinePortableState.pending);
    gateway = startGateway({ ...env, OPENCLAW_GATEWAY_TOKEN: gatewayToken }, true);
    await waitForGatewayReady(gateway, port, options.timeoutMs);

    proofPhase = "scope-upgrade-trigger";
    const createSession = runCli([
      "gateway",
      "call",
      "sessions.create",
      "--params",
      "{}",
      "--json",
    ]);
    requireLiveProof(
      createSession.status !== 0,
      "scope-upgrade trigger unexpectedly reached sessions.create",
    );
    const pending = readJsonObject(pendingPath, "real pending repair state");
    const repairRequests = Object.values(pending)
      .map(asRecord)
      .filter(
        (request): request is Record<string, unknown> =>
          request !== null &&
          request.deviceId === identity.deviceId &&
          request.clientId === "cli" &&
          request.clientMode === "cli" &&
          request.isRepair === true,
      );
    requireLiveProof(
      repairRequests.length === 1,
      "real same-device scope-upgrade trigger classification was not unique",
    );
    const repair = repairRequests[0] as Record<string, unknown>;
    requireLiveProof(
      repair.publicKey === pairedDeviceBefore.publicKey && typeof repair.publicKey === "string",
      "real same-device repair public key does not match the paired baseline",
    );
    requireLiveProof(
      repair.role === "operator" &&
        Array.isArray(repair.roles) &&
        repair.roles.length === 1 &&
        repair.roles[0] === "operator",
      "real same-device repair is not operator-only",
    );
    requireExactScopes(repair.scopes, ["operator.write"], "real same-device repair scopes");
    requireLiveProof(
      typeof repair.requestId === "string" && repair.requestId.length > 0,
      "real same-device repair request id missing",
    );
    const requestId = String(repair.requestId);
    proofPhase = "pending-pairing-settlement-list";
    const pendingBeforePendingSettlementList = fs.readFileSync(pendingPath, "utf8");
    const pairedBeforePendingSettlementList = fs.readFileSync(pairedPath, "utf8");
    const pendingSettlementList = runCli(["devices", "list", "--json"], {
      NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT: "1",
      OPENCLAW_TEST_RUNTIME_LOG: "1",
    });
    proofPhase = `pending-pairing-settlement-list-exit-${pendingSettlementList.status ?? "signal"}`;
    requireSuccess(
      pendingSettlementList,
      "list pending scope upgrade with pairing-only stored device auth",
    );
    proofPhase = "pending-pairing-settlement-list-view";
    const pendingSettlementOutput = String(pendingSettlementList.stdout ?? "").trim();
    let pendingSettlementView: unknown;
    try {
      pendingSettlementView = JSON.parse(pendingSettlementOutput);
    } catch {
      const firstObject = pendingSettlementOutput.indexOf("{");
      const lastObject = pendingSettlementOutput.lastIndexOf("}");
      let containsJsonObject = false;
      if (firstObject >= 0 && lastObject > firstObject) {
        try {
          JSON.parse(pendingSettlementOutput.slice(firstObject, lastObject + 1));
          containsJsonObject = true;
        } catch {
          containsJsonObject = false;
        }
      }
      proofPhase = [
        "pending-pairing-settlement-list-json",
        pendingSettlementOutput ? "stdout-present" : "stdout-empty",
        String(pendingSettlementList.stderr ?? "").trim() ? "stderr-present" : "stderr-empty",
        containsJsonObject ? "json-with-prefix" : "json-absent",
      ].join("-");
      throw new Error("pairing settlement list did not return plain JSON");
    }
    const pendingSettlementRecord = asRecord(pendingSettlementView);
    const visiblePending = pendingSettlementRecord?.pending;
    const visiblePaired = pendingSettlementRecord?.paired;
    const visiblePendingRequest = asRecord(
      Array.isArray(visiblePending) ? visiblePending[0] : null,
    );
    const visiblePairedDevice = asRecord(Array.isArray(visiblePaired) ? visiblePaired[0] : null);
    proofPhase = "pending-pairing-settlement-list-pending-count";
    requireLiveProof(
      Array.isArray(visiblePending) &&
        visiblePending.length === 1 &&
        visiblePending.every((value) => asRecord(value) !== null),
      "pairing settlement list did not return one expected pending request",
    );
    proofPhase = "pending-pairing-settlement-list-request";
    requireLiveProof(
      visiblePendingRequest?.requestId === requestId &&
        visiblePendingRequest?.deviceId === identity.deviceId,
      "pairing settlement list did not return the expected pending scope upgrade",
    );
    proofPhase = "pending-pairing-settlement-list-paired";
    requireLiveProof(
      Array.isArray(visiblePaired) &&
        visiblePaired.length === 1 &&
        visiblePaired.every((value) => asRecord(value) !== null) &&
        visiblePairedDevice?.deviceId === identity.deviceId,
      "pairing settlement list did not return the expected paired device",
    );
    requireExactScopes(
      visiblePairedDevice?.scopes,
      ["operator.pairing"],
      "pairing settlement list paired scopes during pending upgrade",
    );
    proofPhase = "pending-pairing-settlement-list-server-state";
    requireLiveProof(
      fs.readFileSync(pendingPath, "utf8") === pendingBeforePendingSettlementList,
      "pairing settlement list changed pending scope-upgrade state",
    );
    const pairedAfterPendingSettlementList = readJsonObject(
      pairedPath,
      "real paired state after pending pairing settlement list",
    );
    requireOnlyAuthenticationAuditChanges(
      pairedBeforePendingSettlementList,
      pairedAfterPendingSettlementList,
      String(identity.deviceId),
      "pending pairing settlement list",
    );
    proofPhase = "ordinary-settlement-observation-before-approval";
    const pendingUpgradeObservation = observeOrdinaryPairing();
    requireLiveProof(
      pendingUpgradeObservation.state === "scope-upgrade-pending",
      "ordinary settlement did not observe the pending scope upgrade before canonical approval",
    );
    const portableRepairObservation = observePortableRepairPairing();
    requireLiveProof(
      portableRepairObservation.state === "pairing-pending" &&
        portableRepairObservation.deviceIdentitySha256 ===
          pendingUpgradeObservation.deviceIdentitySha256,
      "Portable repair observation did not preserve the canonical pending transition",
    );
    const pendingBeforeOrdinaryApproval = fs.readFileSync(pendingPath, "utf8");
    const pairedBeforeOrdinaryApproval = fs.readFileSync(pairedPath, "utf8");
    const authBeforeOrdinaryApproval = fs.readFileSync(deviceAuthPath, "utf8");
    proofPhase = "ordinary-stored-device-approval";
    const ordinaryApproval = runCli(["devices", "approve", requestId, "--json"]);
    requireSuccess(ordinaryApproval, "approve the ordinary stored-device scope upgrade");
    const pendingAfterOrdinaryApproval = readJsonObject(
      pendingPath,
      "real pending state after ordinary approval",
    );
    proofPhase = "ordinary-stored-device-approval-post-state";
    requireLiveProof(
      !(requestId in pendingAfterOrdinaryApproval),
      "ordinary stored-device approval left the request pending",
    );
    const pairedAfterOrdinaryApproval = readJsonObject(
      pairedPath,
      "real paired state after ordinary approval",
    );
    const pairedDeviceAfterOrdinaryApproval = asRecord(
      pairedAfterOrdinaryApproval[String(identity.deviceId)],
    );
    requireLiveProof(
      pairedDeviceAfterOrdinaryApproval,
      "ordinary stored-device approval removed the paired device",
    );
    requireExactScopes(
      pairedDeviceAfterOrdinaryApproval.scopes,
      ["operator.pairing", "operator.write"],
      "ordinary stored-device approval paired scopes",
    );
    const ordinaryPairedOperator = requireOperatorToken(
      pairedDeviceAfterOrdinaryApproval,
      "ordinary paired device",
    );
    const authAfterOrdinaryApproval = readJsonObject(
      deviceAuthPath,
      "real stored device auth after ordinary approval",
    );
    const ordinaryAuthOperator = requireOperatorToken(
      authAfterOrdinaryApproval,
      "ordinary stored device auth",
    );
    requireLiveProof(
      authAfterOrdinaryApproval.deviceId === identity.deviceId &&
        ordinaryAuthOperator.token === ordinaryPairedOperator.token &&
        ordinaryAuthOperator.token !== storedTokenBefore,
      "ordinary stored-device approval did not publish the rotated paired token",
    );
    requireExactScopes(
      ordinaryPairedOperator.scopes,
      ["operator.pairing", "operator.read", "operator.write"],
      "ordinary paired operator scopes",
    );
    requireExactScopes(
      ordinaryAuthOperator.scopes,
      ["operator.pairing", "operator.read", "operator.write"],
      "ordinary stored-device approval auth scopes",
    );
    proofPhase = "ordinary-settlement-observation-after-approval";
    const settledObservation = observeOrdinaryPairing();
    requireLiveProof(
      settledObservation.state === "settled" &&
        settledObservation.deviceIdentitySha256 === pendingUpgradeObservation.deviceIdentitySha256,
      "ordinary settlement did not preserve the canonical device through scope approval",
    );
    const strictSettledObservation = observeStrictPairing();
    requireLiveProof(
      strictSettledObservation.state === "settled" &&
        strictSettledObservation.deviceIdentitySha256 ===
          portableRepairObservation.deviceIdentitySha256,
      "strict Portable observation did not preserve settled canonical state",
    );
    proofPhase = "ordinary-stored-device-approval-output";
    const ordinaryApprovalOutput = `${String(ordinaryApproval.stdout ?? "")}\n${String(ordinaryApproval.stderr ?? "")}`;
    requireLiveProof(
      ![gatewayToken, serverTokenBefore, storedTokenBefore, ordinaryPairedOperator.token].some(
        (token) => ordinaryApprovalOutput.includes(String(token)),
      ),
      "ordinary stored-device approval exposed a device or gateway token",
    );
    proofPhase = "ordinary-stored-device-approval-client-auth";
    const ordinaryApprovalVerifier = runCli([
      "gateway",
      "call",
      "sessions.create",
      "--params",
      "{}",
      "--json",
    ]);
    requireSuccess(
      ordinaryApprovalVerifier,
      "authorize sessions.create with the rotated stored device token",
    );
    if (process.platform !== "linux") return;
    proofPhase = "ordinary-stored-device-approval-state-reset";
    await stopChild(gateway);
    fs.writeFileSync(pendingPath, pendingBeforeOrdinaryApproval);
    fs.writeFileSync(pairedPath, pairedBeforeOrdinaryApproval);
    fs.writeFileSync(deviceAuthPath, authBeforeOrdinaryApproval);
    gateway = startGateway({ ...env, OPENCLAW_GATEWAY_TOKEN: gatewayToken }, true);
    await waitForGatewayReady(gateway, port, options.timeoutMs);
    // The remaining restored-clone proof pins inherited /proc/self/fd
    // descriptors. Linux CI exercises that boundary; other hosts stop after
    // the ordinary approval and matching stored-auth check above.
    const pendingBeforeApproval = pending;
    const exactRepair = asRecord(pendingBeforeApproval[requestId]);
    requireLiveProof(
      exactRepair?.deviceId === identity.deviceId &&
        exactRepair.publicKey === pairedDeviceBefore.publicKey &&
        exactRepair.clientId === "cli" &&
        exactRepair.clientMode === "cli" &&
        exactRepair.isRepair === true,
      "restored clone did not retain one exact repair identity",
    );
    requireExactScopes(exactRepair.scopes, ["operator.write"], "restored-clone repair scopes");
    const configuredBeforeApproval = readJsonObject(configPath, "real gateway config");
    const configuredGateway = asRecord(configuredBeforeApproval.gateway);
    const configuredAuth = asRecord(configuredGateway?.auth);
    requireLiveProof(
      configuredAuth?.mode === "token" && configuredAuth.token === undefined,
      "gateway token auth was not isolated from the stored-device-auth client",
    );

    const cloneIdentityBefore = fs.readFileSync(identityPath, "utf8");
    const cloneAuthBefore = fs.readFileSync(deviceAuthPath, "utf8");
    const clonePairedBefore = fs.readFileSync(pairedPath, "utf8");
    const primaryIdentityDir = path.join(primaryStateDir, "identity");
    const primaryDevicesDir = path.join(primaryStateDir, "devices");
    fs.mkdirSync(primaryIdentityDir, { recursive: true });
    fs.mkdirSync(primaryDevicesDir, { recursive: true });
    const primaryToken = crypto.randomBytes(32).toString("hex");
    requireLiveProof(
      primaryToken !== gatewayToken &&
        primaryToken !== serverTokenBefore &&
        gatewayToken !== serverTokenBefore,
      "real paired-token proof credentials were not distinct",
    );
    const primaryAuth = JSON.parse(JSON.stringify(authStore)) as Record<string, unknown>;
    requireOperatorToken(primaryAuth, "primary auth sentinel").token = primaryToken;
    const primaryPaired = JSON.parse(JSON.stringify(pairedBefore)) as Record<string, unknown>;
    const primaryPairedDevice = asRecord(primaryPaired[String(identity.deviceId)]);
    requireLiveProof(primaryPairedDevice, "primary paired sentinel device missing");
    requireOperatorToken(primaryPairedDevice, "primary paired sentinel").token = primaryToken;
    const primaryFiles = [
      [path.join(primaryStateDir, ".env"), `OPENCLAW_GATEWAY_TOKEN=${primaryToken}\n`],
      [path.join(primaryIdentityDir, "device.json"), cloneIdentityBefore],
      [path.join(primaryIdentityDir, "device-auth.json"), JSON.stringify(primaryAuth)],
      [path.join(primaryDevicesDir, "pending.json"), JSON.stringify(pendingBeforeApproval)],
      [path.join(primaryDevicesDir, "paired.json"), JSON.stringify(primaryPaired)],
    ] as const;
    for (const [file, contents] of primaryFiles) fs.writeFileSync(file, contents);

    requireLiveProof(
      fs.readFileSync(deviceAuthPath, "utf8") === cloneAuthBefore &&
        fs.readFileSync(identityPath, "utf8") === cloneIdentityBefore &&
        fs.readFileSync(pairedPath, "utf8") === clonePairedBefore,
      "restored-clone matching credential setup changed another clone state file",
    );
    // The ordinary settlement list above must read the clone's stored device
    // credential. Baseline both sentinels after that allowed read so the
    // descriptor-only restored-clone approval still proves it performs no
    // later pathname-backed auth read.
    const cloneAuthReadBaseline = "ordinary-settlement-list-clone-baseline\n";
    const primaryAuthReadBaseline = "ordinary-settlement-list-primary-baseline\n";
    fs.writeFileSync(proofCloneAuthReadMarker, cloneAuthReadBaseline);
    fs.writeFileSync(proofPrimaryAuthReadMarker, primaryAuthReadBaseline);
    proofPhase = "paired-token-repair-approval-process";
    const approval = spawnSync("sh", ["-c", pairedTokenApprovalScript], {
      cwd: packageDir,
      encoding: "utf8",
      env: {
        ...env,
        NEMOCLAW_PROOF_APPROVAL_EXIT_NONZERO: "1",
        NEMOCLAW_PROOF_GATEWAY_PORT: String(port),
        NEMOCLAW_PRIMARY_STATE_DIR: primaryStateDir,
        OPENCLAW_GATEWAY_PORT: String(port),
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      },
      timeout: CONNECT_AUTO_PAIR_TIMEOUT_MS,
    });
    requireLiveProof(approval.status === 0, "restored-clone paired-token approval process failed");
    const approvalReceipt = parseAutoPairApprovalReceipt(approval.stdout);
    proofPhase = `paired-token-repair-approval-receipt-${approvalReceipt ?? "invalid"}`;
    requireLiveProof(
      approvalReceipt === "approved-one",
      "restored-clone paired-token approval returned a fixed non-success classification",
    );
    const defaultStateRaceObserved = fs.existsSync(proofDefaultStateRaceMarker);
    const cloneAuthSentinelUnchanged =
      fs.readFileSync(proofCloneAuthReadMarker, "utf8") === cloneAuthReadBaseline;
    const primaryAuthSentinelUnchanged =
      fs.readFileSync(proofPrimaryAuthReadMarker, "utf8") === primaryAuthReadBaseline;
    proofPhase = [
      "paired-token-repair-default-state-race",
      `default-${defaultStateRaceObserved}`,
      `clone-${cloneAuthSentinelUnchanged}`,
      `primary-${primaryAuthSentinelUnchanged}`,
    ].join("-");
    requireLiveProof(
      defaultStateRaceObserved && cloneAuthSentinelUnchanged && primaryAuthSentinelUnchanged,
      "forced clone approval used a pathname-backed default or stored-auth credential",
    );
    proofPhase = "paired-token-repair-approval-stdout-shape";
    requireLiveProof(
      approval.stdout.trim() === "__NEMOCLAW_AUTO_PAIR_RECEIPT__=approved-one",
      "restored-clone paired-token approval emitted an invalid output shape",
    );
    proofPhase = "paired-token-repair-approval-stderr-present";
    requireLiveProof(
      approval.stderr.trim() === "",
      "restored-clone paired-token approval emitted private diagnostics",
    );
    proofPhase = "paired-token-repair-approval-call-count";
    requireLiveProof(
      fs.readFileSync(proofCallLog, "utf8").trim() === "devices:approve",
      "restored-clone approval did not make exactly one canonical approve call",
    );

    proofPhase = "paired-token-repair-approval-post-state";
    const pendingAfter = readJsonObject(pendingPath, "real pending state after approval");
    requireLiveProof(
      !(requestId in pendingAfter),
      "real same-device repair remained pending after approval",
    );
    const sameDeviceSuccessors = Object.values(pendingAfter)
      .map(asRecord)
      .filter(
        (request): request is Record<string, unknown> =>
          request !== null && request.deviceId === identity.deviceId,
      );
    requireLiveProof(
      sameDeviceSuccessors.length === 0,
      "real same-device approval left a successor request",
    );
    proofPhase = "server-token-rotation";
    const pairedAfter = readJsonObject(pairedPath, "real paired state after approval");
    const pairedDeviceAfter = asRecord(pairedAfter[String(identity.deviceId)]);
    requireLiveProof(pairedDeviceAfter, "real paired device disappeared after approval");
    const serverOperatorAfter = requireOperatorToken(
      pairedDeviceAfter,
      "real paired state after approval",
    );
    requireLiveProof(
      typeof serverOperatorAfter.token === "string" &&
        serverOperatorAfter.token.length > 0 &&
        serverOperatorAfter.token !== serverTokenBefore,
      "real canonical approval did not rotate the server operator token",
    );
    requireExactScopes(
      serverOperatorAfter.scopes,
      ["operator.pairing", "operator.read", "operator.write"],
      "real repaired operator scopes",
    );
    proofPhase = "server-scope-views";
    requireExactScopes(
      pairedDeviceAfter.scopes,
      ["operator.pairing", "operator.write"],
      "real repaired paired scopes",
    );
    requireExactScopes(
      pairedDeviceAfter.approvedScopes,
      ["operator.pairing", "operator.write"],
      "real repaired approved scopes",
    );
    proofPhase = "client-auth-sync";
    const syncedAuth = readJsonObject(deviceAuthPath, "real synchronized clone device auth");
    const syncedOperator = requireOperatorToken(syncedAuth, "real synchronized clone device auth");
    requireLiveProof(
      syncedAuth.version === 1 &&
        syncedAuth.deviceId === identity.deviceId &&
        syncedOperator.role === "operator" &&
        syncedOperator.token === serverOperatorAfter.token &&
        syncedOperator.token !== gatewayToken &&
        syncedOperator.token !== primaryToken,
      "restored-clone client auth did not synchronize to the rotated device token",
    );
    requireExactScopes(
      syncedOperator.scopes,
      ["operator.pairing", "operator.read", "operator.write"],
      "synchronized clone operator scopes",
    );
    proofPhase = "primary-state-isolation";
    requireLiveProof(
      fs.readFileSync(identityPath, "utf8") === cloneIdentityBefore &&
        primaryFiles.every(([file, contents]) => fs.readFileSync(file, "utf8") === contents),
      "restored-clone approval changed primary or clone identity state",
    );
    proofPhase = "gateway-config-isolation";
    const configuredAfterApproval = readJsonObject(
      configPath,
      "real gateway config after approval",
    );
    const configuredGatewayAfter = asRecord(configuredAfterApproval.gateway);
    const configuredAuthAfter = asRecord(configuredGatewayAfter?.auth);
    requireLiveProof(
      configuredAuthAfter?.mode === "token" && configuredAuthAfter.token === undefined,
      "gateway token auth configuration changed during paired-token approval",
    );
    await stopChild(gateway);
    proofPhase = "ordinary-verifier";
    gateway = startGateway({ ...env, OPENCLAW_GATEWAY_TOKEN: gatewayToken }, true);
    await waitForGatewayReady(gateway, port, options.timeoutMs);
    const ordinaryVerifier = runCli([
      "gateway",
      "call",
      "sessions.create",
      "--params",
      "{}",
      "--json",
    ]);
    requireLiveProof(
      env.OPENCLAW_GATEWAY_TOKEN === undefined && ordinaryVerifier.status === 0,
      "ordinary stored-device-auth write verifier failed after gateway restart",
    );
    const pendingAfterVerifier = readJsonObject(
      pendingPath,
      "real pending state after ordinary verifier",
    );
    requireLiveProof(
      !Object.values(pendingAfterVerifier)
        .map(asRecord)
        .some((request) => request?.deviceId === identity.deviceId),
      "ordinary verifier created another same-device pairing request",
    );
  } catch {
    throw new Error(`real OpenClaw clone paired-token proof failed (${proofPhase})`);
  } finally {
    await stopChild(gateway);
  }
}

export async function runRealOpenClawDeviceSelfApprovalProof(options: ProofOptions): Promise<void> {
  const patch = spawnSync(
    options.nodeExecutable,
    ["--experimental-strip-types", options.patchScript, options.dist],
    {
      encoding: "utf8",
      timeout: options.timeoutMs,
    },
  );
  requireSuccess(patch, "apply bounded device self-approval patch");
  requireIncludes(
    patch.stdout,
    "patched OpenClaw bounded device self-approval",
    "device self-approval patch output",
  );

  const audit = spawnSync(
    options.nodeExecutable,
    ["--experimental-strip-types", options.patchScript, "--audit", options.dist],
    {
      encoding: "utf8",
      timeout: options.timeoutMs,
    },
  );
  requireSuccess(audit, "audit bounded device self-approval patch");
  for (const marker of [
    "gateway call device-identity runtime:",
    "devices CLI approval runtime:",
    "device-token scope-upgrade gateway auth runtime:",
    "device pairing gateway handler:",
    "canonical device pairing state runtime:",
    "Summary: 6 OK · 0 missing",
  ]) {
    requireIncludes(audit.stdout, marker, "device self-approval audit");
  }

  const sources = readDistSources(options.dist);
  for (const marker of [
    "nemoclaw: force device identity for loopback pairing bootstrap",
    "nemoclaw: reach gateway for bounded same-device scope approval",
    "nemoclaw: route bounded CLI device-token scope upgrade into pairing",
    "nemoclaw: bounded same-device scope approval",
    "nemoclaw: validate bounded self-approval inside pairing lock",
    'CLI: "cli"',
  ]) {
    if (!sources.some(({ source }) => source.includes(marker))) {
      throw new Error(`real-dist marker ${marker}: expected a matching top-level file`);
    }
  }

  const cliSource = requireExactlyOneDistSource(sources, "patched devices CLI approval runtime", [
    "function resolveApprovePairingScopesForRequest(request, paired)",
    "nemoclaw: reach gateway for bounded same-device scope approval",
  ]);
  const pairingStateSource = requireExactlyOneDistSource(
    sources,
    "patched transactional device pairing state runtime",
    [
      "nemoclaw: validate bounded self-approval inside pairing lock",
      "nemoclaw: recover bounded self-approval state transaction",
      'await persistState(state, baseDir, "both")',
    ],
  );
  requireExactlyOneDistSource(sources, "atomic JSON state rename runtime", [
    "async function renameWithRetry(params)",
    "await params.fsModule.rename(params.src, params.dest)",
  ]);
  const journalBasename = discoverSelfApprovalJournalBasename(pairingStateSource.source);
  requireRealStoredDeviceAuthLinkage(sources, cliSource);
  const cliProofFile = path.join(options.dist, ".nemoclaw-device-cli-proof.mjs");
  fs.writeFileSync(
    cliProofFile,
    `${cliSource.source}\nexport { resolveApprovePairingScopesForRequest as nemoclawResolveApprovePairingScopesForRequest, resolveNemoClawSelfRepairPairingContext as nemoclawResolveSelfRepairPairingContext };\n`,
  );
  const cliProofUrl = pathToFileURL(cliProofFile).href;
  const deviceHandlerUrl = pathToFileURL(requireRealDeviceTokenAuthLinkage(sources)).href;

  // The tarball harness ordinarily needs only generated-file patching. This
  // behavioral proof imports the reviewed pairing module as well, so install
  // its shrinkwrapped production dependencies in the throwaway extraction.
  // Lifecycle scripts stay disabled, matching the reviewed Docker boundary.
  const packageDir = path.dirname(options.dist);
  const install = spawnSync(
    "npm",
    ["install", "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"],
    { cwd: packageDir, encoding: "utf8", timeout: 120_000 },
  );
  requireSuccess(install, "install reviewed OpenClaw runtime dependencies without scripts");

  const deviceState = path.join(options.tmp, "device-approval-state");
  const devicesDir = path.join(deviceState, "devices");
  const identityDir = path.join(deviceState, "identity");
  fs.mkdirSync(devicesDir, { recursive: true });
  fs.mkdirSync(identityDir, { recursive: true });
  const now = Date.now();
  const pending = {
    "handler-request": {
      requestId: "handler-request",
      deviceId: "handler-device",
      publicKey: "handler-public-key",
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.write"],
      isRepair: false,
      ts: now,
    },
    "request-1": {
      requestId: "request-1",
      deviceId: "device-1",
      publicKey: "public-key-1",
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.write"],
      isRepair: false,
      ts: now,
    },
    "request-2": {
      requestId: "request-2",
      deviceId: "device-2",
      publicKey: "public-key-2",
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.read"],
      isRepair: true,
      ts: now,
    },
    unrelated: {
      requestId: "unrelated",
      deviceId: "device-3",
      publicKey: "public-key-3",
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.pairing"],
      ts: now,
    },
  };
  const paired = Object.fromEntries(
    ["1", "2", "3", "handler"].map((suffix) => [
      suffix === "handler" ? "handler-device" : `device-${suffix}`,
      {
        deviceId: suffix === "handler" ? "handler-device" : `device-${suffix}`,
        publicKey: suffix === "handler" ? "handler-public-key" : `public-key-${suffix}`,
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing"],
        approvedScopes: ["operator.pairing"],
        tokens: {
          operator: {
            token: suffix === "handler" ? "handler-token" : `token-${suffix}`,
            role: "operator",
            scopes: ["operator.pairing"],
            createdAtMs: now,
          },
        },
        createdAtMs: now,
        approvedAtMs: now,
      },
    ]),
  );
  fs.writeFileSync(path.join(devicesDir, "pending.json"), JSON.stringify(pending));
  fs.writeFileSync(path.join(devicesDir, "paired.json"), JSON.stringify(paired));
  fs.writeFileSync(
    path.join(identityDir, "device-auth.json"),
    JSON.stringify({
      version: 1,
      deviceId: "handler-device",
      tokens: {
        operator: {
          token: "handler-token",
          role: "operator",
          scopes: ["operator.pairing"],
          updatedAtMs: now,
        },
      },
    }),
  );

  const deviceBootstrapFile = path.join(options.dist, "plugin-sdk", "device-bootstrap.js");
  const deviceBootstrapSource = fs.readFileSync(deviceBootstrapFile, "utf8");
  for (const marker of [
    `from "../${path.basename(pairingStateSource.file)}"`,
    "listDevicePairing",
    "approveDevicePairing",
  ]) {
    requireLiveProof(
      deviceBootstrapSource.includes(marker),
      `real device bootstrap linkage: expected marker ${marker}`,
    );
  }
  const deviceBootstrapUrl = pathToFileURL(deviceBootstrapFile).href;
  const runtimeProof = spawnSync(
    options.nodeExecutable,
    [
      "--input-type=module",
      "-e",
      `
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { approveDevicePairing } = await import(${JSON.stringify(deviceBootstrapUrl)});
const { deviceHandlers } = await import(${JSON.stringify(deviceHandlerUrl)});
const { nemoclawResolveApprovePairingScopesForRequest, nemoclawResolveSelfRepairPairingContext } = await import(${JSON.stringify(cliProofUrl)});
const stateDir = process.env.NEMOCLAW_DEVICE_APPROVAL_STATE;
const distDir = process.env.NEMOCLAW_OPENCLAW_DIST;
const authPath = path.join(stateDir, "identity", "device-auth.json");
const pairingFiles = fs.readdirSync(distDir).filter((name) => /^device-pairing-.*[.]js$/.test(name));
if (pairingFiles.length !== 1) throw new Error(\`expected one device-pairing runtime, found \${pairingFiles.length}\`);
const pairingRuntime = await import(pathToFileURL(path.join(distDir, pairingFiles[0])).href);
if (typeof pairingRuntime.m !== "function" || typeof pairingRuntime.v !== "function") throw new Error("reviewed pairing concurrency exports missing");
const identity = (suffix) => ({
  deviceId: \`device-\${suffix}\`,
  publicKey: \`public-key-\${suffix}\`,
  role: "operator",
  clientId: "cli",
  clientMode: "cli",
  deviceToken: \`token-\${suffix}\`,
});
const writeDeviceAuth = (deviceId, token, scopes = ["operator.pairing"]) => {
  fs.writeFileSync(authPath, JSON.stringify({
    version: 1,
    deviceId,
    tokens: {
      operator: { token, role: "operator", scopes, updatedAtMs: Date.now() },
    },
  }));
};
const coldCloneDevice = {
  deviceId: "cold-clone-device",
  publicKey: "cold-clone-public-key",
  role: "operator",
  roles: ["operator"],
  clientId: "cli",
  clientMode: "cli",
  scopes: ["operator.write"],
};
await pairingRuntime.m(coldCloneDevice, stateDir);
const coldPendingState = JSON.parse(
  fs.readFileSync(path.join(stateDir, "devices", "pending.json"), "utf8"),
);
const coldRequests = Object.values(coldPendingState).filter(
  (request) => request.deviceId === coldCloneDevice.deviceId,
);
if (coldRequests.length !== 1) throw new Error("cold clone did not create exactly one pending request");
const coldRequest = coldRequests[0];
if (coldRequest.isRepair !== false) throw new Error("cold clone request was not pre-convergence");
const coldPairedState = JSON.parse(
  fs.readFileSync(path.join(stateDir, "devices", "paired.json"), "utf8"),
);
if (coldPairedState[coldCloneDevice.deviceId]) throw new Error("cold clone unexpectedly had paired state");
const coldStoredAuthContext = nemoclawResolveSelfRepairPairingContext(
  coldRequest,
  coldPairedState[coldCloneDevice.deviceId],
);
if (coldStoredAuthContext?.useStoredDeviceAuth === true) {
  throw new Error("cold clone request incorrectly selected stored device auth");
}
const unrelatedBeforeColdApproval = JSON.stringify(coldPendingState.unrelated);
const coldApproval = await approveDevicePairing(String(coldRequest.requestId), {
  callerScopes: ["operator.admin"],
}, stateDir);
if (coldApproval?.status !== "approved") {
  throw new Error("cold clone canonical approval failed");
}
const coldPendingAfter = JSON.parse(
  fs.readFileSync(path.join(stateDir, "devices", "pending.json"), "utf8"),
);
if (coldPendingAfter[String(coldRequest.requestId)]) {
  throw new Error("cold clone transition remained pending after approval");
}
if (JSON.stringify(coldPendingAfter.unrelated) !== unrelatedBeforeColdApproval) {
  throw new Error("cold clone approval mutated an unrelated transition");
}
const coldPairedAfter = JSON.parse(
  fs.readFileSync(path.join(stateDir, "devices", "paired.json"), "utf8"),
);
const coldPairedDevice = coldPairedAfter[coldCloneDevice.deviceId];
if (!coldPairedDevice) throw new Error("cold clone canonical approval produced no paired device");
const coldOperatorToken = Array.isArray(coldPairedDevice.tokens)
  ? coldPairedDevice.tokens.find((token) => token?.role === "operator")
  : coldPairedDevice.tokens?.operator;
const hasExactScopes = (view, expected) =>
  Array.isArray(view) &&
  view.length === new Set(view).size &&
  JSON.stringify([...view].sort()) === JSON.stringify([...expected].sort());
if (
  !hasExactScopes(coldPairedDevice.scopes, ["operator.write"]) ||
  !hasExactScopes(coldPairedDevice.approvedScopes, ["operator.write"]) ||
  !hasExactScopes(coldOperatorToken?.scopes, ["operator.read", "operator.write"])
) {
  throw new Error("cold clone approval escaped canonical bounded scope views");
}
if (
  Object.values(coldPendingAfter).some(
    (request) =>
      request.deviceId === coldCloneDevice.deviceId &&
      [request.scopes, request.requestedScopes].some(
        (scopes) => Array.isArray(scopes) && scopes.includes("operator.admin"),
      ),
  )
) {
  throw new Error("cold clone approval left an admin successor");
}
const repairRequest = {
  requestId: "cli-scope-repair",
  deviceId: "device-1",
  publicKey: "public-key-1",
  clientId: "cli",
  clientMode: "cli",
  role: "operator",
  roles: ["operator"],
  scopes: ["operator.write"],
  isRepair: true,
};
const preconvergenceWriteRequest = { ...repairRequest, isRepair: false };
const pairingOnly = ["operator.pairing"];
const missingPairedViewScopes = nemoclawResolveApprovePairingScopesForRequest(repairRequest, undefined);
if (JSON.stringify(missingPairedViewScopes) !== JSON.stringify(pairingOnly)) throw new Error("missing paired CLI view requested read/write before canonical approval");
const roleKeyedTokenScopes = nemoclawResolveApprovePairingScopesForRequest(repairRequest, {
  deviceId: "device-1",
  publicKey: "public-key-1",
  scopes: ["operator.pairing"],
  tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
});
if (JSON.stringify(roleKeyedTokenScopes) !== JSON.stringify(pairingOnly)) throw new Error("role-keyed paired CLI view requested read/write before canonical approval");
const storedAuthContext = nemoclawResolveSelfRepairPairingContext(preconvergenceWriteRequest, {
  deviceId: "device-1",
  publicKey: "public-key-1",
  scopes: ["operator.pairing"],
  tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
});
if (storedAuthContext?.useStoredDeviceAuth !== true) throw new Error("exact pre-convergence write transition did not select stored device auth");
const mismatchedStoredAuthContext = nemoclawResolveSelfRepairPairingContext(repairRequest, {
  deviceId: "device-1",
  publicKey: "other-public-key",
  scopes: ["operator.pairing"],
  tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
});
if (mismatchedStoredAuthContext?.useStoredDeviceAuth !== false) throw new Error("mismatched same-device repair selected stored device auth");
const visibleNonPairingBaseline = nemoclawResolveApprovePairingScopesForRequest(repairRequest, {
  tokens: [{ role: "operator", scopes: ["operator.read"] }],
});
if (visibleNonPairingBaseline?.length === 1 && visibleNonPairingBaseline[0] === "operator.pairing") throw new Error("visible non-pairing baseline received pairing-only approval transport");
const approveHandler = deviceHandlers?.["device.pair.approve"];
if (typeof approveHandler !== "function") throw new Error("reviewed device approval handler export missing");
const handlerResponses = [];
const handlerBroadcasts = [];
const invokeHandler = async (client) => {
  let response;
  await approveHandler({
    params: { requestId: "handler-request" },
    client,
    respond(ok, payload, error) {
      response = { ok, payload, error };
      handlerResponses.push(response);
    },
    context: {
      logGateway: { info() {}, warn() {} },
      broadcast(...args) { handlerBroadcasts.push(args); },
    },
  });
  return response;
};
const handlerClient = (overrides = {}) => ({
  isDeviceTokenAuth: true,
  connect: {
    role: "operator",
    scopes: ["operator.pairing"],
    auth: { token: "handler-token" },
    device: { id: "handler-device", publicKey: "handler-public-key" },
    client: { id: "cli", mode: "cli" },
  },
  ...overrides,
});
const sharedAuthResponse = await invokeHandler(handlerClient({ isDeviceTokenAuth: false }));
if (sharedAuthResponse?.ok !== false) throw new Error("shared-auth session reached bounded device approval");
let handlerState = JSON.parse(fs.readFileSync(path.join(stateDir, "devices", "paired.json"), "utf8"));
if (handlerState["handler-device"]?.tokens?.operator?.token !== "handler-token") throw new Error("shared-auth denial mutated paired state");
const crossDeviceResponse = await invokeHandler(handlerClient({
  connect: {
    role: "operator",
    scopes: ["operator.pairing"],
    auth: { token: "handler-token" },
    device: { id: "other-device", publicKey: "other-public-key" },
    client: { id: "cli", mode: "cli" },
  },
}));
if (crossDeviceResponse?.ok !== false) throw new Error("cross-device session reached bounded device approval");
const handlerResponse = await invokeHandler(handlerClient());
if (handlerResponse?.ok !== true) throw new Error("device-token handler approval failed");
handlerState = JSON.parse(fs.readFileSync(path.join(stateDir, "devices", "paired.json"), "utf8"));
if (handlerState["handler-device"]?.tokens?.operator?.token === "handler-token") throw new Error("handler did not run canonical token rotation");
const handlerAuth = JSON.parse(fs.readFileSync(authPath, "utf8"));
if (
  handlerAuth.deviceId !== "handler-device" ||
  handlerAuth.tokens?.operator?.token !== handlerState["handler-device"]?.tokens?.operator?.token ||
  !hasExactScopes(handlerAuth.tokens?.operator?.scopes, ["operator.pairing", "operator.read", "operator.write"])
) throw new Error("handler did not publish matching stored device auth");
if (handlerBroadcasts.length !== 1) throw new Error("handler did not broadcast exactly one successful approval");
if (handlerResponses.length !== 3) throw new Error("handler did not respond exactly once per request");
const denied = await approveDevicePairing("request-1", {
  callerScopes: ["operator.pairing"],
  nemoclawSelfApprovalIdentity: identity("wrong"),
}, stateDir);
if (denied?.status !== "forbidden") throw new Error("mismatched identity was not denied");
writeDeviceAuth("device-1", "token-1");
const [first, _inserted, _updated, second] = await Promise.all([
  approveDevicePairing("request-1", {
    callerScopes: ["operator.pairing"],
    nemoclawSelfApprovalIdentity: identity("1"),
  }, stateDir),
  pairingRuntime.m({
    deviceId: "device-4",
    publicKey: "public-key-4",
    clientId: "cli",
    clientMode: "cli",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.pairing"],
  }, stateDir),
  pairingRuntime.v("device-3", { displayName: "concurrent-update" }, stateDir),
  approveDevicePairing("request-2", {
    callerScopes: ["operator.admin"],
  }, stateDir),
]);
if (first?.status !== "approved" || second?.status !== "approved") throw new Error("concurrent canonical approvals failed");
const pendingAfter = JSON.parse(fs.readFileSync(path.join(stateDir, "devices", "pending.json"), "utf8"));
const pairedAfter = JSON.parse(fs.readFileSync(path.join(stateDir, "devices", "paired.json"), "utf8"));
if (!Object.values(pendingAfter).some((request) => request.deviceId === "device-4")) throw new Error("concurrently inserted pending request was lost");
if (!Object.values(pendingAfter).some((request) => request.requestId === "unrelated")) throw new Error("pre-existing unrelated pending request was lost");
if (pairedAfter["device-3"]?.tokens?.operator?.token !== "token-3") throw new Error("unrelated paired token was lost");
if (pairedAfter["device-3"]?.displayName !== "concurrent-update") throw new Error("concurrent paired metadata update was lost");
if (pairedAfter["device-1"]?.tokens?.operator?.token === "token-1") throw new Error("canonical token rotation did not run");
const scopes = pairedAfter["device-1"]?.tokens?.operator?.scopes ?? [];
if (!["operator.pairing", "operator.read", "operator.write"].every((scope) => scopes.includes(scope))) throw new Error("bounded write scope closure missing");
const authAfter = JSON.parse(fs.readFileSync(authPath, "utf8"));
if (
  authAfter.deviceId !== "device-1" ||
  authAfter.tokens?.operator?.token !== pairedAfter["device-1"]?.tokens?.operator?.token ||
  !hasExactScopes(authAfter.tokens?.operator?.scopes, ["operator.pairing", "operator.read", "operator.write"])
) throw new Error("concurrent self-approval did not publish matching stored device auth");
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_DEVICE_APPROVAL_STATE: deviceState,
        NEMOCLAW_OPENCLAW_DIST: options.dist,
        OPENCLAW_STATE_DIR: deviceState,
      },
      timeout: options.timeoutMs,
    },
  );
  try {
    requireSuccess(runtimeProof, "run real-dist canonical device approval proof");
  } finally {
    fs.rmSync(cliProofFile, { force: true });
  }
  runPairingCrashDirectionProof(options, deviceBootstrapUrl, journalBasename, "pending");
  runPairingCrashDirectionProof(options, deviceBootstrapUrl, journalBasename, "paired");
  runPairingCrashDirectionProof(options, deviceBootstrapUrl, journalBasename, "auth");
  runRejectedRenameRollbackProof(options, deviceBootstrapUrl, journalBasename);
  await runLiveStoredDeviceAuthSelfApprovalProof(options);
}
