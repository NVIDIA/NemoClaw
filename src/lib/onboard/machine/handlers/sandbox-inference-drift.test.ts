// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

describe("OpenClaw inference selection drift during sandbox resume", () => {
  it("recreates a reused sandbox when inference selection has known drift", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const getSelectionDrift = vi.fn(() => ({
      changed: true,
      providerChanged: false,
      modelChanged: true,
      existingProvider: "provider",
      existingModel: "old-model",
      requestedProvider: "provider",
      requestedModel: "model",
      unknown: false,
    }));
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSelectionDrift,
      isNonInteractive: () => true,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      sandboxName: "saved",
    });

    expect(getSelectionDrift).toHaveBeenCalledExactlyOnceWith("saved", "provider", "model");
    expect(calls.skipped).not.toHaveBeenCalledWith("sandbox", "saved", "reuse");
    expect(calls.createSandbox).toHaveBeenCalledOnce();
    expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({ recreate: true });
  });

  it("requires explicit confirmation before interactive inference-drift recreation", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const confirmRecreateForSelectionDrift = vi.fn(async () => false);
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSelectionDrift: () => ({
        changed: true,
        providerChanged: false,
        modelChanged: true,
        existingProvider: "provider",
        existingModel: "old-model",
        requestedProvider: "provider",
        requestedModel: "model",
        unknown: false,
      }),
      isNonInteractive: () => false,
      confirmRecreateForSelectionDrift,
    });

    await expect(
      handleSandboxState({ ...baseOptions(deps, session), sandboxName: "saved" }),
    ).rejects.toThrow("exit 1");

    expect(confirmRecreateForSelectionDrift).toHaveBeenCalledExactlyOnceWith(
      "saved",
      expect.objectContaining({ changed: true, unknown: false }),
      "provider",
      "model",
    );
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("recreates after interactive inference-drift confirmation", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const confirmRecreateForSelectionDrift = vi.fn(async () => true);
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSelectionDrift: () => ({
        changed: true,
        providerChanged: false,
        modelChanged: true,
        existingProvider: "provider",
        existingModel: "old-model",
        requestedProvider: "provider",
        requestedModel: "model",
        unknown: false,
      }),
      isNonInteractive: () => false,
      confirmRecreateForSelectionDrift,
    });

    await handleSandboxState({ ...baseOptions(deps, session), sandboxName: "saved" });

    expect(confirmRecreateForSelectionDrift).toHaveBeenCalledExactlyOnceWith(
      "saved",
      expect.objectContaining({ changed: true, unknown: false }),
      "provider",
      "model",
    );
    expect(calls.createSandbox).toHaveBeenCalledOnce();
    expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({ recreate: true });
  });

  it("fails closed when inference-drift recreation has no interaction-mode signal", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSelectionDrift: () => ({
        changed: true,
        providerChanged: false,
        modelChanged: true,
        existingProvider: "provider",
        existingModel: "old-model",
        requestedProvider: "provider",
        requestedModel: "model",
        unknown: false,
      }),
    });

    await expect(
      handleSandboxState({ ...baseOptions(deps, session), sandboxName: "saved" }),
    ).rejects.toThrow("explicit interaction-mode signal");
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });
});
