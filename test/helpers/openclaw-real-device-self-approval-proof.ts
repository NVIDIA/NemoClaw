// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  const sqliteGatewayLayout = sources.some(({ source }) =>
    source.includes(
      'const loadGatewayServerMethods = createLazyPromise(() => import("./authenticated-request-dispatch.server-methods.runtime.js"))',
    ),
  );
  if (sqliteGatewayLayout) {
    const producer = requireExactlyOneDistSource(sources, "SQLite device-token session producer", [
      'const loadGatewayServerMethods = createLazyPromise(() => import("./authenticated-request-dispatch.server-methods.runtime.js"))',
      "const nextClient = {",
      'isDeviceTokenAuth: authMethod === "device-token"',
      "if (!setClient(nextClient))",
      "const { handleGatewayRequest } = await loadGatewayServerMethods();",
      "handleGatewayRequest({",
    ]);
    const dispatcher = requireExactlyOneDistSource(sources, "SQLite gateway request dispatcher", [
      "function createLazyCoreHandlers(params)",
      "async function handleGatewayRequest(opts)",
      'devices: () => import("./devices-',
    ]);
    const handler = requireExactlyOneDistSource(sources, "SQLite device pairing gateway handler", [
      '"device.pair.approve": async',
      "resolveDeviceSessionAuthz(client)",
      "nemoclaw: bounded same-device scope approval",
    ]);
    const resolver = requireExactlyOneDistSource(
      sources,
      "SQLite canonical device-session authz resolver",
      ["function resolveDeviceSessionAuthz(client)", "callerDeviceId: client?.isDeviceTokenAuth"],
    );
    requireOrderedMarkers(
      producer.source,
      [
        "const { handleGatewayRequest } = await loadGatewayServerMethods();",
        "handleGatewayRequest({",
        "client,",
      ],
      "SQLite authenticated request dispatch",
    );
    requireOrderedMarkers(
      producer.source,
      [
        "const nextClient = {",
        'isDeviceTokenAuth: authMethod === "device-token"',
        "if (!setClient(nextClient))",
      ],
      "SQLite device-token client publication",
    );
    requireOrderedMarkers(
      dispatcher.source,
      [
        "function createLazyCoreHandlers(params)",
        `devices: () => import("./${path.basename(handler.file)}")`,
        "async function handleGatewayRequest(opts)",
      ],
      "SQLite dispatcher-to-device-handler linkage",
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
      "SQLite device-handler-to-authz-resolver linkage",
    );
    return handler.file;
  }

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
  const sqliteGatewayLayout = sources.some(({ source }) =>
    source.includes("const requestedStoredDeviceAuth = opts.useStoredDeviceAuth === true;"),
  );
  const gatewayCall = requireExactlyOneDistSource(
    sources,
    "stored device-auth gateway call",
    sqliteGatewayLayout
      ? [
          "const requestedStoredDeviceAuth = opts.useStoredDeviceAuth === true;",
          "const useStoredDeviceAuth = requestedStoredDeviceAuth && !hasExplicitAuth;",
          "storedAuth = loadStoredOperatorDeviceAuthToken(deviceIdentity, deviceAuthScope, opts.sharedStateMode);",
          "opts.requiredStoredDeviceAuthScopes",
          "useStoredDeviceAuth ? void 0 : scopes",
        ]
      : [
          "const useStoredDeviceAuth = opts.useStoredDeviceAuth === true;",
          "const storedAuth = loadStoredOperatorDeviceAuthToken(deviceIdentity);",
          "opts.requiredStoredDeviceAuthScopes",
          "scopes: useStoredDeviceAuth ? void 0 : scopes",
        ],
  );
  const gatewayHandshake = requireExactlyOneDistSource(
    sources,
    "shared-auth paired-device scope enforcement",
    sqliteGatewayLayout
      ? [
          "const connectAuthState = await resolveConnectAuthState({",
          "const pairedScopes = resolvePairedAccessScopes(paired);",
          'if (!await requirePairing("scope-upgrade", paired)) return {',
        ]
      : [
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
      sqliteGatewayLayout
        ? "!loadStoredOperatorDeviceAuthToken(resolveDeviceIdentityForGatewayCall(params.opts.sharedStateMode), params.deviceAuthScope, params.opts.sharedStateMode)"
        : "!hasStoredOperatorDeviceAuthToken(resolveDeviceIdentityForGatewayCall())",
      "nemoclaw: retain stored CLI device identity for loopback shared-token scope enforcement",
      "return isLocalBackendSharedAuth || isLocalCliSharedAuth;",
    ],
    "loopback CLI shared-token stored device identity",
  );
  requireOrderedMarkers(
    gatewayHandshake.source,
    sqliteGatewayLayout
      ? [
          "const connectAuthState = await resolveConnectAuthState({",
          "async function authorizeExistingGatewayDevice(params)",
          "const { context, state, paired, devicePublicKey, clientAccessMetadata, requirePairing } = params;",
          "const pairedScopes = resolvePairedAccessScopes(paired);",
          "if (scopes.length > 0) {",
          "requestedScopes: scopes,",
          "allowedScopes: pairedScopes",
          'if (!await requirePairing("scope-upgrade", paired)) return {',
        ]
      : [
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
    sqliteGatewayLayout
      ? [
          "const requestedStoredDeviceAuth = opts.useStoredDeviceAuth === true;",
          "const hasExplicitAuth = Boolean(context.explicitAuth.token || context.explicitAuth.password);",
          "const useStoredDeviceAuth = requestedStoredDeviceAuth && !hasExplicitAuth;",
          "skipImplicitAuth: useStoredDeviceAuth,",
          "storedAuth = loadStoredOperatorDeviceAuthToken(deviceIdentity, deviceAuthScope, opts.sharedStateMode);",
          "opts.requiredStoredDeviceAuthScopes",
          "scopes: requestedStoredDeviceAuth && hasExplicitAuth && opts.requiredStoredDeviceAuthScopes ? opts.requiredStoredDeviceAuthScopes : useStoredDeviceAuth ? void 0 : scopes,",
        ]
      : [
          "const useStoredDeviceAuth = opts.useStoredDeviceAuth === true;",
          "const resolvedCredentials = useStoredDeviceAuth ? {} : await resolveGatewayCredentials(context);",
          "const storedAuth = loadStoredOperatorDeviceAuthToken(deviceIdentity);",
          "opts.requiredStoredDeviceAuthScopes",
          "scopes: useStoredDeviceAuth ? void 0 : scopes",
        ],
    "stored device-auth credential selection",
  );
  if (!sqliteGatewayLayout) {
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
  }
  requireOrderedMarkers(
    cliSource.source,
    sqliteGatewayLayout
      ? [
          `from "./${path.basename(gatewayCall.file)}"`,
          "const callGatewayCli = async",
          "callOpts?.usePairedToken === true",
          "url: callOpts.pinnedGatewayUrl",
          "token: callOpts.pairedToken",
          "password: void 0",
          "useStoredDeviceAuth: callOpts?.useStoredDeviceAuth",
          "nemoclaw: forward stored device auth for bounded same-device scope approval",
          "requiredStoredDeviceAuthScopes: callOpts?.requiredStoredDeviceAuthScopes",
        ]
      : [
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
      sqliteGatewayLayout
        ? 'callGatewayCli("device.pair.list", opts, {}, { ...callOpts, scopes: callOpts?.scopes ?? [PAIRING_SCOPE] })'
        : 'callGatewayCli("device.pair.list", opts, {}, callOpts)',
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
      sqliteGatewayLayout
        ? "async function approvePairingWithFallback(opts, requestId, context)"
        : "async function approvePairingWithFallback(opts, requestId)",
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

function runSqliteDeviceSelfApprovalProof(options: ProofOptions): void {
  const stateDir = path.join(options.tmp, "device-approval-sqlite-state");
  fs.mkdirSync(stateDir, { recursive: true });
  const proof = spawnSync(
    options.nodeExecutable,
    [
      "--input-type=module",
      "-e",
      `
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const dist = process.env.NEMOCLAW_OPENCLAW_DIST;
const stateDir = process.env.NEMOCLAW_DEVICE_APPROVAL_STATE;
const exactlyOne = (pattern, label, sourceMarker) => {
  const files = fs.readdirSync(dist).filter((name) =>
    pattern.test(name) && fs.readFileSync(path.join(dist, name), "utf8").includes(sourceMarker)
  );
  if (files.length !== 1) throw new Error(label + ": expected one runtime, found " + files.length);
  return pathToFileURL(path.join(dist, files[0])).href;
};
const pairing = await import(exactlyOne(/^device-pairing-[^.]+[.]js$/, "pairing", "async function requestDevicePairing(req, baseDir)"));
const approval = await import(exactlyOne(/^device-pairing-approval-[^.]+[.]js$/, "approval", "async function approveDevicePairingWithOptions"));
const auth = await import(exactlyOne(/^device-auth-store-[^.]+[.]js$/, "stored auth", "function loadDeviceAuth"));
if (typeof pairing.h !== "function" || typeof pairing.c !== "function" || typeof approval.n !== "function" || typeof auth.l !== "function" || typeof auth.r !== "function") {
  throw new Error("reviewed SQLite device-pairing exports missing");
}
const publicKey = crypto.randomBytes(32).toString("base64url");
const deviceId = crypto.createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
const request = async (scopes) => (await pairing.h({
  deviceId,
  publicKey,
  clientId: "cli",
  clientMode: "cli",
  role: "operator",
  roles: ["operator"],
  scopes,
}, stateDir)).request;
const initial = await request(["operator.pairing"]);
const initialApproval = await approval.n(initial.requestId, { callerScopes: ["operator.admin"] }, stateDir);
if (initialApproval?.status !== "approved") throw new Error("initial SQLite pairing failed");
const initialToken = initialApproval.device?.tokens?.operator;
if (!initialToken?.token || JSON.stringify([...initialToken.scopes].toSorted()) !== JSON.stringify(["operator.pairing"])) throw new Error("initial SQLite token invalid");
const stored = auth.l({
  deviceId,
  role: "operator",
  token: initialToken.token,
  scopes: initialToken.scopes,
  env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
});
if (stored?.token !== initialToken.token) throw new Error("initial SQLite stored auth missing");
const upgrade = await request(["operator.pairing", "operator.write"]);
if (upgrade.isRepair !== true) throw new Error("SQLite scope upgrade was not classified as repair");
const identity = {
  deviceId,
  publicKey,
  role: "operator",
  clientId: "cli",
  clientMode: "cli",
  deviceToken: initialToken.token,
};
const upgraded = await approval.n(upgrade.requestId, {
  callerScopes: ["operator.pairing"],
  nemoclawSelfApprovalIdentity: identity,
}, stateDir);
if (upgraded?.status !== "approved") throw new Error("bounded SQLite self-approval failed");
const nextToken = upgraded.device?.tokens?.operator;
const expectedScopes = ["operator.pairing", "operator.read", "operator.write"];
if (!nextToken?.token || nextToken.token === initialToken.token || JSON.stringify([...nextToken.scopes].toSorted()) !== JSON.stringify(expectedScopes)) throw new Error("bounded SQLite token rotation invalid");
const afterList = await pairing.c(stateDir);
const afterPaired = afterList.paired.find((device) => device.deviceId === deviceId);
const afterStored = auth.r({ deviceId, role: "operator", env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
if (afterList.pending.some((pending) => pending.requestId === upgrade.requestId) || afterPaired?.tokens?.operator?.token !== nextToken.token || afterStored?.token !== nextToken.token || JSON.stringify([...afterStored.scopes].toSorted()) !== JSON.stringify(expectedScopes)) {
  throw new Error("bounded SQLite pairing and stored auth were not published atomically");
}
const staleRequest = await request(["operator.pairing", "operator.write"]);
let staleRejected = false;
try {
  await approval.n(staleRequest.requestId, {
    callerScopes: ["operator.pairing"],
    nemoclawSelfApprovalIdentity: identity,
  }, stateDir);
} catch {
  staleRejected = true;
}
if (!staleRejected) throw new Error("stale SQLite self-approval token was accepted");
const finalList = await pairing.c(stateDir);
const finalPaired = finalList.paired.find((device) => device.deviceId === deviceId);
const finalStored = auth.r({ deviceId, role: "operator", env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
if (!finalList.pending.some((pending) => pending.requestId === staleRequest.requestId) || finalPaired?.tokens?.operator?.token !== nextToken.token || finalStored?.token !== nextToken.token) {
  throw new Error("failed SQLite self-approval did not roll back completely");
}
`,
    ],
    {
      cwd: path.dirname(options.dist),
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_DEVICE_APPROVAL_STATE: stateDir,
        NEMOCLAW_OPENCLAW_DIST: options.dist,
        OPENCLAW_STATE_DIR: stateDir,
      },
      timeout: Math.min(options.timeoutMs, 60_000),
    },
  );
  requireSuccess(proof, "prove real SQLite bounded device self-approval");
}

export async function runRealOpenClawDeviceSelfApprovalProof(options: ProofOptions): Promise<void> {
  const patch = spawnSync(options.nodeExecutable, [options.patchScript, options.dist], {
    encoding: "utf8",
    timeout: options.timeoutMs,
  });
  requireSuccess(patch, "apply bounded device self-approval patch");
  requireIncludes(
    patch.stdout,
    "patched OpenClaw bounded device self-approval",
    "device self-approval patch output",
  );

  const audit = spawnSync(options.nodeExecutable, [options.patchScript, "--audit", options.dist], {
    encoding: "utf8",
    timeout: options.timeoutMs,
  });
  requireSuccess(audit, "audit bounded device self-approval patch");
  const auditSummary = audit.stdout.includes("canonical device pairing SQLite persistence runtime:")
    ? "Summary: 7 OK · 0 missing"
    : "Summary: 6 OK · 0 missing";
  for (const marker of [
    "gateway call device-identity runtime:",
    "devices CLI approval runtime:",
    "device-token scope-upgrade gateway auth runtime:",
    "device pairing gateway handler:",
    "canonical device pairing state runtime:",
    auditSummary,
  ]) {
    requireIncludes(audit.stdout, marker, "device self-approval audit");
  }

  const sources = readDistSources(options.dist);
  for (const marker of [
    "nemoclaw: force device identity for loopback pairing bootstrap",
    "nemoclaw: persist canonical CLI bootstrap credential",
    "nemoclaw: reach gateway for bounded same-device scope approval",
    "nemoclaw: exit after devices approve so leftover gateway handles cannot hang",
    "nemoclaw: route bounded CLI device-token scope upgrade into pairing",
    "nemoclaw: defer bounded silent CLI scope upgrade to pairing watcher",
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
  const sqlitePairingLayout = sources.some(
    ({ source }) =>
      source.includes("function persistDevicePairingStoreState(state, baseDir, target, options)") &&
      source.includes("nemoclaw: recover bounded self-approval state transaction"),
  );
  const pairingStateSource = requireExactlyOneDistSource(
    sources,
    "patched transactional device pairing state runtime",
    sqlitePairingLayout
      ? [
          "nemoclaw: validate bounded self-approval inside pairing lock",
          "approveDevicePairingWithOptions",
          "nemoclawSelfApprovalIdentity",
        ]
      : [
          "nemoclaw: validate bounded self-approval inside pairing lock",
          "nemoclaw: recover bounded self-approval state transaction",
          'await persistState(state, baseDir, "both")',
        ],
  );
  requireRealStoredDeviceAuthLinkage(sources, cliSource);
  const deviceHandlerFile = requireRealDeviceTokenAuthLinkage(sources);
  if (sqlitePairingLayout) {
    requireExactlyOneDistSource(sources, "patched atomic SQLite pairing persistence runtime", [
      "function persistDevicePairingStoreState(state, baseDir, target, options)",
      "nemoclaw: recover bounded self-approval state transaction",
      "bounded self-approval stored-auth fence failed",
    ]);
    const packageDir = path.dirname(options.dist);
    const install = spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--omit=dev",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: packageDir, encoding: "utf8", timeout: 120_000 },
    );
    requireSuccess(install, "install reviewed OpenClaw runtime dependencies without scripts");
    runSqliteDeviceSelfApprovalProof(options);
    return;
  }
  requireExactlyOneDistSource(sources, "atomic JSON state rename runtime", [
    "async function renameWithRetry(params)",
    "await params.fsModule.rename(params.src, params.dest)",
  ]);
  const journalBasename = discoverSelfApprovalJournalBasename(pairingStateSource.source);
  const cliProofFile = path.join(options.dist, ".nemoclaw-device-cli-proof.mjs");
  fs.writeFileSync(
    cliProofFile,
    `${cliSource.source}\nexport { resolveApprovePairingScopesForRequest as nemoclawResolveApprovePairingScopesForRequest, resolveNemoClawSelfRepairPairingContext as nemoclawResolveSelfRepairPairingContext };\n`,
  );
  const cliProofUrl = pathToFileURL(cliProofFile).href;
  const deviceHandlerUrl = pathToFileURL(deviceHandlerFile).href;

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
}
