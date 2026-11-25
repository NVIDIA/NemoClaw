// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

export function createAsyncIdentityRuntime(patched: string) {
  const env: Record<string, string> = {};
  const tokenReads: Array<Record<string, unknown>> = [];
  const state = { token: null as object | null, error: null as Error | null, creates: 0, reads: 0 };
  const identity = { deviceId: "ordinary-device" };
  const load = async (readonly: boolean) => {
    if (readonly) state.reads++;
    else state.creates++;
    if (state.error) throw state.error;
    return identity;
  };
  const loadToken = async (params: Record<string, unknown>) => {
    tokenReads.push(params);
    return state.token;
  };
  const runtime = vm.runInNewContext(
    patched +
      ";({resolve:resolveGatewayCallDeviceAuth,identity:resolveDeviceIdentityForGatewayCall,invoke:gatewayAuthInvocation})",
    {
      Buffer,
      URL,
      process: { env, getBuiltinModule: (name: string) => (name === "node:fs" ? fs : crypto) },
      normalizeOptionalString: (value: unknown) =>
        typeof value === "string" ? value.trim() || undefined : undefined,
      GATEWAY_CLIENT_MODES: { CLI: "cli", BACKEND: "backend" },
      GATEWAY_CLIENT_NAMES: { CLI: "cli", GATEWAY_CLIENT: "gateway-client" },
      isLoopbackGatewayUrl: (value: string) => new URL(value).hostname === "127.0.0.1",
      GatewayLocalBackendSharedAuthUnavailableError: Error,
      loadDeviceIdentityIfPresentAsync: () => load(true),
      loadOrCreateDeviceIdentityAsync: () => load(false),
      loadOriginDeviceTokenReadOnly: loadToken,
      loadOriginDeviceToken: loadToken,
      loadDeviceAuthTokenReadOnly: loadToken,
      loadDeviceAuthToken: loadToken,
    },
  );
  return { runtime, env, state, tokenReads, identity };
}
