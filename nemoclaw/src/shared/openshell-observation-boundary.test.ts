// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSanitizedExternalOpenShellTargetPlan,
  type SanitizedExternalOpenShellTargetPlan,
} from "./openshell-external-target-boundary.cjs";

import {
  externalOpenShellGateway,
  observeExternalOpenShellTarget,
  type AuthenticatedOpenShellExternalTargetObserver,
  type OpenShellExternalTargetObserver,
  type OpenShellSandboxError,
  type OpenShellSandboxResult,
} from "./openshell-observation-boundary.cjs";

const INVENTORY = {
  sandboxes: [
    { name: "ready-agent", phase: "Ready", readiness: "ready" },
    { name: "pending-agent", phase: "Provisioning", readiness: "not_ready" },
  ],
} as const;

let fixtureDirectory = "";
let target: ReturnType<typeof externalOpenShellGateway>;
let request: Readonly<{ target: typeof target; timeoutMs: number }>;

beforeEach(() => {
  fixtureDirectory = mkdtempSync(path.join(tmpdir(), "nemoclaw-observation-boundary-"));
  const caFile = path.join(fixtureDirectory, "ca.pem");
  const credentialFile = path.join(fixtureDirectory, "credential");
  writeFileSync(caFile, `${rootCertificates[0]}\n`, { mode: 0o400 });
  writeFileSync(credentialFile, "opaque-placeholder\n", { mode: 0o400 });
  const plan = buildSanitizedExternalOpenShellTargetPlan(
    {
      endpoint: "https://openshell.example.test:8443",
      workspace: "research",
      expected_release: "0.0.106",
      lifecycle: "external",
      trust: { ca_file: caFile },
      authentication: { credential_file: credentialFile },
    },
    { minVersion: "0.0.106", maxVersion: "0.0.106" },
  );
  target = externalOpenShellGateway(plan);
  request = Object.freeze({ target, timeoutMs: 2_500 });
});

afterEach(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

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
        value: { status: "healthy" as const, release: "0.0.106" },
      };
    }),
    connectWithCredentialFile: vi.fn(async () => {
      callOrder.push("credential");
      return { ok: true as const, value: client };
    }),
  };
}

type RejectObservationStage = (
  observer: OpenShellExternalTargetObserver,
  client: AuthenticatedOpenShellExternalTargetObserver,
  callOrder: string[],
) => void;

const REJECTED_OBSERVATION_STAGES: readonly [string, readonly string[], RejectObservationStage][] =
  [
    [
      "public health",
      ["health"],
      (observer, _client, callOrder) =>
        vi.mocked(observer.getGatewayHealth).mockImplementationOnce(async () => {
          callOrder.push("health");
          throw new Error("private-token from /private/credential-file");
        }),
    ],
    [
      "credential handoff",
      ["health", "credential"],
      (observer, _client, callOrder) =>
        vi.mocked(observer.connectWithCredentialFile).mockImplementationOnce(async () => {
          callOrder.push("credential");
          throw new Error("private-token from /private/credential-file");
        }),
    ],
    [
      "identity",
      ["health", "credential", "identity"],
      (_observer, client, callOrder) =>
        vi.mocked(client.getCurrentUser).mockImplementationOnce(async () => {
          callOrder.push("identity");
          throw new Error("private-token from /private/credential-file");
        }),
    ],
    [
      "workspace",
      ["health", "credential", "identity", "workspace"],
      (_observer, client, callOrder) =>
        vi.mocked(client.getWorkspace).mockImplementationOnce(async () => {
          callOrder.push("workspace");
          throw new Error("private-token from /private/credential-file");
        }),
    ],
    [
      "inventory",
      ["health", "credential", "identity", "workspace", "inventory"],
      (_observer, client, callOrder) =>
        vi.mocked(client.listSandboxes).mockImplementationOnce(async () => {
          callOrder.push("inventory");
          throw new Error("private-token from /private/credential-file");
        }),
    ],
  ];

