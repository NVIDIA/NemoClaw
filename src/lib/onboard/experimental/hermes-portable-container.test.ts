// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  HermesPortableConfiguredReceipt,
  HermesPortablePendingReceipt,
} from "./hermes-portable-receipt";
import {
  buildHermesPortablePodmanEnvironment,
  configureHermesPortableRestartPolicy,
  enrollHermesPortableContainer,
  hermesPortableContainerInternals,
  probeHermesPortableAuthenticatedHealth,
  startHermesPortableContainer,
  stopHermesPortableContainer,
  type HermesPortablePodmanResult,
} from "./hermes-portable-container";

const ID = "a".repeat(64);
const IMAGE = "b".repeat(64);
const SANDBOX_ID = "sandbox-id-1";
const LABELS = {
  "openshell.managed": "true",
  "openshell.ai/sandbox-id": SANDBOX_ID,
  "openshell.ai/sandbox-name": "alpha",
  "openshell.ai/sandbox-namespace": "",
  "openshell.ai/sandbox-workspace": "default",
};

describe("Hermes portable Podman environment", () => {
  it("uses only the receipt-owned current-user namespace", () => {
    const authority = receipt().runtimeAuthority;
    const environment = buildHermesPortablePodmanEnvironment(authority, {
      HOME: authority.homeDir,
      XDG_CONFIG_HOME: authority.configHome,
      XDG_RUNTIME_DIR: authority.runtimeDir,
      HTTP_PROXY: "https://user:secret@proxy.test",
      KUBECONFIG: "/tmp/kubeconfig",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });

    expect(environment).toEqual({
      HOME: authority.homeDir,
      XDG_CONFIG_HOME: authority.configHome,
      XDG_RUNTIME_DIR: authority.runtimeDir,
    });
  });

  it("rejects namespace drift", () => {
    const authority = receipt().runtimeAuthority;

    expect(() =>
      buildHermesPortablePodmanEnvironment(authority, { HOME: "/home/replacement" }),
    ).toThrow("current-user namespace disagrees");
  });

  it.each([
    ["CONTAINER_HOST", "ssh://remote.test/run/podman.sock"],
    ["DOCKER_CONTEXT", "remote-context"],
    ["DOCKER_HOST", "unix:///run/user/1000/other/podman.sock"],
  ])("rejects ambient %s selection", (name, value) => {
    const authority = receipt().runtimeAuthority;

    expect(() =>
      buildHermesPortablePodmanEnvironment(authority, {
        HOME: authority.homeDir,
        [name]: value,
      }),
    ).toThrow("connection selector is not allowed");
  });
});

function receipt(): HermesPortablePendingReceipt {
  const uid = process.getuid!();
  return {
    schemaVersion: 7,
    agent: "hermes",
    phase: "pending",
    transactionId: randomUUID(),
    createIntentSha256: "c".repeat(64),
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    runtimeAuthority: {
      schemaVersion: 1,
      kind: "podman",
      ownership: "current-user",
      uid,
      homeDir: "/home/test",
      configHome: "/home/test/.config",
      runtimeDir: `/run/user/${String(uid)}`,
      socketPath: `/run/user/${String(uid)}/podman/podman.sock`,
    },
    openshellExecutableAuthority: {} as never,
    podmanExecutableAuthority: {} as never,
    socketAuthority: {
      device: "1",
      inode: "2",
      mode: "49536",
      ownerUid: String(uid),
      socketPath: `/run/user/${String(uid)}/podman/podman.sock`,
      directoryChain: [],
    },
    startup: {} as never,
    policy: {} as never,
  };
}

function inspect(
  restartPolicy = "no",
  labels = LABELS,
  running = true,
  status = running ? "running" : "exited",
): HermesPortablePodmanResult {
  return {
    status: 0,
    stdout: JSON.stringify([
      {
        Id: ID,
        Image: IMAGE,
        Name: `openshell-default--alpha-${SANDBOX_ID}`,
        Config: { Labels: labels },
        State: { Running: running, Paused: false, Status: status },
        HostConfig: { RestartPolicy: { Name: restartPolicy } },
      },
    ]),
    stderr: "",
  };
}

function activeReceipt(running = true): HermesPortableConfiguredReceipt {
  const pending = receipt();
  const { policy: _policy, ...transaction } = pending;
  return {
    ...transaction,
    phase: "active",
    previousPhaseSha256: "c".repeat(64),
    startup: { health: { successStatus: 200 } } as never,
    container: {
      containerId: ID,
      sandboxId: SANDBOX_ID,
      imageId: `sha256:${IMAGE}`,
      labelsSha256: hermesPortableContainerInternals.labelsDigest(LABELS),
      name: `openshell-default--alpha-${SANDBOX_ID}`,
      running,
      restartPolicy: "unless-stopped",
    },
  };
}

