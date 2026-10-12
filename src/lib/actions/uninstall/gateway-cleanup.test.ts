// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprintOpenShellSandboxId } from "../../domain/sandbox/openshell-identity";

import {
  collectLiveOpenShellGatewayNames,
  retainedDockerSandboxIsAbsent,
  portableGatewayIsReachable,
  removeGatewayRegistration,
  type GatewayCleanupRuntime,
} from "./gateway-cleanup";

function harness(): GatewayCleanupRuntime {
  return {
    commandExists: () => true,
    env: {},
    gatewayLifecycle: {
      supportsLegacyLifecycle: vi.fn(),
      selectGateway: vi.fn(),
      registerGateway: vi.fn(),
      removeGateway: vi.fn().mockResolvedValue({ ok: true, state: "completed" }),
      destroyGateway: vi.fn(),
      listGateways: vi.fn().mockResolvedValue({ ok: true, names: ["owned", "sibling"] }),
    },
    gatewayReuseObserver: {
      observeGatewayReuse: vi.fn().mockResolvedValue({
        healthy: true,
        namedMetadata: true,
        gatewayReuseState: "healthy",
        shouldSelect: false,
        endpoints: [],
        endpointBinding: "unknown",
      }),
    },
    runDocker: vi.fn(),
    resolveGatewayTeardownAuthority: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  };
}

describe("uninstall gateway cleanup through typed capabilities", () => {
  it("uses named health and registry facts without constructing a subprocess", async () => {
    const runtime = harness();
    expect(await portableGatewayIsReachable(runtime, "owned")).toBe(true);
    expect(await collectLiveOpenShellGatewayNames(runtime, "owned")).toEqual(
      new Set(["owned", "sibling"]),
    );
    expect(runtime.gatewayReuseObserver.observeGatewayReuse).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "owned" },
    });
    expect(runtime.gatewayLifecycle.listGateways).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "owned" },
    });
    expect(runtime.runDocker).not.toHaveBeenCalled();
  });
  it("removes only the requested registration through the injected lifecycle", async () => {
    const runtime = harness();
    expect(await removeGatewayRegistration(runtime, "owned", false, 8080)).toBe(true);
    expect(runtime.gatewayLifecycle.removeGateway).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "owned" },
    });
    expect(runtime.gatewayLifecycle.destroyGateway).not.toHaveBeenCalled();
    expect(runtime.runDocker).not.toHaveBeenCalled();
  });
  it("preserves externally supervised state when remove is unsupported", async () => {
    const runtime = harness();
    vi.mocked(runtime.gatewayLifecycle.removeGateway).mockResolvedValue({
      ok: false,
      unsupported: true,
      ambiguous: false,
      error: { kind: "command", reason: "failed", message: "Unsupported remove." },
    });
    expect(await removeGatewayRegistration(runtime, "owned", false, 8080)).toBe(false);
    expect(runtime.gatewayLifecycle.destroyGateway).not.toHaveBeenCalled();
    expect(runtime.resolveGatewayTeardownAuthority).not.toHaveBeenCalled();
  });
});

const siblingLabels = {
  "openshell.ai/managed-by": "openshell",
  "openshell.ai/sandbox-name": "alpha",
  "openshell.ai/sandbox-id": "sibling-native",
  "openshell.ai/sandbox-namespace": "sibling-namespace",
};

const nativeSiblingArgs = ["sandbox", "get", "-g", "nemoclaw", "alpha", "-o", "json"];
const liveSibling = {
  liveId: "sibling-native",
  liveStatus: 0,
  nativeCalls: [] as [string[]][],
  failure: "identity" as string | undefined,
};
it.each([
  {
    ...liveSibling,
    name: "known sibling identity",
    failure: undefined,
    labels: siblingLabels,
    absent: true,
    nativeCalls: [[nativeSiblingArgs]],
  },
  {
    ...liveSibling,
    name: "foreign container",
    labels: { ...siblingLabels, "openshell.ai/managed-by": "foreign" },
    absent: false,
  },
  {
    ...liveSibling,
    name: "selected sandbox identity",
    failure: "selected-container",
    labels: { ...siblingLabels, "openshell.ai/sandbox-id": "selected-native" },
    absent: false,
  },
  {
    ...liveSibling,
    name: "unknown identity",
    labels: { ...siblingLabels, "openshell.ai/sandbox-id": "unknown-native" },
    absent: false,
  },
  {
    ...liveSibling,
    name: "unproven namespace",
    labels: { ...siblingLabels, "openshell.ai/sandbox-namespace": "" },
    absent: false,
  },
  {
    ...liveSibling,
    name: "stale sibling registration",
    labels: siblingLabels,
    liveId: "changed-native",
    absent: false,
    nativeCalls: [[nativeSiblingArgs]],
  },
  {
    ...liveSibling,
    name: "unreachable sibling gateway",
    labels: siblingLabels,
    liveStatus: 1,
    absent: false,
    nativeCalls: [[nativeSiblingArgs]],
  },
])(
  "classifies retained-data inventory with $name",
  ({ labels, absent, liveId, liveStatus, nativeCalls, failure }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retained-inventory-"));
    const id = "b".repeat(64);
    const failures: string[] = [];
    const root = path.join(home, ".nemoclaw");
    fs.mkdirSync(root, { mode: 0o700 });
    fs.writeFileSync(
      path.join(root, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: "alpha",
        sandboxes: {
          alpha: {
            name: "alpha",
            openshellDriver: "docker",
            gatewayName: "nemoclaw",
            gatewayPort: 8080,
            createdAt: "2026-09-23T00:00:00.000Z",
            lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("sibling-native"),
          },
        },
      }),
      { mode: 0o600 },
    );
    const responses = { ps: id + "\n", inspect: JSON.stringify([id, labels]) };
    const capture = vi.fn((args: string[]) => ({
      status: 0,
      stdout: responses[args[0] as keyof typeof responses] ?? "",
      stderr: "",
    }));
    const native = vi.fn((_args: string[]) => ({
      status: liveStatus,
      stdout: JSON.stringify({ name: "alpha", id: liveId }),
      stderr: "",
    }));
    try {
      expect(
        retainedDockerSandboxIsAbsent(
          home,
          9123,
          "alpha",
          {
            name: "alpha",
            gatewayPort: 9123,
            gatewayName: "nemoclaw-9123",
            lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("selected-native"),
          },
          capture,
          native,
          (reason) => failures.push(reason),
        ),
      ).toBe(absent);
      expect(capture).toHaveBeenCalledWith([
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        "label=openshell.ai/sandbox-name=alpha",
        "--format",
        "{{.ID}}",
      ]);
      expect(native.mock.calls).toEqual(nativeCalls);
      expect(failures).toEqual(failure ? [failure] : []);
      expect(fs.existsSync(path.join(root, "sandboxes.json"))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
