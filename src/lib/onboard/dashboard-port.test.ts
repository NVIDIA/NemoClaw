// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  findAvailableDashboardPort,
  findDashboardForwardOwner,
  getRegistryOccupiedDashboardPorts,
  preflightDashboardPortRangeAvailability,
  resolveCreateSandboxDashboardPort,
} from "../../../dist/lib/onboard/dashboard-port";

describe("findDashboardForwardOwner", () => {
  it("parses openshell forward list column format (#2169)", () => {
    const forwardList = [
      "SANDBOX     BIND             PORT   PID     STATUS",
      "test21      127.0.0.1        18789  42101   active",
      "other       127.0.0.1        18790  42102   active",
      "stopped     127.0.0.1        18792  42103   stopped",
      "ansi        127.0.0.1        18793  42104   \u001b[32mrunning\u001b[0m",
    ].join("\n");

    assert.equal(findDashboardForwardOwner(forwardList, "18789"), "test21");
    assert.equal(findDashboardForwardOwner(forwardList, "18790"), "other");
    assert.equal(findDashboardForwardOwner(forwardList, "18791"), null);
    assert.equal(findDashboardForwardOwner(forwardList, "18792"), null);
    assert.equal(findDashboardForwardOwner(forwardList, "18793"), "ansi");
    assert.equal(findDashboardForwardOwner("", "18789"), null);
    assert.equal(findDashboardForwardOwner(null, "18789"), null);
    assert.equal(findDashboardForwardOwner(undefined, "18789"), null);
    const falsePositive = "sandbox18789 127.0.0.1 42001 9999 active";
    assert.equal(findDashboardForwardOwner(falsePositive, "18789"), null);
  });
});

describe("findAvailableDashboardPort port-conflict detection (#3260)", () => {
  const stubBound = (...bound: number[]) => {
    const set = new Set(bound);
    return (port: number) => set.has(port);
  };

  it("returns the preferred port when no forward owns it and the host says it is free", () => {
    assert.equal(findAvailableDashboardPort("cursor", 18789, "", stubBound()), 18789);
  });

  it("skips the preferred port when host reports it bound and falls through to the range scan", () => {
    assert.equal(findAvailableDashboardPort("cursor", 18789, "", stubBound(18789)), 18790);
  });

  it("skips ports owned by other sandboxes and host-bound ports together", () => {
    const forwardList = [
      "SANDBOX  BIND  PORT  PID  STATUS",
      "alpha    127.0.0.1  18789  111  running",
    ].join("\n");
    assert.equal(findAvailableDashboardPort("cursor", 18789, forwardList, stubBound(18790)), 18791);
  });

  it("returns the preferred port when this sandbox already owns it", () => {
    const forwardList = [
      "SANDBOX  BIND  PORT  PID  STATUS",
      "cursor   127.0.0.1  18789  111  running",
    ].join("\n");
    assert.equal(findAvailableDashboardPort("cursor", 18789, forwardList, stubBound(18789)), 18789);
  });

  it("throws when every port in the range is occupied by other sandboxes", () => {
    const lines = ["SANDBOX  BIND  PORT  PID  STATUS"];
    for (let p = 18789; p <= 18799; p++) {
      lines.push(`other${p}    127.0.0.1  ${p}  ${p}  running`);
    }
    assert.throws(
      () => findAvailableDashboardPort("cursor", 18789, lines.join("\n"), stubBound()),
      /All dashboard ports in range 18789-18799 are occupied/,
    );
  });

  it("includes host-bound ports in the exhaustion error so users know what's blocking them", () => {
    const allBound = new Set<number>();
    for (let p = 18789; p <= 18799; p++) allBound.add(p);
    assert.throws(
      () => findAvailableDashboardPort("cursor", 18789, "", (p) => allBound.has(p)),
      /18789 → non-OpenShell host listener/,
    );
  });

  it("probes each port at most once even when the preferred port is in the range", () => {
    const seen: number[] = [];
    const stub = (port: number) => {
      seen.push(port);
      return port === 18789;
    };
    findAvailableDashboardPort("cursor", 18789, "", stub);
    assert.deepEqual(seen, [18789, 18790]);
  });
});