describe("Hermes portable container authority", () => {
  it("enrolls exactly one running full-ID container with exact OpenShell labels (#9203)", () => {
    const podman = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: `${ID}\n`, stderr: "" })
      .mockReturnValueOnce(inspect());
    const assertSocketAuthority = vi.fn();

    const enrolled = enrollHermesPortableContainer(receipt(), SANDBOX_ID, {
      podman,
      assertSocketAuthority,
    });

    expect(enrolled.authority).toMatchObject({
      containerId: ID,
      imageId: `sha256:${IMAGE}`,
      running: true,
      restartPolicy: "no",
      sandboxId: SANDBOX_ID,
    });
    expect(enrolled.authority.labelsSha256).toBe(
      hermesPortableContainerInternals.labelsDigest(LABELS),
    );
    expect(assertSocketAuthority).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["no candidate", "", 0],
    ["duplicate candidates", `${ID}\n${"c".repeat(64)}\n`, 2],
    ["short candidate", "abc\n", 1],
  ])("rejects %s before exact inspect (#9203)", (_label, stdout, count) => {
    const podman = vi.fn(() => ({ status: 0, stdout, stderr: "" }));

    expect(() =>
      enrollHermesPortableContainer(receipt(), SANDBOX_ID, {
        podman,
        assertSocketAuthority: vi.fn(),
      }),
    ).toThrow(`requires exactly one full container ID; found ${String(count)}`);
    expect(podman).toHaveBeenCalledTimes(1);
  });

  it("rejects label, image, and OpenShell identity disagreement (#9203)", () => {
    const changedLabels = { ...LABELS, "openshell.ai/sandbox-id": "other" };
    const podman = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: `${ID}\n`, stderr: "" })
      .mockReturnValueOnce(inspect("no", changedLabels));

    expect(() =>
      enrollHermesPortableContainer(receipt(), SANDBOX_ID, {
        podman,
        assertSocketAuthority: vi.fn(),
      }),
    ).toThrow("disagrees with OpenShell");
  });

  it("updates one exact full ID and verifies running restart authority (#9203)", () => {
    const pending = receipt();
    const { policy: _policy, ...transaction } = pending;
    const container = {
      containerId: ID,
      sandboxId: SANDBOX_ID,
      imageId: `sha256:${IMAGE}`,
      labelsSha256: hermesPortableContainerInternals.labelsDigest(LABELS),
      name: `openshell-default--alpha-${SANDBOX_ID}`,
      running: true,
      restartPolicy: "no",
    };
    const configuring = {
      ...transaction,
      phase: "configuring" as const,
      previousPhaseSha256: "c".repeat(64),
      container,
    };
    const podman = vi
      .fn()
      .mockReturnValueOnce(inspect())
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce(inspect("unless-stopped"));

    expect(
      configureHermesPortableRestartPolicy(configuring, {
        podman,
        assertSocketAuthority: vi.fn(),
      }).authority.restartPolicy,
    ).toBe("unless-stopped");
    expect(podman.mock.calls[1]?.[0]).toEqual([
      "container",
      "update",
      "--restart=unless-stopped",
      ID,
    ]);
  });

  it("preserves configuring authority when update outcome is ambiguous (#9203)", () => {
    const pending = receipt();
    const { policy: _policy, ...transaction } = pending;
    const configuring = {
      ...transaction,
      phase: "configuring" as const,
      previousPhaseSha256: "c".repeat(64),
      container: {
        ...enrollHermesPortableContainer(pending, SANDBOX_ID, {
          podman: vi
            .fn()
            .mockReturnValueOnce({ status: 0, stdout: `${ID}\n`, stderr: "" })
            .mockReturnValueOnce(inspect()),
          assertSocketAuthority: vi.fn(),
        }).authority,
      },
    };
    const podman = vi
      .fn()
      .mockReturnValueOnce(inspect())
      .mockReturnValueOnce({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      });

    expect(() =>
      configureHermesPortableRestartPolicy(configuring, {
        podman,
        assertSocketAuthority: vi.fn(),
      }),
    ).toThrow("restart-policy update failed");
    expect(podman).toHaveBeenCalledTimes(2);
  });

  it("proves Bearer-authenticated health inside the exact container without host credentials (#9203)", () => {
    const podman = vi
      .fn()
      .mockReturnValueOnce(inspect("unless-stopped"))
      .mockReturnValueOnce(inspect("unless-stopped"));
    const authenticatedHealth = vi.fn((_script: string, _timeoutMs: number) => ({
      status: 0,
      stdout: "200\n",
      stderr: "",
    }));

    probeHermesPortableAuthenticatedHealth(activeReceipt(), {
      podman,
      authenticatedHealth,
      assertSocketAuthority: vi.fn(),
    });

    expect(podman).toHaveBeenCalledTimes(2);
    const [script, timeout] = authenticatedHealth.mock.calls[0]!;
    expect(timeout).toBe(40_000);
    expect(script).toContain("API_SERVER_KEY");
    expect(script).toContain("NoRedirect");
    expect(script).toContain("ProxyHandler({})");
    expect(script).toContain("redirect refused");
    expect(script).not.toContain("Bearer test-token");
  });

  it("rejects redirected authenticated health without exposing credentials (#9203)", () => {
    const podman = vi.fn().mockReturnValueOnce(inspect("unless-stopped"));
    const authenticatedHealth = vi.fn(() => ({ status: 0, stdout: "302\n", stderr: "" }));

    expect(() =>
      probeHermesPortableAuthenticatedHealth(activeReceipt(), {
        podman,
        authenticatedHealth,
        assertSocketAuthority: vi.fn(),
      }),
    ).toThrow("returned status '302'");

    const serializedCalls = JSON.stringify(podman.mock.calls);
    expect(serializedCalls).not.toContain("Bearer " + "a".repeat(64));
    expect(hermesPortableContainerInternals.authenticatedHealthScript).toContain("NoRedirect");
    expect(hermesPortableContainerInternals.authenticatedHealthScript).not.toContain(
      "urllib.request.urlopen",
    );
  });

  it("does not accept unauthenticated health status (#9203)", () => {
    const podman = vi.fn().mockReturnValueOnce(inspect("unless-stopped"));
    const authenticatedHealth = vi.fn(() => ({ status: 0, stdout: "401\n", stderr: "" }));

    expect(() =>
      probeHermesPortableAuthenticatedHealth(activeReceipt(), {
        podman,
        authenticatedHealth,
        assertSocketAuthority: vi.fn(),
      }),
    ).toThrow("returned status '401'");
  });

  it("does not fall back to Podman exec when the OpenShell health observer is missing (#9211)", () => {
    const podman = vi.fn().mockReturnValueOnce(inspect("unless-stopped"));

    expect(() =>
      probeHermesPortableAuthenticatedHealth(activeReceipt(), {
        podman,
        assertSocketAuthority: vi.fn(),
      }),
    ).toThrow("authenticated Hermes health observer is unavailable");
    expect(podman).toHaveBeenCalledTimes(1);
  });

  it("does not expose inspect output or error text in command failures (#9203)", () => {
    const podman = vi.fn(() => ({
      status: 1,
      stdout: '{"Config":{"Env":["API_KEY=do-not-log"]}}',
      stderr: "do-not-log",
      error: Object.assign(new Error("do-not-log"), { code: "EIO" }),
    }));

    expect(() =>
      enrollHermesPortableContainer(receipt(), SANDBOX_ID, {
        podman,
        assertSocketAuthority: vi.fn(),
      }),
    ).toThrow("status 1 (EIO)");
    try {
      enrollHermesPortableContainer(receipt(), SANDBOX_ID, {
        podman,
        assertSocketAuthority: vi.fn(),
      });
    } catch (error) {
      expect(String(error)).not.toContain("do-not-log");
      expect(String(error)).not.toContain("Config");
    }
  });

  it("starts one exact full ID and never discovers by name (#9203)", () => {
    const podman = vi
      .fn()
      .mockReturnValueOnce(inspect("unless-stopped", LABELS, false))
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce(inspect("unless-stopped"));

    expect(
      startHermesPortableContainer(activeReceipt(false), {
        podman,
        assertSocketAuthority: vi.fn(),
      }),
    ).toBe("started");
    expect(podman.mock.calls[1]?.[0]).toEqual(["container", "start", ID]);
  });

  it("reconciles a timed-out exact stop without retry or kill (#9203)", () => {
    let now = 0;
    const podman = vi
      .fn()
      .mockReturnValueOnce(inspect("unless-stopped"))
      .mockReturnValueOnce({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      })
      .mockReturnValueOnce(inspect("unless-stopped", LABELS, false));

    expect(
      stopHermesPortableContainer(activeReceipt(), {
        podman,
        assertSocketAuthority: vi.fn(),
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).toBe("stopped");
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([
      [["container", "stop", ID], 40_000],
    ]);
  });

  it("waits for exited after a successful stop reports a transitional state (#9203)", () => {
    let now = 0;
    const podman = vi
      .fn()
      .mockReturnValueOnce(inspect("unless-stopped"))
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce(inspect("unless-stopped", LABELS, false, "stopping"))
      .mockReturnValueOnce(inspect("unless-stopped", LABELS, false, "exited"));

    expect(
      stopHermesPortableContainer(activeReceipt(), {
        podman,
        assertSocketAuthority: vi.fn(),
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).toBe("stopped");
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(1);
  });

  it("reconciles an already-stopping container without another stop command (#9203)", () => {
    let now = 0;
    const podman = vi
      .fn()
      .mockReturnValueOnce(inspect("unless-stopped", LABELS, false, "stopping"))
      .mockReturnValueOnce(inspect("unless-stopped", LABELS, false, "exited"));

    expect(
      stopHermesPortableContainer(activeReceipt(), {
        podman,
        assertSocketAuthority: vi.fn(),
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).toBe("stopped");
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });
});
