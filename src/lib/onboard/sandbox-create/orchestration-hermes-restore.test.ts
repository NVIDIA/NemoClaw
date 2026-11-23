// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { reconcileCreatedHermesCredentialEnvironment } from "./orchestration";

describe("created Hermes gateway restart after a state restore", () => {
  const plan = { agent: "hermes" } as never;
  const restarted = { status: 0, stdout: "", stderr: "" };

  it("restarts the gateway after a Hermes state restore without a messaging plan (#14661)", async () => {
    const events: string[] = [];
    const reconcileCredentialEnv = vi.fn();

    await reconcileCreatedHermesCredentialEnvironment(
      { sandboxName: "alpha", plan: null, restoredHermesState: true },
      {
        revalidateSandboxIdentity: (operation) => events.push(`identity:${operation}`),
        reconcileCredentialEnv,
        restartGateway: async () => {
          events.push("restart");
          return restarted;
        },
      },
      vi.fn(),
    );

    expect(reconcileCredentialEnv).not.toHaveBeenCalled();
    expect(events).toEqual([
      "restart",
      "identity:completing Hermes restored-state restart for sandbox 'alpha'",
    ]);
  });

  it("restarts the gateway after a Hermes state restore when credentials are unchanged (#14661)", async () => {
    const restartGateway = vi.fn(async () => restarted);

    await reconcileCreatedHermesCredentialEnvironment(
      { sandboxName: "alpha", plan, restoredHermesState: true },
      {
        revalidateSandboxIdentity: vi.fn(),
        reconcileCredentialEnv: () => ({ changed: false }),
        restartGateway,
      },
      vi.fn(),
    );

    expect(restartGateway).toHaveBeenCalledOnce();
  });

  it("restarts the gateway once when a Hermes state restore also changes credentials (#14661)", async () => {
    const restartGateway = vi.fn(async () => restarted);

    await reconcileCreatedHermesCredentialEnvironment(
      { sandboxName: "alpha", plan, restoredHermesState: true },
      {
        revalidateSandboxIdentity: vi.fn(),
        reconcileCredentialEnv: () => ({ changed: true }),
        restartGateway,
      },
      vi.fn(),
    );

    expect(restartGateway).toHaveBeenCalledOnce();
  });

  it("fails onboarding with gateway restart guidance when the post-restore restart fails (#14661)", async () => {
    const recordRecovery = vi.fn();

    await expect(
      reconcileCreatedHermesCredentialEnvironment(
        { sandboxName: "alpha", plan: null, restoredHermesState: true },
        {
          revalidateSandboxIdentity: vi.fn(),
          reconcileCredentialEnv: vi.fn(),
          restartGateway: async () => ({ status: 1, stdout: "", stderr: "failed" }),
        },
        recordRecovery,
      ),
    ).rejects.toThrow(/Hermes state was restored for sandbox 'alpha'.*alpha gateway restart/u);
    expect(recordRecovery).toHaveBeenCalledOnce();
  });

  it.each([
    {
      restoredHermesState: true,
      message: /Hermes state was restored for sandbox 'alpha'.*alpha gateway restart/u,
    },
    {
      restoredHermesState: false,
      message:
        /^Hermes messaging credential reconciliation changed the gateway environment for sandbox 'alpha', but the native Hermes restart failed\.$/u,
    },
  ])(
    "keeps gateway restart guidance only for a restore when credentials changed and the restart fails (restored: $restoredHermesState)",
    async ({ restoredHermesState, message }) => {
      await expect(
        reconcileCreatedHermesCredentialEnvironment(
          { sandboxName: "alpha", plan, restoredHermesState },
          {
            revalidateSandboxIdentity: vi.fn(),
            reconcileCredentialEnv: () => ({ changed: true }),
            restartGateway: async () => ({ status: 1, stdout: "", stderr: "failed" }),
          },
          vi.fn(),
        ),
      ).rejects.toThrow(message);
    },
  );
});
