// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveSandboxContainerOwner } from "../dist/lib/actions/sandbox/sandbox-container-owner.js";

describe("resolveSandboxContainerOwner", () => {
  it("returns null when no candidate matches the sandbox prefix", () => {
    expect(
      resolveSandboxContainerOwner(
        "openshell-cluster-nemoclaw\nopenshell-different-sandbox-7616dcb1",
        "my-assistant",
        ["my-assistant", "different-sandbox"],
      ),
    ).toBeNull();
  });

  it("prefers the exact-name container even when a co-tenant suffixed candidate exists in the same listing", () => {
    expect(
      resolveSandboxContainerOwner(
        "openshell-my-assistant-7616dcb1\nopenshell-my-assistant",
        "my-assistant",
        ["my-assistant"],
      ),
    ).toBe("openshell-my-assistant");
  });

  it("accepts a uuid-suffixed container that resolves to the queried sandbox via the longest-owner rule", () => {
    expect(
      resolveSandboxContainerOwner(
        "openshell-my-assistant-7616dcb1\nopenshell-different-sandbox-abc",
        "my-assistant",
        ["my-assistant", "different-sandbox"],
      ),
    ).toBe("openshell-my-assistant-7616dcb1");
  });

  it("rejects a container whose longest-owner is a different registered sandbox name", () => {
    expect(
      resolveSandboxContainerOwner(
        "openshell-my-assistant-prod-7616dcb1\nopenshell-cluster-nemoclaw",
        "my-assistant",
        ["my-assistant", "my-assistant-prod"],
      ),
    ).toBeNull();
  });

  it("rejects a container whose stripped name is not separated from the queried sandbox by a hyphen", () => {
    expect(
      resolveSandboxContainerOwner(
        "openshell-my-assistantextra\nopenshell-cluster-nemoclaw",
        "my-assistant",
        ["my-assistant"],
      ),
    ).toBeNull();
  });

  it("includes the queried sandbox in the known-owner set even when listSandboxNames omits it", () => {
    expect(
      resolveSandboxContainerOwner("openshell-my-assistant-7616dcb1", "my-assistant", []),
    ).toBe("openshell-my-assistant-7616dcb1");
  });

  it("trims whitespace and ignores blank lines from the docker ps stream", () => {
    expect(
      resolveSandboxContainerOwner(
        "   openshell-my-assistant-7616dcb1   \n\n   openshell-cluster-nemoclaw   \n",
        "my-assistant",
        ["my-assistant"],
      ),
    ).toBe("openshell-my-assistant-7616dcb1");
  });

  it("matches an exact-name container even when listSandboxNames is empty", () => {
    expect(resolveSandboxContainerOwner("openshell-my-assistant", "my-assistant", [])).toBe(
      "openshell-my-assistant",
    );
  });
});