describe("resolveCreateSandboxDashboardPort", () => {
  it("lets --control-ui-port override CHAT_UI_URL, registry, agent, and default ports", () => {
    let preferredSeen: number | null = null;
    const result = resolveCreateSandboxDashboardPort({
      sandboxName: "cursor",
      controlUiPort: 19000,
      chatUiUrlEnv: "http://127.0.0.1:18790",
      persistedPort: 18791,
      agentForwardPort: 18792,
      defaultPort: 18793,
      forwardListOutput: "",
      findAvailablePort: (_sandboxName, preferredPort) => {
        preferredSeen = preferredPort;
        return preferredPort;
      },
    });

    assert.equal(preferredSeen, 19000);
    assert.equal(result.preferredPort, 19000);
    assert.equal(result.effectivePort, 19000);
    assert.equal(result.chatUiUrl, "http://127.0.0.1:19000");
  });

  it("uses CHAT_UI_URL port before registry and rewrites the URL to the allocated port", () => {
    const warnings: string[] = [];
    const result = resolveCreateSandboxDashboardPort({
      sandboxName: "cursor",
      controlUiPort: null,
      chatUiUrlEnv: "https://chat.example.test:18790/ui/",
      persistedPort: 18791,
      agentForwardPort: 18792,
      defaultPort: 18793,
      forwardListOutput: "FORWARDS",
      findAvailablePort: (sandboxName, preferredPort, forwardListOutput) => {
        assert.equal(sandboxName, "cursor");
        assert.equal(preferredPort, 18790);
        assert.equal(forwardListOutput, "FORWARDS");
        return 18794;
      },
      warn: (message) => warnings.push(message),
    });

    assert.equal(result.preferredPort, 18790);
    assert.equal(result.effectivePort, 18794);
    assert.equal(result.chatUiUrl, "https://chat.example.test:18794/ui");
    assert.deepEqual(warnings, ["  ! Port 18790 is taken. Using port 18794 instead."]);
  });

  it("falls back through registry, agent, and default ports", () => {
    const preferredPorts: number[] = [];
    const resolve = (persistedPort: number | null, agentForwardPort: number | null | undefined) =>
      resolveCreateSandboxDashboardPort({
        sandboxName: "cursor",
        controlUiPort: null,
        chatUiUrlEnv: null,
        persistedPort,
        agentForwardPort,
        defaultPort: 18793,
        forwardListOutput: "",
        findAvailablePort: (_sandboxName, preferredPort) => {
          preferredPorts.push(preferredPort);
          return preferredPort;
        },
      });

    assert.equal(resolve(18791, 18792).preferredPort, 18791);
    assert.equal(resolve(null, 18792).preferredPort, 18792);
    assert.equal(resolve(null, null).preferredPort, 18793);
    assert.deepEqual(preferredPorts, [18791, 18792, 18793]);
  });

  it("normalizes schemeless CHAT_UI_URL values before preserving their host", () => {
    const result = resolveCreateSandboxDashboardPort({
      sandboxName: "cursor",
      controlUiPort: null,
      chatUiUrlEnv: "remote.example.test:18790",
      persistedPort: null,
      agentForwardPort: null,
      defaultPort: 18789,
      forwardListOutput: "",
      findAvailablePort: (_sandboxName, preferredPort) => preferredPort,
    });

    assert.equal(result.preferredPort, 18790);
    assert.equal(result.chatUiUrl, "http://remote.example.test:18790");
  });

  it("preserves malformed CHAT_UI_URL failure when the env URL would be used", () => {
    assert.throws(
      () =>
        resolveCreateSandboxDashboardPort({
          sandboxName: "cursor",
          controlUiPort: null,
          chatUiUrlEnv: "https://example.test:abc",
          persistedPort: 18791,
          agentForwardPort: null,
          defaultPort: 18789,
          forwardListOutput: "",
          findAvailablePort: (_sandboxName, preferredPort) => preferredPort,
        }),
      /Invalid URL/,
    );
  });

  it("ignores malformed CHAT_UI_URL when --control-ui-port supplies the URL", () => {
    const result = resolveCreateSandboxDashboardPort({
      sandboxName: "cursor",
      controlUiPort: 19000,
      chatUiUrlEnv: "https://example.test:abc",
      persistedPort: 18791,
      agentForwardPort: null,
      defaultPort: 18789,
      forwardListOutput: "",
      findAvailablePort: (_sandboxName, preferredPort) => preferredPort,
    });

    assert.equal(result.preferredPort, 19000);
    assert.equal(result.chatUiUrl, "http://127.0.0.1:19000");
  });
});

