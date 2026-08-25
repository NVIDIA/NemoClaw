// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  externalOpenShellGateway,
  observeExternalOpenShellTarget,
  type AuthenticatedOpenShellExternalTargetObserver,
  type OpenShellExternalTargetObserver,
  type OpenShellSandboxError,
  type OpenShellSandboxResult,
} from "./openshell-observation-boundary.cjs";

const TARGET = externalOpenShellGateway(
  "https://openshell.example.test:8443",
  "research",
  "configured-release",
);
const REQUEST = { target: TARGET, timeoutMs: 2_500 } as const;
const INVENTORY = {
  sandboxes: [
    { name: "ready-agent", phase: "Ready", readiness: "ready" },
    { name: "pending-agent", phase: "Provisioning", readiness: "not_ready" },
  ],
} as const;

function rejected<T>(error: OpenShellSandboxError): Promise<OpenShellSandboxResult<T>> {
  return Promise.resolve({ ok: false, error });
}

function successfulClient(callOrder: string[]): AuthenticatedOpenShellExternalTargetObserver {
  return {
    getCurrentUser: vi.fn(async () => {
      callOrder.push("identity");
      return {
        ok: true as const,
        value: { subjectFingerprint: `sha256:${"a".repeat(64)}` },
      };
    }),
    getWorkspace: vi.fn(async () => {
      callOrder.push("workspace");
      return {
        ok: true as const,
        value: { name: "research", phase: "active" as const },
      };
    }),
    listSandboxes: vi.fn(async () => {
      callOrder.push("inventory");
      return { ok: true as const, value: INVENTORY };
    }),
  };
}

function successfulObserver(
  callOrder: string[],
  client = successfulClient(callOrder),
): OpenShellExternalTargetObserver {
  return {
    getGatewayHealth: vi.fn(async () => {
      callOrder.push("health");
      return {
        ok: true as const,
        value: { status: "healthy" as const, release: "configured-release" },
      };
    }),
    connectWithCredentialFile: vi.fn(async () => {
      callOrder.push("credential");
      return { ok: true as const, value: client };
    }),
  };
}

describe("external OpenShell target observation boundary", () => {
  it("collects release, identity, workspace, status, and inventory in the required order (#9872)", async () => {
    const callOrder: string[] = [];
    const client = successfulClient(callOrder);
    const observer = successfulObserver(callOrder, client);

    await expect(observeExternalOpenShellTarget(observer, REQUEST)).resolves.toEqual({
      ok: true,
      value: {
        target: TARGET,
        health: { status: "healthy", release: "configured-release" },
        identity: { subjectFingerprint: `sha256:${"a".repeat(64)}` },
        workspace: { name: "research", phase: "active" },
        inventory: INVENTORY,
      },
    });
    expect(callOrder).toEqual(["health", "credential", "identity", "workspace", "inventory"]);
    expect(observer.getGatewayHealth).toHaveBeenCalledWith(REQUEST);
    expect(observer.connectWithCredentialFile).toHaveBeenCalledWith(REQUEST);
    expect(client.getCurrentUser).toHaveBeenCalledWith(REQUEST);
    expect(client.getWorkspace).toHaveBeenCalledWith(REQUEST);
    expect(client.listSandboxes).toHaveBeenCalledWith(REQUEST);
  });

  it("stops before credential handoff when the public release does not match (#9872)", async () => {
    const callOrder: string[] = [];
    const observer = successfulObserver(callOrder);
    vi.mocked(observer.getGatewayHealth).mockImplementationOnce(async () => {
      callOrder.push("health");
      return {
        ok: true,
        value: { status: "healthy", release: "reported-release" },
      };
    });

    const result = await observeExternalOpenShellTarget(observer, REQUEST);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "compatibility",
        message: "The external OpenShell target release does not match the configured release.",
      },
    });
    expect(callOrder).toEqual(["health"]);
    expect(observer.connectWithCredentialFile).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("reported-release");
  });

  it("preserves a non-ready gateway and terminating workspace as read-only status (#9872)", async () => {
    const callOrder: string[] = [];
    const client = successfulClient(callOrder);
    vi.mocked(client.getWorkspace).mockImplementationOnce(async () => {
      callOrder.push("workspace");
      return {
        ok: true,
        value: { name: "research", phase: "terminating" },
      };
    });
    const observer = successfulObserver(callOrder, client);
    vi.mocked(observer.getGatewayHealth).mockImplementationOnce(async () => {
      callOrder.push("health");
      return {
        ok: true,
        value: { status: "degraded", release: "configured-release" },
      };
    });

    const result = await observeExternalOpenShellTarget(observer, REQUEST);

    expect(result).toMatchObject({
      ok: true,
      value: {
        health: { status: "degraded" },
        workspace: { phase: "terminating" },
      },
    });
    expect(callOrder).toEqual(["health", "credential", "identity", "workspace", "inventory"]);
  });

  it.each([
    [
      "authentication",
      { kind: "authentication", message: "denied: private-credential-value" },
      "OpenShell could not authenticate the external target observation.",
    ],
    [
      "timeout",
      { kind: "timeout", message: "timeout while reading /private/credential-file" },
      "The external OpenShell target observation timed out.",
    ],
    [
      "schema",
      { kind: "schema", message: "invalid response included private-credential-value" },
      "OpenShell returned an invalid observation response.",
    ],
  ] as const)(
    "returns a sanitized %s denial from the authenticated fake client (#9872)",
    async (_label, error, message) => {
      const callOrder: string[] = [];
      const client = successfulClient(callOrder);
      vi.mocked(client.getCurrentUser).mockImplementationOnce(async () => {
        callOrder.push("identity");
        return rejected(error);
      });
      const observer = successfulObserver(callOrder, client);

      const result = await observeExternalOpenShellTarget(observer, REQUEST);

      expect(result).toEqual({ ok: false, error: { kind: error.kind, message } });
      expect(callOrder).toEqual(["health", "credential", "identity"]);
      expect(JSON.stringify(result)).not.toContain("private-credential-value");
      expect(JSON.stringify(result)).not.toContain("/private/credential-file");
    },
  );

  it("sanitizes a credential-stage denial without creating an authenticated client (#9872)", async () => {
    const callOrder: string[] = [];
    const observer = successfulObserver(callOrder);
    vi.mocked(observer.connectWithCredentialFile).mockImplementationOnce(async () => {
      callOrder.push("credential");
      return rejected({
        kind: "authentication",
        message: "invalid credential from /private/credential-file",
      });
    });

    const result = await observeExternalOpenShellTarget(observer, REQUEST);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the external target observation.",
      },
    });
    expect(callOrder).toEqual(["health", "credential"]);
    expect(JSON.stringify(result)).not.toContain("/private/credential-file");
  });

  it("rejects a workspace response outside the explicit target before inventory (#9872)", async () => {
    const callOrder: string[] = [];
    const client = successfulClient(callOrder);
    vi.mocked(client.getWorkspace).mockImplementationOnce(async () => {
      callOrder.push("workspace");
      return {
        ok: true,
        value: { name: "ambient-private-workspace", phase: "active" },
      };
    });
    const observer = successfulObserver(callOrder, client);

    const result = await observeExternalOpenShellTarget(observer, REQUEST);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "schema",
        message: "OpenShell returned a workspace other than the explicitly configured workspace.",
      },
    });
    expect(callOrder).toEqual(["health", "credential", "identity", "workspace"]);
    expect(client.listSandboxes).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("ambient-private-workspace");
  });
});
