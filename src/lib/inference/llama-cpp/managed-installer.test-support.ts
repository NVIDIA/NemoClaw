// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, vi } from "vitest";
import type { PodmanContainerEngine } from "../../adapters/podman";
import { createDockerRuntimeProviderBundle } from "../../onboard/runtime-provider/docker";
import { dockerLlamaCppBindingSha256 as managedLlamaCppBindingSha256 } from "../../onboard/runtime-provider/docker-llama-cpp-operation";
import type {
  HostLocalInferenceOperation,
  HostLocalLlamaCppLifecycle,
} from "../../onboard/runtime-provider/host-local-inference";
import { isLlamaCppServingRecipe } from "../serving/adapter-registry";
import * as catalogLoader from "../serving/catalog-loader";
import type { ResolvedLlamaCppInferenceSelection } from "../serving/types";

import type {
  ContainerEngine,
  ContainerEngineCommandCapture,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import { MANAGED_LLAMA_CPP_NETWORK_NAME } from "./managed-installer";

export function engineHarness(): {
  engine: ContainerEngine;
  capture: ReturnType<typeof vi.fn>;
  images: Set<string>;
  pullResults: ContainerEngineCommandResult[];
  pulledImages: string[];
} {
  let networkPresent = false;
  const images = new Set<string>();
  const pullResults: ContainerEngineCommandResult[] = [];
  const pulledImages: string[] = [];
  const capture = vi.fn((args: readonly string[]) => {
    if (args[0] === "network" && args[1] === "create") {
      networkPresent = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      if (!networkPresent) return { status: 1, stdout: "", stderr: "No such network" };
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            Driver: "bridge",
            Id: "a".repeat(64),
            Internal: true,
            Labels: { "io.nvidia.nemoclaw.managed-llama-cpp": "true" },
            Name: MANAGED_LLAMA_CPP_NETWORK_NAME,
            Scope: "local",
          },
        ]),
      };
    }
    if (args[0] === "network" && args[1] === "rm") {
      if (!networkPresent || args[2] !== "a".repeat(64)) {
        return { status: 1, stdout: "", stderr: "No such network" };
      }
      networkPresent = false;
      return { status: 0, stdout: `${args[2]}\n`, stderr: "" };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return { status: 1, stdout: "", stderr: "No such container" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return images.has(args[2]!)
        ? { status: 0, stdout: "[]", stderr: "" }
        : { status: 1, stdout: "", stderr: "No such image" };
    }
    if (args[0] === "pull") {
      const image = args[1]!;
      pulledImages.push(image);
      const result = pullResults.shift() ?? { status: 0, stdout: "", stderr: "" };
      if (!result.error && result.status === 0) images.add(image);
      return result;
    }
    throw new Error(`unexpected engine command: ${args.join(" ")}`);
  });
  return {
    capture,
    images,
    pullResults,
    pulledImages,
    engine: {
      operation: "host-local-inference",
      engineId: "docker",
      displayName: "Docker",
      authorityId: "docker:test",
      capture,
      captureHost: capture,
    },
  };
}