describe("external OpenShell target observation boundary", () => {
  it("collects release, identity, workspace, status, and inventory in the required order (#9872)", async () => {
    const callOrder: string[] = [];
    const client = successfulClient(callOrder);
    const observer = successfulObserver(callOrder, client);

    await expect(observeExternalOpenShellTarget(observer, request)).resolves.toEqual({
      ok: true,
      value: {
        target,
        health: { status: "healthy", release: "0.0.106" },
        identity: { subjectFingerprint: `sha256:${"a".repeat(64)}` },
        workspace: { name: "research", phase: "active" },
        inventory: INVENTORY,
      },
    });
    expect(callOrder).toEqual(["health", "credential", "identity", "workspace", "inventory"]);
    expect(observer.getGatewayHealth).toHaveBeenCalledWith(request);
    expect(observer.connectWithCredentialFile).toHaveBeenCalledWith(request);
    expect(client.getCurrentUser).toHaveBeenCalledWith(request);
    expect(client.getWorkspace).toHaveBeenCalledWith(request);
    expect(client.listSandboxes).toHaveBeenCalledWith(request);
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

    const result = await observeExternalOpenShellTarget(observer, request);

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
        value: { status: "degraded", release: "0.0.106" },
      };
    });

    const result = await observeExternalOpenShellTarget(observer, request);

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

      const result = await observeExternalOpenShellTarget(observer, request);

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

    const result = await observeExternalOpenShellTarget(observer, request);

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

    const result = await observeExternalOpenShellTarget(observer, request);

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

  it("rejects an unvalidated target before any observer call (#9872)", async () => {
    const unvalidatedPlan = {
      endpoint: "http://user:private-token@openshell.example.test/path?secret=private-token",
      workspace: "",
      expected_release: "not-a-release",
      lifecycle: "external",
      authentication_source: "file",
      ca_fingerprint: "private-path-value",
    } as SanitizedExternalOpenShellTargetPlan;
    expect(() => externalOpenShellGateway(unvalidatedPlan)).toThrow(
      "external OpenShell observation requires a validated target plan",
    );

    const callOrder: string[] = [];
    const observer = successfulObserver(callOrder);
    const result = await observeExternalOpenShellTarget(observer, {
      target: {
        kind: "external",
        plan: unvalidatedPlan,
        allWorkspaces: false,
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "invalid_request",
        message: "The external OpenShell observation target is not a validated target plan.",
      },
    });
    expect(observer.getGatewayHealth).not.toHaveBeenCalled();
    expect(observer.connectWithCredentialFile).not.toHaveBeenCalled();
    expect(callOrder).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(JSON.stringify(result)).not.toContain("private-path-value");
  });

  it.each(REJECTED_OBSERVATION_STAGES)(
    "sanitizes a rejected %s observation and stops (#9872)",
    async (_stage, expectedCallOrder, rejectStage) => {
      const callOrder: string[] = [];
      const client = successfulClient(callOrder);
      const observer = successfulObserver(callOrder, client);
      rejectStage(observer, client, callOrder);

      const result = await observeExternalOpenShellTarget(observer, request);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: "transport",
          reason: "unreachable",
          message: "NemoClaw could not reach the external OpenShell target.",
        },
      });
      expect(callOrder).toEqual(expectedCallOrder);
      expect(JSON.stringify(result)).not.toContain("private-token");
      expect(JSON.stringify(result)).not.toContain("/private/credential-file");
    },
  );

  it("keeps one immutable target snapshot across every observation stage (#9872)", async () => {
    const callOrder: string[] = [];
    const client = successfulClient(callOrder);
    const observer = successfulObserver(callOrder, client);
    const mutationResults: boolean[] = [];
    vi.mocked(observer.getGatewayHealth).mockImplementationOnce(async ({ target: observed }) => {
      callOrder.push("health");
      mutationResults.push(
        Reflect.set(observed.plan, "endpoint", "https://changed.example.test"),
        Reflect.set(observed.plan, "workspace", "changed"),
        Reflect.set(observed.plan, "expected_release", "9.9.9"),
      );
      return { ok: true, value: { status: "healthy", release: "0.0.106" } };
    });

    const result = await observeExternalOpenShellTarget(observer, request);

    expect(result).toMatchObject({ ok: true, value: { target } });
    expect(mutationResults).toEqual([false, false, false]);
    const observedRequest = vi.mocked(observer.getGatewayHealth).mock.calls[0]![0];
    expect(vi.mocked(observer.connectWithCredentialFile).mock.calls[0]![0]).toBe(observedRequest);
    expect(vi.mocked(client.getCurrentUser).mock.calls[0]![0]).toBe(observedRequest);
    expect(vi.mocked(client.getWorkspace).mock.calls[0]![0]).toBe(observedRequest);
    expect(vi.mocked(client.listSandboxes).mock.calls[0]![0]).toBe(observedRequest);
    expect(observedRequest).not.toBe(request);
    expect(Object.isFrozen(observedRequest)).toBe(true);
    expect(Object.isFrozen(observedRequest.target)).toBe(true);
    expect(Object.isFrozen(observedRequest.target.plan)).toBe(true);
  });

  it("returns a detached frozen observation receipt (#9872)", async () => {
    const health = { status: "healthy" as const, release: "0.0.106" };
    const identity = { subjectFingerprint: `sha256:${"a".repeat(64)}` };
    const workspace = { name: "research", phase: "active" as const };
    const sandbox = { name: "ready-agent", phase: "Ready", readiness: "ready" as const };
    const sandboxes = [sandbox];
    const inventory = { sandboxes };
    const client: AuthenticatedOpenShellExternalTargetObserver = {
      getCurrentUser: vi.fn(async () => ({ ok: true as const, value: identity })),
      getWorkspace: vi.fn(async () => ({ ok: true as const, value: workspace })),
      listSandboxes: vi.fn(async () => ({ ok: true as const, value: inventory })),
    };
    const observer: OpenShellExternalTargetObserver = {
      getGatewayHealth: vi.fn(async () => ({ ok: true as const, value: health })),
      connectWithCredentialFile: vi.fn(async () => ({ ok: true as const, value: client })),
    };

    const result = await observeExternalOpenShellTarget(observer, request);
    const receipt = (result as Extract<typeof result, { ok: true }>).value;

    expect(Reflect.set(health, "release", "changed-release")).toBe(true);
    expect(Reflect.set(identity, "subjectFingerprint", "private-token")).toBe(true);
    expect(Reflect.set(workspace, "name", "changed-workspace")).toBe(true);
    expect(Reflect.set(sandbox, "name", "changed-sandbox")).toBe(true);
    sandboxes.push({ name: "late-sandbox", phase: "Ready", readiness: "ready" });
    expect(Reflect.set(inventory, "sandboxes", [])).toBe(true);
    expect(receipt).toEqual({
      target,
      health: { status: "healthy", release: "0.0.106" },
      identity: { subjectFingerprint: `sha256:${"a".repeat(64)}` },
      workspace: { name: "research", phase: "active" },
      inventory: {
        sandboxes: [{ name: "ready-agent", phase: "Ready", readiness: "ready" }],
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.target)).toBe(true);
    expect(Object.isFrozen(receipt.target.plan)).toBe(true);
    expect(Object.isFrozen(receipt.health)).toBe(true);
    expect(Object.isFrozen(receipt.identity)).toBe(true);
    expect(Object.isFrozen(receipt.workspace)).toBe(true);
    expect(Object.isFrozen(receipt.inventory)).toBe(true);
    expect(Object.isFrozen(receipt.inventory.sandboxes)).toBe(true);
    expect(Object.isFrozen(receipt.inventory.sandboxes[0])).toBe(true);
  });
});