describe("findAvailableDashboardPort multi-gateway registry occupancy", () => {
  const stubBound = (...bound: number[]) => {
    const set = new Set(bound);
    return (port: number) => set.has(port);
  };

  it("treats ports persisted to sibling sandboxes in the registry as occupied even when the active gateway's forward list does not see them", () => {
    const registryOccupied = new Map<string, string>([["18789", "instance-a"]]);

    assert.equal(
      findAvailableDashboardPort("instance-b", 18789, "", stubBound(), registryOccupied),
      18790,
    );
  });

  it("does not block the current sandbox from reusing its own registry-persisted port", () => {
    const registryOccupied = new Map<string, string>([["18789", "instance-a"]]);

    assert.equal(
      findAvailableDashboardPort("instance-a", 18789, "", stubBound(), registryOccupied),
      18789,
    );
  });

  it("ignores registry entries with null or invalid dashboard ports", () => {
    const noPorts = new Map<string, string>();

    assert.equal(findAvailableDashboardPort("instance-b", 18789, "", stubBound(), noPorts), 18789);
  });

  it("includes registry-owned ports in the exhaustion error so the operator can see who holds them", () => {
    const lines = ["SANDBOX  BIND  PORT  PID  STATUS"];
    for (let p = 18789; p <= 18798; p++) {
      lines.push(`forwarded${p}    127.0.0.1  ${p}  ${p}  running`);
    }
    const registryOccupied = new Map<string, string>([["18799", "instance-z"]]);

    assert.throws(
      () =>
        findAvailableDashboardPort(
          "instance-y",
          18789,
          lines.join("\n"),
          stubBound(),
          registryOccupied,
        ),
      /18799 → instance-z/,
    );
  });

  it("lets the active gateway's forward-list entry win when both views see the same port", () => {
    const forwardList = [
      "SANDBOX  BIND  PORT  PID  STATUS",
      "live     127.0.0.1  18789  111  running",
    ].join("\n");
    const registryOccupied = new Map<string, string>([["18789", "stale"]]);

    assert.throws(
      () => findAvailableDashboardPort("fresh", 18789, forwardList, () => true, registryOccupied),
      /18789 → live/,
    );
  });
});

describe("getRegistryOccupiedDashboardPorts", () => {
  it("returns a port→sandbox map for every sibling sandbox with a persisted dashboard port", () => {
    const occupied = getRegistryOccupiedDashboardPorts("current", () => ({
      sandboxes: [
        { name: "alpha", dashboardPort: 18789 },
        { name: "beta", dashboardPort: 18790 },
        { name: "current", dashboardPort: 18791 },
      ],
    }));

    assert.equal(occupied.size, 2);
    assert.equal(occupied.get("18789"), "alpha");
    assert.equal(occupied.get("18790"), "beta");
    assert.equal(occupied.has("18791"), false);
  });

  it("skips sandboxes with null, undefined, or non-numeric dashboardPort values", () => {
    const occupied = getRegistryOccupiedDashboardPorts("current", () => ({
      sandboxes: [
        { name: "alpha", dashboardPort: null },
        { name: "beta", dashboardPort: undefined },
        { name: "gamma" },
        { name: "delta", dashboardPort: 18790 },
      ],
    }));

    assert.equal(occupied.size, 1);
    assert.equal(occupied.get("18790"), "delta");
  });

  it("propagates registry read errors so the allocator does not silently hand out a colliding port", () => {
    assert.throws(
      () =>
        getRegistryOccupiedDashboardPorts("current", () => {
          throw new Error("registry locked");
        }),
      /registry locked/,
    );
  });
});

describe("preflightDashboardPortRangeAvailability (#3953)", () => {
  const allBound = (_p: number) => true;
  const noneBound = (_p: number) => false;
  const someBound = (...bound: number[]) => {
    const set = new Set(bound);
    return (p: number) => set.has(p);
  };

  it("exits 1 with the canonical message when every port in the range is bound", () => {
    let exitCode: number | undefined;
    const exitFn = ((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code ?? 0}__`);
    }) as (code?: number) => never;
    const stderrChunks: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => {
      stderrChunks.push(msg);
    };
    try {
      assert.throws(() => preflightDashboardPortRangeAvailability(allBound, exitFn), /__exit_1__/);
    } finally {
      console.error = origError;
    }
    assert.equal(exitCode, 1);
    const combined = stderrChunks.join("\n");
    assert.match(combined, /All dashboard ports in range 18789-18799 are occupied:/);
    assert.match(combined, /  18789 → non-OpenShell host listener/);
    assert.match(combined, /  18799 → non-OpenShell host listener/);
    assert.match(combined, /--control-ui-port <N>/);
  });

  it("returns without exiting when at least one port in the range is free", () => {
    // Even if 10 of 11 ports are bound, the one free port short-circuits success.
    const bound = someBound(18789, 18790, 18791, 18792, 18793, 18794, 18795, 18796, 18797, 18798);
    preflightDashboardPortRangeAvailability(bound, (() => {
      throw new Error("exitFn must not be called when a port is free");
    }) as (code?: number) => never);
  });

  it("returns without exiting when no port is bound", () => {
    preflightDashboardPortRangeAvailability(noneBound, (() => {
      throw new Error("exitFn must not be called when no port is bound");
    }) as (code?: number) => never);
  });
});