export function successfulDockerCapture(
  endpoints: Readonly<
    Record<
      string,
      | string
      | {
          readonly host: string;
          readonly skipTlsVerify: boolean;
          readonly tlsMaterial: readonly string[];
        }
    >
  >,
  currentContext = "default",
): ReturnType<typeof vi.fn<ContainerEngineCommandCapture>> {
  return vi.fn<ContainerEngineCommandCapture>((_executable, args) => {
    const contextCommand = args.findIndex(
      (value, index) => value === "context" && args[index + 1] === "inspect",
    );
    if (contextCommand >= 0) {
      const context = args[contextCommand + 2] ?? "";
      const configuredEndpoint = endpoints[context];
      if (!configuredEndpoint) return { status: 1, stdout: "", stderr: "context not found" };
      const endpoint =
        typeof configuredEndpoint === "string"
          ? { host: configuredEndpoint, skipTlsVerify: false, tlsMaterial: [] }
          : configuredEndpoint;
      return {
        status: 0,
        stdout: JSON.stringify({
          Endpoints: {
            docker: { Host: endpoint.host, SkipTLSVerify: endpoint.skipTlsVerify },
          },
          TLSMaterial: { docker: endpoint.tlsMaterial },
        }),
        stderr: "",
      };
    }
    const showCommand = args.findIndex(
      (value, index) => value === "context" && args[index + 1] === "show",
    );
    if (showCommand >= 0) {
      return { status: 0, stdout: `${currentContext}\n`, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
}

export function driftingDockerCapture(): ReturnType<typeof vi.fn<ContainerEngineCommandCapture>> {
  let inspections = 0;
  return vi.fn<ContainerEngineCommandCapture>((_executable, args) => {
    const contextCommand = args.findIndex(
      (value, index) => value === "context" && args[index + 1] === "inspect",
    );
    if (contextCommand >= 0 || args.includes("inspect")) {
      inspections += 1;
      return {
        status: 0,
        stdout: JSON.stringify({
          Endpoints: {
            docker: {
              Host:
                inspections === 1
                  ? "ssh://nvidia@spark-a.example.test"
                  : "ssh://nvidia@spark-b.example.test",
              SkipTLSVerify: false,
            },
          },
          TLSMaterial: { docker: [] },
        }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
}

export function inertPodmanEngine(
  operation: "host-doctor" | "sandbox-lifecycle",
  capture: ContainerEngine["capture"],
  captureHost: ContainerEngine["captureHost"],
): PodmanContainerEngine {
  return {
    operation,
    engineId: "podman",
    displayName: "Podman",
    authorityId: "test:podman-socket",
    endpointAuthorityId: "test:podman-socket",
    capture,
    captureHost,
  };
}

export function managedOperation(
  engine: HostLocalInferenceOperation["engine"],
  createLlamaCppLifecycle: (
    input: Parameters<HostLocalInferenceOperation["createLlamaCppLifecycle"]>[0],
  ) => HostLocalLlamaCppLifecycle,
): HostLocalInferenceOperation {
  return {
    providerId: "docker",
    engine,
    bindingSha256: managedLlamaCppBindingSha256(engine),
    assertAuthority: vi.fn(),
    spawn: vi.fn(() => ({}) as never),
    createLlamaCppLifecycle,
  };
}

export function managedRuntimeProvider(
  engine: HostLocalInferenceOperation["engine"],
  createLlamaCppLifecycle: HostLocalInferenceOperation["createLlamaCppLifecycle"] = vi.fn(() => {
    throw new Error("Unexpected managed llama.cpp lifecycle construction");
  }),
) {
  const bundle = createDockerRuntimeProviderBundle();
  return {
    ...bundle,
    hostLocalInference: {
      providerId: "docker",
      supported: true as const,
      services: ["llama-cpp" as const],
      createOperation: vi.fn(() => managedOperation(engine, createLlamaCppLifecycle)),
    },
  };
}

export function selection(): ResolvedLlamaCppInferenceSelection {
  const catalog = catalogLoader.loadManagedInferenceCatalog();
  const recipe = catalog.recipes.find(
    ({ metadata }) => metadata.id === "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1",
  );
  const preset = catalog.presets.find(
    ({ metadata }) => metadata.id === "llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b",
  );
  expect(recipe, "managed llama.cpp recipe fixture is unavailable").toBeDefined();
  expect(isLlamaCppServingRecipe(recipe!), "managed llama.cpp recipe fixture is invalid").toBe(
    true,
  );
  expect(preset, "managed llama.cpp preset fixture is unavailable").toBeDefined();
  return {
    outcome: "selected",
    selection: "explicit",
    catalogDigest: catalog.catalogDigest,
    presetDigest: catalog.sources.find(
      ({ kind, id }) => kind === "ServingPreset" && id === preset!.metadata.id,
    )!.digest,
    recipeDigest: catalog.sources.find(
      ({ kind, id }) => kind === "ServingRecipe" && id === recipe!.metadata.id,
    )!.digest,
    preset: preset!,
    recipe: recipe! as ResolvedLlamaCppInferenceSelection["recipe"],
  };
}
