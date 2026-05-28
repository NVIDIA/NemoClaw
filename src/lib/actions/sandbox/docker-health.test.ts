// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getSandboxDockerHealth } from "../../../../dist/lib/actions/sandbox/docker-health";
import type { SandboxEntry } from "../../../../dist/lib/state/registry";

function fixture({
  driver = "docker",
  psNames = "openshell-cluster-nemoclaw\nopenshell-my-assistant-12ab\nopenshell-other-aa11",
  healthRaw = "unhealthy\n",
  throwOnInspect = false,
  knownSandboxes = ["my-assistant"],
}: {
  driver?: string | null;
  psNames?: string;
  healthRaw?: string;
  throwOnInspect?: boolean;
  knownSandboxes?: string[];
} = {}) {
  const sandbox: Partial<SandboxEntry> = { name: "my-assistant", openshellDriver: driver };
  return {
    getSandbox: () => sandbox as SandboxEntry,
    listSandboxNames: () => knownSandboxes,
    dockerPsNames: () => psNames,
    dockerInspectHealth: () => {
      if (throwOnInspect) throw new Error("docker inspect crashed");
      return healthRaw;
    },
  };
}

describe("getSandboxDockerHealth", () => {
  it("returns the docker container health when the sandbox runs on the docker driver", () => {
    const deps = fixture({ healthRaw: "healthy\n" });
    expect(getSandboxDockerHealth("my-assistant", deps)).toEqual({
      state: "healthy",
      containerName: "openshell-my-assistant-12ab",
    });
  });

  it("normalizes whitespace and uppercase Docker health values", () => {
    const deps = fixture({ healthRaw: "  UnHealthy \n" });
    expect(getSandboxDockerHealth("my-assistant", deps).state).toBe("unhealthy");
  });

  it("returns state 'starting' during the start-period window", () => {
    const deps = fixture({ healthRaw: "starting" });
    expect(getSandboxDockerHealth("my-assistant", deps).state).toBe("starting");
  });

  it("returns state 'none' when the container has no HEALTHCHECK at all", () => {
    const deps = fixture({ healthRaw: "none" });
    expect(getSandboxDockerHealth("my-assistant", deps).state).toBe("none");
  });

  it("returns state 'none' for non-docker-driver sandboxes (k3s / kubernetes etc.)", () => {
    const deps = fixture({ driver: "kubernetes" });
    expect(getSandboxDockerHealth("my-assistant", deps)).toEqual({
      state: "none",
      containerName: null,
    });
  });

  it("returns state 'none' when no docker container is found for the sandbox", () => {
    const deps = fixture({ psNames: "openshell-cluster-nemoclaw\n" });
    expect(getSandboxDockerHealth("my-assistant", deps).state).toBe("none");
  });

  it("matches an exact container name when no per-instance suffix is present", () => {
    const deps = fixture({
      psNames: "openshell-my-assistant\nopenshell-other-aa11",
      healthRaw: "healthy",
    });
    expect(getSandboxDockerHealth("my-assistant", deps).containerName).toBe(
      "openshell-my-assistant",
    );
  });

  it("does not select another sandbox's container when its name is a prefix", () => {
    const deps = fixture({
      psNames: "openshell-my-assistant-12ab\nopenshell-cluster-nemoclaw",
    });
    expect(getSandboxDockerHealth("my", deps)).toEqual({
      state: "none",
      containerName: null,
    });
  });

  it("prefers an exact-name match even when the docker ps listing returns a suffixed candidate first", () => {
    const deps = fixture({
      psNames: "openshell-my-assistant\nopenshell-my\n",
      healthRaw: "healthy",
      knownSandboxes: ["my", "my-assistant"],
    });
    expect(getSandboxDockerHealth("my", deps).containerName).toBe("openshell-my");
  });

  it("prefers the exact-name container over a docker-runtime-suffixed sibling", () => {
    // openshell-my-12ab is a same-sandbox alternate container left over
    // from an earlier OpenShell run; only `my` is registered, so the
    // longest-known-name heuristic alone would still resolve the
    // suffixed candidate to `my` and could return it depending on
    // docker ps ordering. The exact name must always win.
    const deps = fixture({
      psNames: "openshell-my-12ab\nopenshell-my\n",
      healthRaw: "healthy",
      knownSandboxes: ["my"],
    });
    expect(getSandboxDockerHealth("my", deps).containerName).toBe("openshell-my");
  });

  it("does not steal another sandbox's container when names share a hyphenated prefix and the suffix is hyphen-free", () => {
    const deps = fixture({
      psNames: "openshell-my-assistant-prod\n",
      knownSandboxes: ["my-assistant", "my-assistant-prod"],
    });
    expect(getSandboxDockerHealth("my-assistant", deps)).toEqual({
      state: "none",
      containerName: null,
    });
  });

  it("attributes a hyphenated container to the longest registered sandbox name", () => {
    const deps = fixture({
      psNames: "openshell-my-assistant-prod-abc\n",
      knownSandboxes: ["my-assistant", "my-assistant-prod"],
      healthRaw: "healthy",
    });
    // Looking up the shorter sandbox name must not match the longer
    // sandbox's container, even when the suffix after each candidate
    // prefix is hyphen-free.
    expect(getSandboxDockerHealth("my-assistant", deps).containerName).toBe(null);
  });

  it("returns state 'unknown' when docker inspect throws", () => {
    const deps = fixture({ throwOnInspect: true });
    const result = getSandboxDockerHealth("my-assistant", deps);
    expect(result.state).toBe("unknown");
    expect(result.containerName).toBe("openshell-my-assistant-12ab");
  });
});
