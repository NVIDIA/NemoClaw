// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  HermesPortableConfiguredReceipt,
  HermesPortablePendingReceipt,
} from "./hermes-portable-receipt";
import {
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

function receipt(): HermesPortablePendingReceipt {
  const uid = process.getuid!();
  return {
    schemaVersion: 5,
    agent: "hermes",
    phase: "pending",
    transactionId: randomUUID(),
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
): HermesPortablePodmanResult {
  return {
    status: 0,
    stdout: JSON.stringify([
      {
        Id: ID,
        Image: IMAGE,
        Name: `openshell-default--alpha-${SANDBOX_ID}`,
        Config: { Labels: labels },
        State: { Running: running, Paused: false, Status: running ? "running" : "exited" },
        HostConfig: { RestartPolicy: { Name: restartPolicy } },
      },
    ]),
    stderr: "",
  };
}

function activeReceipt(running = true): HermesPortableConfiguredReceipt {
  return {
    ...receipt(),
    phase: "active",
    previousPhaseSha256: "c".repeat(64),
    verifiedLivePolicySemanticSha256: "d".repeat(64),
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
      ...pending,
      phase: "configuring" as const,
      previousPhaseSha256: "c".repeat(64),
      verifiedLivePolicySemanticSha256: "d".repeat(64),
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
    const configuring = {
      ...pending,
      phase: "configuring" as const,
      previousPhaseSha256: "c".repeat(64),
      verifiedLivePolicySemanticSha256: "d".repeat(64),
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
      .mockReturnValueOnce({ status: 0, stdout: "200\n", stderr: "" })
      .mockReturnValueOnce(inspect("unless-stopped"));

    probeHermesPortableAuthenticatedHealth(activeReceipt(), {
      podman,
      assertSocketAuthority: vi.fn(),
    });

    const argv = podman.mock.calls[1]?.[0] as string[];
    expect(argv.slice(0, 4)).toEqual(["container", "exec", ID, "python3"]);
    expect(argv.join(" ")).toContain("API_SERVER_KEY");
    expect(argv.join(" ")).toContain("NoRedirect");
    expect(argv.join(" ")).toContain("redirect refused");
    expect(argv.join(" ")).not.toContain("Bearer test-token");
  });

  it("rejects redirected authenticated health without exposing credentials (#9203)", () => {
    const podman = vi
      .fn()
      .mockReturnValueOnce(inspect("unless-stopped"))
      .mockReturnValueOnce({ status: 0, stdout: "302\n", stderr: "" });

    expect(() =>
      probeHermesPortableAuthenticatedHealth(activeReceipt(), {
        podman,
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
    const podman = vi
      .fn()
      .mockReturnValueOnce(inspect("unless-stopped"))
      .mockReturnValueOnce({ status: 0, stdout: "401\n", stderr: "" });

    expect(() =>
      probeHermesPortableAuthenticatedHealth(activeReceipt(), {
        podman,
        assertSocketAuthority: vi.fn(),
      }),
    ).toThrow("returned status '401'");
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
});
