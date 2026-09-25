// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import type { OpenShellSandboxMutationSubmission } from "../../adapters/openshell/sandbox-lifecycle-sdk";
import { refreshManagedStartupCorporateCaTrust } from "./provider-root-apply";

const request = {
  sandboxName: "alpha",
  sandboxIdentityFingerprint: "a".repeat(64),
  target: { kind: "named", gatewayName: "owned-gateway" },
} as const;
const accepted: OpenShellSandboxMutationSubmission = { kind: "accepted" };
const denied: OpenShellSandboxMutationSubmission = {
  kind: "failed",
  error: { kind: "authentication", message: "OpenShell denied access." },
};

it("waits for native stop before starting the same immutable sandbox", async () => {
  let completeStop!: (result: OpenShellSandboxMutationSubmission) => void;
  const stopped = new Promise<OpenShellSandboxMutationSubmission>((resolve) => {
    completeStop = resolve;
  });
  const lifecycle = {
    stopSandbox: vi.fn(() => stopped),
    startSandbox: vi.fn(async () => accepted),
  };
  const refresh = refreshManagedStartupCorporateCaTrust(request, lifecycle);
  expect(lifecycle.stopSandbox).toHaveBeenCalledExactlyOnceWith(request);
  expect(lifecycle.startSandbox).not.toHaveBeenCalled();
  completeStop(accepted);
  await refresh;
  expect(lifecycle.startSandbox).toHaveBeenCalledExactlyOnceWith(request);
});

it("retains a failed stop without starting or retrying the sandbox", async () => {
  const lifecycle = {
    stopSandbox: vi.fn(async () => denied),
    startSandbox: vi.fn(async () => accepted),
  };
  await expect(refreshManagedStartupCorporateCaTrust(request, lifecycle)).rejects.toThrow(
    "Could not stop sandbox 'alpha' to activate corporate CA trust: OpenShell denied access.",
  );
  expect(lifecycle.stopSandbox).toHaveBeenCalledOnce();
  expect(lifecycle.startSandbox).not.toHaveBeenCalled();
});

it("retains a failed start without another mutation attempt", async () => {
  const lifecycle = {
    stopSandbox: vi.fn(async () => accepted),
    startSandbox: vi.fn(async () => denied),
  };
  await expect(refreshManagedStartupCorporateCaTrust(request, lifecycle)).rejects.toThrow(
    "Could not start sandbox 'alpha' to activate corporate CA trust: OpenShell denied access.",
  );
  expect(lifecycle.stopSandbox).toHaveBeenCalledOnce();
  expect(lifecycle.startSandbox).toHaveBeenCalledOnce();
});
