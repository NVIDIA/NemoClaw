// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import vm from "node:vm";

export const pending = () => ({
  deviceId: "self",
  publicKey: "key",
  clientId: "cli",
  clientMode: "cli",
  role: "operator",
  roles: ["operator"],
  scopes: ["operator.write"],
  isRepair: true,
});
export const identity = {
  deviceId: "self",
  publicKey: "key",
  clientId: "cli",
  clientMode: "cli",
  role: "operator",
  deviceToken: "before",
};
const noop = () => {};

export function createApprovalKernel(source: string, scenario: string) {
  const row = pending();
  if (scenario === "changed-key") row.publicKey = "replacement";
  if (scenario === "admin") row.scopes = ["operator.admin"];
  const state = {
    pendingById: scenario === "expired" ? {} : { request: row },
    pairedByDeviceId: {},
  };
  const events: string[] = [];
  const persistenceCalls: unknown[][] = [];
  const merge = (...values: Array<string | string[] | undefined>) => [
    ...new Set(values.flat().filter(Boolean)),
  ];
  const approve = vm.runInNewContext(source + "\napproveDevicePairingInWorker", {
    OPERATOR_ROLE: "operator",
    loadDevicePairingStateForMutation: () => {
      events.push("load");
      return state;
    },
    requestDevicePairingMutationAdmission: () => {
      events.push("admit");
      if (scenario === "admission-denied") throw new Error("admission denied");
    },
    resolveRequestedDeviceRoles: (p: typeof row) => p.roles,
    normalizeDeviceAuthScopes: (scopes: string[]) => scopes,
    resolveScopeOutsideRequestedRoles: () => undefined,
    mergeDevicePairingRoles: merge,
    mergeDevicePairingScopes: merge,
    resolveRoleTokenScopes: (_role: string, scopes: string[]) => scopes ?? [],
    resolveMissingRequestedScope: ({
      requestedScopes,
      allowedScopes,
    }: {
      requestedScopes: string[];
      allowedScopes: string[];
    }) => requestedScopes.find((scope) => !allowedScopes.includes(scope)),
    createDeviceAuthToken: (params: object) => {
      events.push("rotate");
      return { ...params, token: "after" };
    },
    resolveNodePairingGeneration: () => null,
    clearNodePairingGenerationState: noop,
    persistDevicePairingStoreState: (
      _state: unknown,
      baseDir: unknown,
      target: string,
      options: unknown,
    ) => {
      persistenceCalls.push([baseDir, target, options]);
      events.push("persist");

      if (scenario === "persistence-failed") throw new Error("transaction failed");
    },
  });
  const invoke = () =>
    approve(
      "request",
      {
        callerScopes: ["operator.pairing"],
        nemoclawSelfApprovalIdentity: structuredClone(identity),
      },
      1234,
    );

  return { invoke, events, persistenceCalls };
}

export function createApprovalCommand(source: string, scenario: string) {
  const command = source.match(
    /^async function runDevicesApproveCommand\(requestId, opts\) \{[\s\S]*?^}/m,
  )![0];
  const events: string[] = [];
  const confirmations: unknown[] = [];
  const outputs: unknown[] = [];
  const result = {
    device: {
      deviceId: scenario === "other-device" ? "other" : "self",
      scopes: ["operator.admin"],
    },
  };
  const run = vm.runInNewContext(command + "\nrunDevicesApproveCommand", {
    ADMIN_SCOPE: "operator.admin",
    DEFAULT_DEVICES_TIMEOUT_MS: 10000,
    resolveApprovePairingGatewayContext: async () => ({
      nemoclawLocallyApprovedDevice: {
        deviceId: "self",
        tokens: {
          operator: { role: "operator", scopes: ["operator.admin"], token: "private-rotated" },
        },
      },
    }),
    approvePairingWithFallback: async () => result,
    loadDeviceIdentityIfPresentAsync: async () => {
      events.push("identity");
      if (scenario === "identity-failed") throw new Error("unreadable");
      return { deviceId: "self" };
    },
    callGatewayFromCliWithTransport: async (
      method: string,
      opts: { token: string; password?: string },
      _params: unknown,
      extra: { scopes: string[] },
    ) => {
      confirmations.push({
        method,
        token: opts.token,
        password: opts.password,
        scopes: extra.scopes,
      });
      events.push("confirm");
      if (scenario === "confirmation-failed") throw new Error("denied");
    },
    defaultRuntime: {
      writeJson: (value: unknown) => {
        outputs.push(value);
        events.push("output");
      },
      log: (value: unknown) => {
        outputs.push(value);
        events.push("output");
      },
      exit: (code: number) => events.push(`exit:${code}`),
    },
    process: {
      stdout: { write: (_text: string, done: () => void) => done() },
      stderr: { write: (_text: string, done: () => void) => done() },
    },
    setTimeout,
    clearTimeout,
    theme: { success: (v: string) => v, command: (v: string) => v, muted: (v: string) => v },
  });
  const invoke = () => run("request", { json: scenario !== "text", password: "old-password" });

  return { invoke, events, confirmations, outputs };
}
