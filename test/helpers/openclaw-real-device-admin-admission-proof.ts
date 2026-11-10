// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";

// Execute the native authorization path after intermediate device-token auth.
// Persistence and transport are controlled boundaries: this does not replace
// live handshake, signature, token-revocation, or SQLite transaction coverage.
export async function proveRealOpenClawAdminAdmission(
  sources: { file: string; source: string }[],
): Promise<void> {
  const sourceFor = (marker: string): string => {
    const matches = sources.filter(({ source }) => source.includes(marker));
    assert.equal(matches.length, 1, marker);
    return matches[0]!.source;
  };
  const moduleFor = (prefix: string, importer: string): string => {
    const imported = importer.match(new RegExp('from "\\./(' + prefix + '-[^"/]+)"'))?.[1];
    assert.ok(imported, prefix);
    const matches = sources.filter(({ file }) => path.basename(file) === imported);
    assert.equal(matches.length, 1, prefix);
    return matches[0]!.source;
  };
  const extract = (source: string, name: string): string => {
    const match = source.match(new RegExp("(?:async )?function " + name + "\\([^]*?\\n}"));
    assert.ok(match, name);
    return match[0];
  };
  const patched = sourceFor("async function authorizeGatewayConnectDevice(context, state)");
  const identity = sourceFor("function listEffectivePairedDeviceRoles(device)");
  const auth = sourceFor("function shouldSkipLocalBackendSelfPairing(params)");
  const silentPolicy = vm.runInNewContext(
    extract(auth, "shouldAllowSilentLocalPairing") + "\nshouldAllowSilentLocalPairing",
  );
  for (const locality of ["direct_local", "cli_container_local", "remote"])
    assert.equal(
      silentPolicy({ locality, reason: "scope-upgrade", authMethod: "device-token" }),
      false,
    );
  const scopes = moduleFor("operator-scope-compat", patched).replace(/^export .*$/m, "");
  const normalizationSource = moduleFor("string-normalization", identity);
  const normalization =
    moduleFor("string-coerce", normalizationSource).replace(/^export .*$/m, "") +
    "\n" +
    normalizationSource.replace(/^(?:import|export) .*$/gm, "");
  const tokenWrapper = patched.match(
    /\t\tasync verifyDeviceToken\(paramsLocal\) {[^]*?\n\t\t}/,
  )?.[0];
  assert.ok(tokenWrapper?.includes("nemoclawCliScopeUpgrade"), "patched native token wrapper");
  const native =
    normalization +
    "\n" +
    scopes +
    "\n" +
    [
      "normalizeDevicePairingRole",
      "mergeDevicePairingRoles",
      "listActiveTokenRoles",
      "listApprovedPairedDeviceRoles",
      "listEffectivePairedDeviceRoles",
      "hasEffectivePairedDeviceRole",
    ]
      .map((n) => extract(identity, n))
      .join("\n") +
    "\n" +
    ["resolvePairedAccessScopes", "authorizeExistingGatewayDevice", "authorizeGatewayConnectDevice"]
      .map((n) => extract(patched, n))
      .join("\n");

  for (const baseline of [
    ["operator.pairing"],
    ["operator.pairing", "operator.read", "operator.write"],
    ["operator.read", "operator.write"],
    ["operator.admin"],
  ]) {
    for (const localApproval of [null, "silent"]) {
      const events: string[] = [];
      const paired = {
        publicKey: "fixture-key",
        roles: ["operator"],
        scopes: [...baseline],
        approvedScopes: [...baseline],
        tokens: { operator: { role: "operator", token: "fixture-only" } },
      };
      const connectParams = { client: { id: "cli", mode: "cli" }, scopes: ["operator.admin"] };

      const pending = {
        requestId: "request",
        deviceId: "fixture",
        publicKey: "fixture-key",
        scopes: ["operator.admin"],
        isRepair: true,
        silent: localApproval === "silent",
      };
      const fixture = {
        AbortController,
        GATEWAY_CLIENT_IDS: { CLI: "cli", GATEWAY_CLIENT: "gateway-client" },
        GATEWAY_CLIENT_MODES: { CLI: "cli", BACKEND: "backend" },

        resolvePinnedClientMetadata: () => ({
          platformMismatch: false,
          deviceFamilyMismatch: false,
        }),
        normalizeNodeHostCompatibilityMetadata: (x: unknown) => x,
        isBrowserCopilotClient: () => false,
        resolveGatewayConnectPolicyFailure: () => undefined,
        resolvePairingApprovalPlan: async () => ({
          localApproval,
          silent: pending.silent,
          trustedProxyAutoApproveScopes: null,
        }),
        requestDevicePairing: async () => {
          events.push("request");
          return { created: true, request: pending };
        },
        getPairedDevice: async () => paired,
        listDevicePairing: async () => ({ pending: [pending] }),
        startGatewayNodePairingSshApproval: () => false,
        buildPairingConnectErrorDetails: (x: unknown) => x,
        buildPairingConnectErrorMessage: () => "pairing required",
        buildPairingConnectCloseReason: () => "pairing required",
        truncateCloseReason: (x: string) => x,
        ErrorCodes: { NOT_PAIRED: "NOT_PAIRED" },
        updatePairedDeviceMetadata: async () => {
          events.push("metadata");
        },
        issueGatewayConnectDeviceTokens: async () => {
          events.push("issue");
          return {};
        },
        approveDevicePairing: async () => {
          throw Error("unexpected automatic approval");
        },
      };
      const resolve = vm.runInNewContext(native + "\nauthorizeGatewayConnectDevice", fixture);
      const skip = vm.runInNewContext(
        extract(auth, "shouldSkipLocalBackendSelfPairing") + "\nshouldSkipLocalBackendSelfPairing",
        fixture,
      );
      assert.equal(
        skip({ connectParams, locality: "direct_local", authMethod: "device-token" }),
        false,
      );
      const tokenCheck = vm.runInNewContext("({" + tokenWrapper + "}).verifyDeviceToken", {
        ...fixture,
        connectParams,
        verifyDeviceToken: async () => ({ ok: false, reason: "scope-mismatch" }),
        getRequiredSharedGatewaySessionGeneration: undefined,
      });
      assert.equal((await tokenCheck({ role: "operator", scopes: ["operator.admin"] })).ok, true);
      const context = {
        connectParams,
        configSnapshot: { gateway: {} },
        handler: {
          connId: "fixture",
          buildRequestContext: () => ({ broadcast: () => {} }),
          close: () => events.push("close"),
          setHandshakeState: (x: string) => events.push(x),
          setCloseCause: () => {},
          logGateway: { warn: () => {}, info: () => {} },
        },
        sendHandshakeErrorResponse: (code: string) => events.push(code),
      };
      const state = {
        role: "operator",
        device: { id: "fixture" },
        devicePublicKey: "fixture-key",
        authMethod: "device-token",
        authResult: {},
        scopes: ["operator.admin"],
        hasRequestedScopes: true,
        skipLocalBackendSelfPairing: false,
        controlUiPairingKind: null,
      };
      // A device-token connection cannot obtain native silent scope approval;
      // also exercise the explicit deferral against a deliberately silent plan.
      if (
        localApproval === "silent" &&
        !baseline.includes("operator.pairing") &&
        !baseline.includes("operator.admin")
      )
        continue;
      const result = await resolve(context, state);
      const approved = baseline.includes("operator.admin");
      assert.equal(Boolean(result), approved);
      assert.equal(events.includes("issue"), approved);
      assert.equal(events.includes("NOT_PAIRED"), !approved);
      assert.deepEqual(paired.approvedScopes, baseline);
    }
  }
}
