// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";
import * as dockerRuntime from "../../../src/lib/onboard/runtime-provider/docker.ts";
import * as podmanRuntime from "../../../src/lib/onboard/runtime-provider/podman.ts";
import { isValidName } from "../../../src/lib/name-validation.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";

import { createLegacyManagedVolumeFixture } from "../live/managed-image-activation-e2e-helpers.ts";

describe("legacy managed volume fixture", () => {
  it.each(["docker", "podman"] as const)(
    "seeds owned legacy state and removes only recorded fixtures through %s",
    async (runtime) => {
      vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", runtime);
      const provider =
        runtime === "docker"
          ? dockerRuntime.createDockerRuntimeProviderBundle()
          : podmanRuntime.createCurrentPodmanRuntimeProviderBundle();
      assert(provider.containerEngine.supported, "built-in engine required");
      const helperId = "a".repeat(64);
      const capture = vi
        .spyOn(provider.containerEngine, "capture")
        .mockImplementation((_operation, args) => ({
          status: 0,
          stdout: args[0] === "create" ? helperId : "",
          stderr: "",
        }));
      vi.spyOn(dockerRuntime, "createDockerRuntimeProviderBundle").mockReturnValue(provider);
      vi.spyOn(podmanRuntime, "createCurrentPodmanRuntimeProviderBundle").mockReturnValue(provider);
      const cleanup = new CleanupRegistry();
      const fixture = createLegacyManagedVolumeFixture(cleanup);
      expect(isValidName(fixture.sandboxName)).toBe(true);
      expect(capture).not.toHaveBeenCalled();
      fixture.seed();
      const commands = () => capture.mock.calls.map((call) => call[1]);
      expect(commands().find((args) => args[0] === "volume" && args[1] === "create")).toEqual([
        "volume",
        "create",
        ...Object.entries(fixture.root.ownershipLabels).flatMap(([key, value]) => [
          "--label",
          `${key}=${value}`,
        ]),
        fixture.root.resourceIdentity,
      ]);
      const probe = commands().find((args) => args[0] === "create")!;
      expect(probe.at(-1)).toContain(JSON.stringify(fixture.marker));
      expect(probe.join(" ")).toContain(
        runtime === "docker"
          ? `src=${fixture.root.resourceIdentity},dst=/state,volume-nocopy`
          : `${fixture.root.resourceIdentity}:/state:rw,nocopy`,
      );
      expect(await cleanup.runAll()).toEqual({
        passed: ["remove only the volume qualification fixtures"],
        failures: [],
      });
      expect(commands().filter((args) => args[0] === "volume" && args[1] === "rm")).toEqual([
        ["volume", "rm", fixture.root.resourceIdentity],
      ]);
      const failingCleanup = new CleanupRegistry();
      createLegacyManagedVolumeFixture(failingCleanup).seed();
      capture.mockImplementation((_operation, args) => ({
        status: args[0] === "volume" && args[1] === "rm" ? 1 : 0,
        stdout: "",
        stderr: "volume is in use",
      }));
      const failedCleanup = await failingCleanup.runAll();
      expect(failedCleanup.failures).toHaveLength(1);
      expect(failedCleanup.failures[0]?.message).toContain("volume is in use");
    },
  );
});
