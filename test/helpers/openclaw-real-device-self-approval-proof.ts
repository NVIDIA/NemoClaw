// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

export function runRealOpenClawDeviceSelfApprovalProof(options: ProofOptions): void {
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
  requireSuccess(runtimeProof, "run real-dist canonical device approval proof");
}
