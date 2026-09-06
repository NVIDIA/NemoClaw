// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadAgent } from "../../agent/defs";
import type { AgentDefinition } from "../../agent/definition-types";
import {
  parsePortableAgentRuntimeContractV1,
  portableAgentDefinitionSha256,
  portableAgentRuntimeSupportError,
  type PortableAgentRuntimeContractV1,
  type PortableAgentRuntimeProviderSupport,
} from "./portable-agent-runtime";

const IMAGE_REPOSITORY = "ghcr.io/nvidia/nemoclaw-fixtures/hermes-portable";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}` as const;

function hermesContract(): PortableAgentRuntimeContractV1 {
  const agent = loadAgent("hermes");
  return {
    contractVersion: 1,
    capabilityContractVersion: 1,
    agent: "hermes",
    agentVersion: "0.20.6",
    agentDefinitionSha256: portableAgentDefinitionSha256(agent),
    platform: "linux/amd64",
    image: {
      repository: IMAGE_REPOSITORY,
      digest: IMAGE_DIGEST,
      reference: `${IMAGE_REPOSITORY}@${IMAGE_DIGEST}`,
    },
    startup: {
      authority: "image-contract",
      argv: ["hermes", "gateway", "run"],
      workingDirectory: "/sandbox",
    },
    filesystem: {
      homeDirectory: "/sandbox",
      configDirectory: "/sandbox/.hermes",
      workspaceOwnership: "openshell",
      privateState: "owner-only",
    },
    runtimeIdentity: "non-root",
    credentialEnvironmentNames: ["API_SERVER_KEY"],
    health: {
      url: "http://localhost:8642/health",
      port: 8642,
      timeoutSeconds: 90,
    },
  };
}

function fullProviderSupport(): PortableAgentRuntimeProviderSupport {
  return {
    exactDigestReferences: true,
    agents: ["hermes"],
    platforms: ["linux/amd64"],
    contractVersions: [1],
    capabilityContractVersions: [1],
    tokenizedStartupCommands: true,
    openshellSandboxCommand: true,
    runtimeSelectedNonRootIdentity: true,
    openshellWorkspaceOwnership: true,
    ownerOnlyPrivateState: true,
  };
}

function mutableContract(): Record<string, unknown> {
  return structuredClone(hermesContract()) as unknown as Record<string, unknown>;
}

function image(value: Record<string, unknown>): Record<string, unknown> {
  return value.image as Record<string, unknown>;
}

function startup(value: Record<string, unknown>): Record<string, unknown> {
  return value.startup as Record<string, unknown>;
}

function filesystem(value: Record<string, unknown>): Record<string, unknown> {
  return value.filesystem as Record<string, unknown>;
}

describe("portable agent runtime contract", () => {
  it("accepts an exact credential-free Hermes image declaration without managed startup (#11079)", () => {
    const contract = hermesContract();

    expect(parsePortableAgentRuntimeContractV1(contract, loadAgent("hermes"))).toEqual(contract);
    expect(contract.startup.argv).toEqual(["hermes", "gateway", "run"]);
    expect(contract.startup.argv).not.toContain("/usr/local/bin/nemoclaw-start");
    expect(contract.filesystem).toEqual({
      homeDirectory: "/sandbox",
      configDirectory: "/sandbox/.hermes",
      workspaceOwnership: "openshell",
      privateState: "owner-only",
    });
    expect(contract.runtimeIdentity).toBe("non-root");
  });

  it.each([
    ["image digest", (value: Record<string, unknown>) => (image(value).digest = "sha256:abc")],
    [
      "mutable image reference",
      (value: Record<string, unknown>) => (image(value).reference = `${IMAGE_REPOSITORY}:latest`),
    ],
  ])("rejects an inexact %s before provider admission (#11079)", (_label, mutate) => {
    const value = mutableContract();
    mutate(value);

    expect(() => parsePortableAgentRuntimeContractV1(value, loadAgent("hermes"))).toThrow(
      /Invalid portable agent runtime contract/u,
    );
  });

  it.each([
    ["managed startup executable", ["/usr/local/bin/nemoclaw-start"]],
    ["shell-form command", ["hermes gateway run"]],
    ["credential assignment", ["hermes", "gateway", "run", "API_SERVER_KEY=do-not-store"]],
  ])("rejects %s instead of guessing startup behavior (#11079)", (_label, argv) => {
    const value = mutableContract();
    startup(value).argv = argv;

    let error: unknown;
    try {
      parsePortableAgentRuntimeContractV1(value, loadAgent("hermes"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("contract.startup.argv does not match the agent definition");
    expect(String(error)).not.toContain("do-not-store");
  });

  it.each([
    [
      "relative home",
      (value: Record<string, unknown>) => (filesystem(value).homeDirectory = "home/agent"),
    ],
    [
      "traversing workdir",
      (value: Record<string, unknown>) => (startup(value).workingDirectory = "/sandbox/../other"),
    ],
    [
      "config outside home",
      (value: Record<string, unknown>) => (filesystem(value).configDirectory = "/var/lib/hermes"),
    ],
  ])("rejects %s before workspace mutation (#11079)", (_label, mutate) => {
    const value = mutableContract();
    mutate(value);

    expect(() => parsePortableAgentRuntimeContractV1(value, loadAgent("hermes"))).toThrow(
      /portable agent runtime contract/u,
    );
  });

  it("rejects fixed runtime identity fields rather than adopting an image UID (#11079)", () => {
    const value = mutableContract();
    value.runtimeIdentity = { requirement: "non-root", uid: 1000, user: "hermes" };

    expect(() => parsePortableAgentRuntimeContractV1(value, loadAgent("hermes"))).toThrow(
      /contract.runtimeIdentity must be "non-root"/u,
    );
  });

  it("rejects credential values and unowned fields without retaining their content (#11079)", () => {
    const value = mutableContract();
    value.apiKey = "do-not-store";

    let error: unknown;
    try {
      parsePortableAgentRuntimeContractV1(value, loadAgent("hermes"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("contract must contain exactly");
    expect(String(error)).not.toContain("do-not-store");
  });

  it("binds compatibility to agent-owned state and health semantics (#11079)", () => {
    const contract = hermesContract();
    const agent = loadAgent("hermes");
    const changedAgent = {
      ...agent,
      stateFiles: [...agent.stateFiles, { path: "future.db", strategy: "sqlite_backup" as const }],
    } as AgentDefinition;

    expect(() => parsePortableAgentRuntimeContractV1(contract, changedAgent)).toThrow(
      /agentDefinitionSha256 does not match/u,
    );

    const changedHealth = mutableContract();
    (changedHealth.health as Record<string, unknown>).timeoutSeconds = 91;
    expect(() => parsePortableAgentRuntimeContractV1(changedHealth, agent)).toThrow(
      /contract.health does not match the agent definition/u,
    );
  });

  it("accepts a provider that advertises every portable v1 guarantee (#11079)", () => {
    const contract = hermesContract();

    expect(portableAgentRuntimeSupportError(fullProviderSupport(), contract)).toBeNull();
    expect(portableAgentRuntimeSupportError(null, contract)).toContain("does not advertise");
  });

  it.each([
    ["exact digest", { exactDigestReferences: false }, "exact-digest"],
    ["agent", { agents: ["openclaw"] }, "selected agent"],
    ["platform", { platforms: ["linux/arm64"] }, "selected platform"],
    ["contract version", { contractVersions: [2] }, "portable contract version"],
    ["capability version", { capabilityContractVersions: [2] }, "portable capability version"],
    ["tokenized command", { tokenizedStartupCommands: false }, "tokenized startup commands"],
    ["OpenShell command", { openshellSandboxCommand: false }, "OpenShell sandbox command"],
    [
      "non-root identity",
      { runtimeSelectedNonRootIdentity: false },
      "runtime-selected non-root identity",
    ],
    ["workspace ownership", { openshellWorkspaceOwnership: false }, "workspace ownership"],
    ["private state", { ownerOnlyPrivateState: false }, "owner-only private state"],
  ] as const)("rejects provider support missing %s (#11079)", (_label, change, message) => {
    expect(
      portableAgentRuntimeSupportError(
        { ...fullProviderSupport(), ...change } as PortableAgentRuntimeProviderSupport,
        hermesContract(),
      ),
    ).toContain(message);
  });

  it("rejects a configuration directory not owned by the agent definition (#11079)", () => {
    const value = mutableContract();
    filesystem(value).configDirectory = "/sandbox/.other";

    expect(() => parsePortableAgentRuntimeContractV1(value, loadAgent("hermes"))).toThrow(
      /configDirectory does not match the agent definition/u,
    );
  });

  it("rejects accessor-backed declarations before reading their values (#11079)", () => {
    const value = mutableContract();
    Object.defineProperty(value, "agent", {
      enumerable: true,
      get() {
        throw new Error("untrusted getter ran");
      },
    });

    expect(() => parsePortableAgentRuntimeContractV1(value, loadAgent("hermes"))).toThrow(
      /payload must contain only JSON data properties/u,
    );
  });

  it("rejects accessor-backed arrays without reading their values (#11079)", () => {
    const value = mutableContract();
    const names = value.credentialEnvironmentNames as string[];
    let getterRan = false;
    Object.defineProperty(names, "0", {
      enumerable: true,
      get() {
        getterRan = true;
        return "API_SERVER_KEY";
      },
    });

    expect(() => parsePortableAgentRuntimeContractV1(value, loadAgent("hermes"))).toThrow(
      /payload must contain only JSON data properties/u,
    );
    expect(getterRan).toBe(false);
  });
});
