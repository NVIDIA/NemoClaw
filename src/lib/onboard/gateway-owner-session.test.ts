// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../state/onboard-session";
import {
  bindGatewayOwnerSession,
  type GatewayOwnerSessionDeps,
  prepareGatewayOwnerAttempt,
} from "./gateway-owner-session";
import { checkpointGatewayOwner, resolveGatewayOwner } from "./gateway-ownership";

const MANAGED_OWNER = resolveGatewayOwner({ declaration: null, hasPackagedService: false });
const EXTERNAL_OWNER = resolveGatewayOwner({
  declaration: {
    version: 1,
    mode: "externally-supervised",
    endpoint: "http://127.0.0.1:8080",
    stateDir: "/var/lib/openshell/gateway",
    supervisor: {
      kind: "systemd-system",
      serviceName: "openshell-gateway.service",
      execPath: "/usr/local/bin/openshell-gateway",
    },
    requiredCapabilities: [],
  },
  hasPackagedService: false,
});

function deps(owner = MANAGED_OWNER, session: Session | null = createSession()) {
  let current = session;
  const values: GatewayOwnerSessionDeps = {
    getGatewayOwner: () => owner,
    loadSession: () => current,
    updateSession: (mutator) => {
      const target = current ?? createSession();
      current = mutator(target) ?? target;
      return current;
    },
    resetGatewayOwnerBinding: vi.fn(),
  };
  return { deps: values, session: () => current };
}

describe("gateway owner session binding", () => {
  it("resets attempt-local ownership for a fresh run", () => {
    const state = deps();

    prepareGatewayOwnerAttempt(false, state.deps);

    expect(state.deps.resetGatewayOwnerBinding).toHaveBeenCalledOnce();
  });

  it("rejects an external owner on resume when no durable owner proof exists", () => {
    const state = deps(EXTERNAL_OWNER);

    expect(() => prepareGatewayOwnerAttempt(true, state.deps)).toThrow(
      /does not record a gateway lifecycle authority/,
    );
  });

  it("backfills a legacy managed session before the gateway phase", () => {
    const state = deps();

    const bound = bindGatewayOwnerSession(state.session(), state.deps);

    expect(bound.checkpoint?.gatewayOwner).toEqual(checkpointGatewayOwner(MANAGED_OWNER));
  });
});
