// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveSandboxContainerOwner } from "../../../src/lib/domain/sandbox/container-owner.js";

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

  it("accepts the v0.0.99 default-workspace identity through the longest-owner rule", () => {
    expect(
      resolveSandboxContainerOwner(
        "openshell-default--my-assistant-sandbox-7616dcb1",
        "my-assistant",
        ["my-assistant"],
      ),
    ).toBe("openshell-default--my-assistant-sandbox-7616dcb1");
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

  it("rejects a default-workspace container whose longest owner is a different registered sandbox", () => {
    expect(
      resolveSandboxContainerOwner(
        "openshell-default--my-assistant-prod-sandbox-7616dcb1",
        "my-assistant",
        ["my-assistant", "my-assistant-prod"],
      ),
    ).toBeNull();
  });

  it("rejects a non-default workspace even when its qualifier could look like a legacy owner", () => {
    expect(
      resolveSandboxContainerOwner("openshell-review--my-assistant-sandbox-7616dcb1", "review", [
        "review",
        "my-assistant",
      ]),
    ).toBeNull();
  });

  it.each([
    "openshell-default--my-assistant",
    "openshell-default---my-assistant-sandbox-7616dcb1",
    "openshell-default--my-assistant--sandbox-7616dcb1",
    "openshell-default--my-assistant-",
  ])("rejects malformed or untrusted workspace-qualified identity %s", (containerName) => {
    expect(
      resolveSandboxContainerOwner(containerName, "my-assistant", ["my-assistant"]),
    ).toBeNull();
  });

  it("rejects multiple non-exact candidates for the queried sandbox", () => {
    expect(
      resolveSandboxContainerOwner(
        ["openshell-my-assistant-legacy-id", "openshell-default--my-assistant-current-id"].join(
          "\n",
        ),
        "my-assistant",
        ["my-assistant"],
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
