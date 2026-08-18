// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayObservationSnapshot,
  GatewayReadinessProjection,
} from "../../readiness/gateway";
import type { Session } from "../../state/onboard-session";
import * as fatalRuntimePreflight from "../fatal-runtime-preflight";
import type { GatewayOwner } from "../gateway-ownership";
import {
  createOnboardPreflightGatewayAuthority,
  preparePreflightGatewayAuthority,
} from "./preflight-gateway-authority";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preflight gateway authority", () => {
  it("assembles the default readiness path lazily and preserves preflight order", async () => {
    const events: string[] = [];
    const owner: GatewayOwner = {
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    };
    const gatewayReadiness: GatewayReadinessProjection = {
      observations: [
        { id: "gateway.management.mode", state: "present", value: "nemoclaw-managed" },
      ],
      capabilities: [
        { id: "gateway.authority.resolved", state: "present" },
        { id: "gateway.attachment.valid", state: "present" },
        { id: "gateway.reuse.ready", state: "present" },
        { id: "gateway.version.compatible", state: "present" },
        { id: "gateway.port.uncontested", state: "present" },
      ],
      findings: [],
      evidence: [],
    };
    const gatewaySnapshot: GatewayObservationSnapshot = {
      observedAt: "2026-08-17T12:00:00.000Z",
      completedAt: "2026-08-17T12:00:00.000Z",
      observations: {
        owner: {
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          mode: "nemoclaw-managed",
          source: "standalone",
          endpoint: null,
          supervisor: null,
          requiredCapabilities: [],
        },
        attachmentState: "not-applicable",
        reuseState: "healthy",
        driftState: "not-detected",
        portConflictState: "none",
      },
    };
    const collectReadiness = vi.fn(async (collectorDeps) => {
      events.push("collect readiness");
      expect(collectorDeps.gatewayName?.()).toBe("nemoclaw");
      expect(collectorDeps.gatewayPort?.()).toBe(8080);
      expect(collectorDeps.resolveOwner?.()).toBe(owner);
      return { projection: gatewayReadiness, snapshot: gatewaySnapshot };
    });
    const session = {} as Session;
    const deps = {
      gatewayName: vi.fn(() => "nemoclaw"),
      gatewayPort: vi.fn(() => {
        events.push("read gateway port");
        return 8080;
      }),
      collectGatewayReadiness: collectReadiness,
      getGatewayOwnerDeps: vi.fn(() => ({
        resolveGatewayOwner: vi.fn(() => owner),
        probeGatewayAttachment: vi.fn(),
      })),
      isNonInteractive: vi.fn(() => true),
      ensureOpenshellForOnboard: vi.fn(
        (_exitProcess: (code: number) => never, persist: (value: GatewayOwner) => void) => {
          events.push("ensure openshell");
          persist(owner);
        },
      ),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        events.push("update session");
        mutator(session);
        return session;
      }),
      adoptPackagedGatewayAuthorityAfterTrustedInstall: vi.fn(
        (value: Session, adoptedOwner: GatewayOwner) => {
          events.push("adopt authority");
          expect(value).toBe(session);
          return adoptedOwner;
        },
      ),
      checkPortAvailable: vi.fn(async () => {
        events.push("check port");
        return { ok: true };
      }),
      isDockerDriverGatewayPortListener: vi.fn(() => false),
      getGatewayReuseSnapshot: vi.fn(() => {
        events.push("get reuse snapshot");
        return {
          gatewayStatus: "",
          gwInfo: "",
          activeGatewayInfo: "",
          gatewayReuseState: "healthy" as const,
        };
      }),
      selectNamedGatewayForReuseIfNeeded: vi.fn((snapshot) => {
        events.push("select named gateway");
        return snapshot;
      }),
      refreshDockerDriverGatewayReuseState: vi.fn(async (state) => {
        events.push("refresh reuse state");
        return state;
      }),
    };
    const authority = createOnboardPreflightGatewayAuthority(deps);
    const runRuntimePreflight = vi
      .spyOn(fatalRuntimePreflight, "runReadinessGatedRuntimePreflight")
      .mockImplementation(async () => ({}) as never);
    const exitProcess = vi.fn((_code: number): never => {
      throw new Error("exit");
    });

    await authority.runRuntimePreflight({}, exitProcess);

    expect(runRuntimePreflight).toHaveBeenCalledWith(
      {},
      {
        nonInteractive: true,
        collectGatewayReadiness: expect.any(Function),
        exitProcess,
      },
    );
    const passedCollector = runRuntimePreflight.mock.calls[0]![1].collectGatewayReadiness;
    await expect(passedCollector()).resolves.toEqual({
      projection: gatewayReadiness,
      snapshot: gatewaySnapshot,
    });

    await expect(authority.prepareGatewayAuthority()).resolves.toEqual({
      externallySupervised: false,
      gatewayReuseState: "healthy",
    });

    expect(events).toEqual([
      "collect readiness",
      "read gateway port",
      "read gateway port",
      "ensure openshell",
      "update session",
      "adopt authority",
      "collect readiness",
      "read gateway port",
      "check port",
      "get reuse snapshot",
      "select named gateway",
      "refresh reuse state",
    ]);
    expect(deps.getGatewayOwnerDeps).toHaveBeenCalledTimes(2);
    expect(deps.gatewayPort).toHaveBeenCalledTimes(3);
    expect(collectReadiness).toHaveBeenCalledTimes(2);
    expect(collectReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayName: deps.gatewayName, gatewayPort: deps.gatewayPort }),
    );
  });

  it("rejects a blocked refreshed projection before reuse or lifecycle handling (#7411)", async () => {
    const gatewayReadiness: GatewayReadinessProjection = {
      observations: [],
      capabilities: [],
      findings: [
        {
          id: "gateway.authority.conflict",
          severity: "blocking",
          summary: "Gateway authority conflicts with the selected endpoint.",
        },
      ],
      evidence: [],
    };
    const getGatewayReuseSnapshot = vi.fn(() => ({
      gatewayStatus: "",
      gwInfo: "",
      activeGatewayInfo: "",
      gatewayReuseState: "healthy" as const,
    }));
    const selectNamedGatewayForReuseIfNeeded = vi.fn();
    const refreshDockerDriverGatewayReuseState = vi.fn();
    const checkPortAvailable = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(
      preparePreflightGatewayAuthority({
        collectGatewayReadiness: async () => gatewayReadiness,
        ensureOpenshell: vi.fn(),
        persistTrustedGatewayOwner: vi.fn(),
        gatewayPort: 8080,
        portConflict: {
          checkPortAvailable,
          getGatewayPortCheckOptions: () => ({}),
          isDockerDriverGatewayPortListener: vi.fn(),
          exitProcess: process.exit,
        },
        getGatewayReuseSnapshot,
        selectNamedGatewayForReuseIfNeeded,
        refreshDockerDriverGatewayReuseState,
      }),
    ).rejects.toThrow("exit 1");

    expect(checkPortAvailable).not.toHaveBeenCalled();
    expect(getGatewayReuseSnapshot).not.toHaveBeenCalled();
    expect(selectNamedGatewayForReuseIfNeeded).not.toHaveBeenCalled();
    expect(refreshDockerDriverGatewayReuseState).not.toHaveBeenCalled();
  });
});
