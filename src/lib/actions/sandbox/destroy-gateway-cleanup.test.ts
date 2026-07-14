// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { hasNoLiveSandboxes } from "../../domain/sandbox/destroy";
import {
  collectLiveSandboxProbeSnapshot,
  shouldCleanupGatewayAfterConfirmedFinalDestroy,
} from "./destroy-gateway-cleanup";

describe("shouldCleanupGatewayAfterConfirmedFinalDestroy", () => {
  it("defers live probes until the local registry is empty", () => {
    const liveSandboxProbe = vi.fn(() => true);

    expect(
      shouldCleanupGatewayAfterConfirmedFinalDestroy(
        {
          deleteSucceededOrAlreadyGone: true,
          removedRegistryEntry: true,
        },
        {
          listSandboxes: () => ({ sandboxes: [{}] }),
          liveSandboxProbe,
        },
      ),
    ).toBe(false);
    expect(liveSandboxProbe).not.toHaveBeenCalled();
  });

  it("requires confirmed delete, registry removal, and no live sandboxes", () => {
    expect(
      shouldCleanupGatewayAfterConfirmedFinalDestroy(
        {
          deleteSucceededOrAlreadyGone: true,
          removedRegistryEntry: true,
        },
        {
          listSandboxes: () => ({ sandboxes: [] }),
          liveSandboxProbe: () => true,
        },
      ),
    ).toBe(true);

    expect(
      shouldCleanupGatewayAfterConfirmedFinalDestroy(
        {
          deleteSucceededOrAlreadyGone: true,
          removedRegistryEntry: true,
        },
        {
          listSandboxes: () => ({ sandboxes: [] }),
          liveSandboxProbe: () => false,
        },
      ),
    ).toBe(false);
  });

  it("preserves the gateway when a live sandbox appears after the empty-registry check", () => {
    const events: string[] = [];
    expect(
      shouldCleanupGatewayAfterConfirmedFinalDestroy(
        {
          deleteSucceededOrAlreadyGone: true,
          removedRegistryEntry: true,
        },
        {
          listSandboxes: () => {
            events.push("registry-empty");
            return { sandboxes: [] };
          },
          liveSandboxProbe: () => {
            events.push("live-sandbox-observed");
            // False means the host probe observed a sandbox during the TOCTOU window.
            return false;
          },
        },
      ),
    ).toBe(false);
    expect(events).toEqual(["registry-empty", "live-sandbox-observed"]);
  });

  it("collects OpenShell and Docker live-sandbox snapshots in the action layer", () => {
    const captureOpenshell = vi.fn(() => ({
      status: 0,
      output:
        "NAME              CREATED              PHASE\nnpmtest           now                  Error\n",
    }));
    const dockerCapture = vi.fn(() => "openshell-npmtest-e487d1bd\n");

    const snapshot = collectLiveSandboxProbeSnapshot({
      captureOpenshell,
      dockerCapture,
      timeoutMs: 1_000,
    });

    expect(captureOpenshell).toHaveBeenCalledWith(["sandbox", "list"], {
      ignoreError: true,
      timeout: 1_000,
    });
    expect(dockerCapture).toHaveBeenCalledWith(
      ["ps", "--filter", "name=openshell-npmtest-", "--format", "{{.Names}}"],
      {
        timeout: 1_000,
      },
    );
    expect(hasNoLiveSandboxes(snapshot)).toBe(false);
  });

  it("records failed Docker probes as fail-closed snapshots", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const snapshot = collectLiveSandboxProbeSnapshot({
      captureOpenshell: () => ({
        status: 0,
        output:
          "NAME              CREATED              PHASE\nnpmtest           now                  Failed\n",
      }),
      dockerCapture: () => {
        throw new Error("docker unavailable");
      },
      timeoutMs: 1_000,
    });

    expect(hasNoLiveSandboxes(snapshot)).toBe(false);
    expect(snapshot.dockerContainersBySandboxName.get("npmtest")).toEqual({
      output: "",
      probeFailed: true,
    });
    expect(warn).toHaveBeenCalledWith(
      "Docker container probe failed for sandbox 'npmtest'; preserving shared gateway: Error: docker unavailable",
    );
  });
});
