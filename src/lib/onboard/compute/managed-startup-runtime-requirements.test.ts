// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  DCODE_MANAGED_RUNTIME_ULIMITS,
  resolveManagedStartupRuntimeRequirements,
} from "./managed-startup-runtime-requirements";

const agent = (name: string) =>
  ({ name }) as Parameters<typeof resolveManagedStartupRuntimeRequirements>[0];
const managedGateway = { managedGatewayOwned: true } as const;
const externalGateway = { managedGatewayOwned: false } as const;

describe("driver-neutral managed-startup runtime requirements", () => {
  it("preserves the existing Docker command and DCode limit behavior", () => {
    expect(
      resolveManagedStartupRuntimeRequirements(agent("openclaw"), "docker", managedGateway),
    ).toEqual({
      persistStartupCommand: false,
      requiredUlimits: null,
    });
    expect(
      resolveManagedStartupRuntimeRequirements(agent("hermes"), "docker", managedGateway),
    ).toEqual({
      persistStartupCommand: true,
      requiredUlimits: null,
    });
    expect(
      resolveManagedStartupRuntimeRequirements(
        agent("langchain-deepagents-code"),
        "docker",
        managedGateway,
      ),
    ).toEqual({
      persistStartupCommand: true,
      requiredUlimits: DCODE_MANAGED_RUNTIME_ULIMITS,
    });
  });

  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ])("does not mutate an externally managed Docker gateway for %s", (name) => {
    expect(
      resolveManagedStartupRuntimeRequirements(agent(name), "docker", externalGateway),
    ).toEqual({
      persistStartupCommand: false,
      requiredUlimits: null,
    });
  });

  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ])("persists the image-owned hold for %s on Podman", (name) => {
    expect(
      resolveManagedStartupRuntimeRequirements(agent(name), "podman", managedGateway)
        .persistStartupCommand,
    ).toBe(true);
  });

  it("applies DCode's exact limits on Podman without assigning them to other agents", () => {
    expect(
      resolveManagedStartupRuntimeRequirements(
        agent("langchain-deepagents-code"),
        "podman",
        managedGateway,
      ).requiredUlimits,
    ).toEqual(DCODE_MANAGED_RUNTIME_ULIMITS);
    expect(
      resolveManagedStartupRuntimeRequirements(agent("openclaw"), "podman", managedGateway)
        .requiredUlimits,
    ).toBeNull();
  });

  it("lets an MXC-shaped runtime inject its own requirements without Docker inheritance", () => {
    expect(
      resolveManagedStartupRuntimeRequirements(agent("openclaw"), "mxc", managedGateway, {
        mxc: {
          driverName: "mxc",
          resolve: () => ({
            persistStartupCommand: true,
            requiredUlimits: [{ name: "nofile", soft: 4096, hard: 4096 }],
          }),
        },
      }),
    ).toEqual({
      persistStartupCommand: true,
      requiredUlimits: [{ name: "nofile", soft: 4096, hard: 4096 }],
    });
  });

  it("fails closed for an unregistered or identity-mismatched runtime", () => {
    expect(() =>
      resolveManagedStartupRuntimeRequirements(agent("openclaw"), "mxc", managedGateway),
    ).toThrow("has no managed-startup requirements adapter");
    expect(() =>
      resolveManagedStartupRuntimeRequirements(agent("openclaw"), "mxc", managedGateway, {
        mxc: {
          driverName: "docker",
          resolve: () => ({ persistStartupCommand: false, requiredUlimits: null }),
        },
      }),
    ).toThrow("has no managed-startup requirements adapter");
  });
});
