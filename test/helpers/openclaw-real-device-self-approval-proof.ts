// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface ProofOptions {
  dist: string;
  patchScript: string;
  timeoutMs: number;
  tmp: string;
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
    cliSource.source,
    [
      `from "./${path.basename(gatewayCall.file)}"`,
      "const callGatewayCli = async",
      "callOpts?.useStoredDeviceAuth === true",
      "nemoclaw: forward stored device auth for bounded same-device scope approval",
      "requiredStoredDeviceAuthScopes: callOpts.requiredStoredDeviceAuthScopes",
    ],
    "devices CLI stored-auth bridge",
  );
  requireOrderedMarkers(
    cliSource.source,
    [
      "async function approvePairingWithFallback(opts, requestId)",
      "nemoclawUseStoredDeviceAuth",
      "nemoclaw: select stored device auth for bounded same-device scope approval",
      "requiredStoredDeviceAuthScopes: [PAIRING_SCOPE]",
      "if (nemoclawUseStoredDeviceAuth) throw error;",
      "nemoclaw: keep bounded stored device auth fail closed",
    ],
    "devices CLI bounded stored-auth selection",
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
  container: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
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

function gatewayLogDetail(logFile: string, secret: string): string {
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  return log.slice(-20_000).replaceAll(secret, "<redacted-gateway-token>");
}

async function runLiveConfigTokenSelfApprovalProof(options: ProofOptions): Promise<void> {
  const packageDir = path.dirname(options.dist);
  const openclawEntry = path.join(packageDir, "openclaw.mjs");
  requireLiveProof(fs.existsSync(openclawEntry), "reviewed OpenClaw CLI entrypoint missing");

  const liveRoot = path.join(options.tmp, "device-approval-live-config-token");
  const stateDir = path.join(liveRoot, "state");
  const homeDir = path.join(liveRoot, "home");
  const configPath = path.join(liveRoot, "openclaw.json");
  const gatewayLog = path.join(liveRoot, "gateway.log");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const port = await reserveLoopbackPort();
  const gatewayToken = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token: gatewayToken },
      },
    }),
  );
  const {
    OPENCLAW_GATEWAY_PASSWORD: _gatewayPassword,
    OPENCLAW_GATEWAY_PORT: _gatewayPort,
    OPENCLAW_GATEWAY_TOKEN: _gatewayToken,
    OPENCLAW_GATEWAY_URL: _gatewayUrl,
    OPENCLAW_PROFILE: _profile,
    ...inheritedEnv
  } = process.env;
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv,
    HOME: homeDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_STATE_DIR: stateDir,
  };
  const runCli = (args: string[]) =>
    spawnSync(process.execPath, [openclawEntry, ...args], {
      cwd: packageDir,
      encoding: "utf8",
      env,
      timeout: Math.min(options.timeoutMs, 60_000),
    });

  const gatewayLogFd = fs.openSync(gatewayLog, "w");
  const gateway = spawn(process.execPath, [openclawEntry, "gateway", "run"], {
    cwd: packageDir,
    env,
    stdio: ["ignore", gatewayLogFd, gatewayLogFd],
  });
  fs.closeSync(gatewayLogFd);
  try {
    await waitForGatewayReady(gateway, port, options.timeoutMs);

    const bootstrap = runCli(["devices", "list", "--json"]);
    requireSuccess(
      bootstrap,
      "bootstrap real stored device identity with configured gateway token",
    );
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
      `expected one exact real same-device repair, found ${repairRequests.length}`,
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
    const configuredBeforeApproval = readJsonObject(configPath, "real gateway config");
    const configuredGateway = asRecord(configuredBeforeApproval.gateway);
    const configuredAuth = asRecord(configuredGateway?.auth);
    requireLiveProof(
      configuredAuth?.token === gatewayToken,
      "configured shared gateway token disappeared before approval",
    );

    const approval = runCli(["devices", "approve", String(repair.requestId), "--json"]);
    requireSuccess(
      approval,
      "approve real same-device repair with configured shared token present",
    );

    const pendingAfter = readJsonObject(pendingPath, "real pending state after approval");
    requireLiveProof(
      !(String(repair.requestId) in pendingAfter),
      "real same-device repair remained pending after approval",
    );
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
    const configuredAfterApproval = readJsonObject(
      configPath,
      "real gateway config after approval",
    );
    const configuredGatewayAfter = asRecord(configuredAfterApproval.gateway);
    const configuredAuthAfter = asRecord(configuredGatewayAfter?.auth);
    requireLiveProof(
      configuredAuthAfter?.token === gatewayToken,
      "configured shared gateway token changed during stored-device-auth approval",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nreal gateway log (token redacted):\n${gatewayLogDetail(gatewayLog, gatewayToken)}`,
      { cause: error },
    );
  } finally {
    await stopChild(gateway);
  }
}

export async function runRealOpenClawDeviceSelfApprovalProof(options: ProofOptions): Promise<void> {
  const patch = spawnSync(
    process.execPath,
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
    process.execPath,
    ["--experimental-strip-types", options.patchScript, "--audit", options.dist],
    {
      encoding: "utf8",
      timeout: options.timeoutMs,
    },
  );
  requireSuccess(audit, "audit bounded device self-approval patch");
  for (const marker of [
    "devices CLI approval runtime:",
    "device pairing gateway handler:",
    "canonical device pairing state runtime:",
    "Summary: 3 OK · 0 missing",
  ]) {
    requireIncludes(audit.stdout, marker, "device self-approval audit");
  }

  const sources = readDistSources(options.dist);
  for (const marker of [
    "nemoclaw: reach gateway for bounded same-device scope approval",
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
    ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: packageDir, encoding: "utf8", timeout: 120_000 },
  );
  requireSuccess(install, "install reviewed OpenClaw runtime dependencies without scripts");

  const deviceState = path.join(options.tmp, "device-approval-state");
  const devicesDir = path.join(deviceState, "devices");
  fs.mkdirSync(devicesDir, { recursive: true });
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
      isRepair: true,
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
      isRepair: true,
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

  const deviceBootstrapUrl = pathToFileURL(
    path.join(options.dist, "plugin-sdk", "device-bootstrap.js"),
  ).href;
  const runtimeProof = spawnSync(
    process.execPath,
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
});
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
const storedAuthContext = nemoclawResolveSelfRepairPairingContext(repairRequest, {
  deviceId: "device-1",
  publicKey: "public-key-1",
  scopes: ["operator.pairing"],
  tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
});
if (storedAuthContext?.useStoredDeviceAuth !== true) throw new Error("exact same-device repair did not select stored device auth");
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
    device: { id: "other-device", publicKey: "other-public-key" },
    client: { id: "cli", mode: "cli" },
  },
}));
if (crossDeviceResponse?.ok !== false) throw new Error("cross-device session reached bounded device approval");
const handlerResponse = await invokeHandler(handlerClient());
if (handlerResponse?.ok !== true) throw new Error("device-token handler approval failed");
handlerState = JSON.parse(fs.readFileSync(path.join(stateDir, "devices", "paired.json"), "utf8"));
if (handlerState["handler-device"]?.tokens?.operator?.token === "handler-token") throw new Error("handler did not run canonical token rotation");
if (handlerBroadcasts.length !== 1) throw new Error("handler did not broadcast exactly one successful approval");
if (handlerResponses.length !== 3) throw new Error("handler did not respond exactly once per request");
const denied = await approveDevicePairing("request-1", {
  callerScopes: ["operator.pairing"],
  nemoclawSelfApprovalIdentity: identity("wrong"),
}, stateDir);
if (denied?.status !== "forbidden") throw new Error("mismatched identity was not denied");
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
    callerScopes: ["operator.pairing"],
    nemoclawSelfApprovalIdentity: identity("2"),
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
  await runLiveConfigTokenSelfApprovalProof(options);
}
