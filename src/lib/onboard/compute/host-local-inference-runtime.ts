// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  configureHostContainerEngine,
  type HostContainerEngineCommand,
} from "../../adapters/container-engine";
import type { OpenShellComputePlan } from "./plan";
import {
  assertPodmanGpuAttachmentQualified,
  normalizeNvidiaCdiDevice,
} from "./podman/gpu-attachment";
import {
  assertPodmanSocketAuthority,
  type PodmanSocketAuthority,
  type PodmanSocketAuthorityDeps,
} from "./podman/socket-authority";
import {
  assessNativePodman,
  type NativePodmanPreflightDeps,
  type NativePodmanPreflightReceipt,
} from "./podman-preflight";

export interface HostLocalInferenceRuntimeAdapter {
  readonly driverName: string;
  activate(input: HostLocalInferenceRuntimeActivationInput): () => void;
}

export type HostLocalInferenceRuntimeAdapterRegistry = Readonly<
  Record<string, HostLocalInferenceRuntimeAdapter>
>;

export interface HostLocalInferenceRuntimeActivationInput {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativePodmanDeps?: NativePodmanPreflightDeps;
  readonly podmanBin?: string;
  readonly qualifiedPodmanRuntime?: NativePodmanPreflightReceipt;
  readonly socketAuthorityDeps?: PodmanSocketAuthorityDeps;
  readonly configureContainerEngine?: typeof configureHostContainerEngine;
}

function dockerRuntimeAdapter(driverName: string): HostLocalInferenceRuntimeAdapter {
  return {
    driverName,
    activate(input) {
      const configure = input.configureContainerEngine ?? configureHostContainerEngine;
      return configure({
        driverName: "docker",
        executable: "docker",
      });
    },
  };
}

export interface PodmanLocalInferenceTranslationOptions {
  readonly availableCdiDevices?: readonly string[];
}

function stripExactDoubleQuotes(raw: string): string {
  const trimmed = raw.trim();
  const startsQuoted = trimmed.startsWith('"');
  const endsQuoted = trimmed.endsWith('"');
  if (startsQuoted !== endsQuoted) {
    throw new Error(`Podman local inference cannot translate Docker GPU selector '${raw}' to CDI.`);
  }
  return startsQuoted ? trimmed.slice(1, -1) : trimmed;
}

function normalizePodmanGpuSelector(
  raw: string,
  options: PodmanLocalInferenceTranslationOptions,
): string[] {
  const selector = stripExactDoubleQuotes(raw);
  const names =
    selector === "all"
      ? ["all"]
      : selector.startsWith("device=")
        ? selector.slice("device=".length).split(",")
        : [];
  if (names.length === 0 || names.some((name) => !name.trim())) {
    throw new Error(`Podman local inference cannot translate Docker GPU selector '${raw}' to CDI.`);
  }

  const devices = names.map((name) => normalizeNvidiaCdiDevice(name.trim()));
  if (new Set(devices).size !== devices.length) {
    throw new Error(`Podman local inference GPU selector '${raw}' contains a duplicate device.`);
  }
  if (options.availableCdiDevices) {
    for (const device of devices) {
      assertPodmanGpuAttachmentQualified(options.availableCdiDevices, {
        kind: "cdi",
        device,
      });
    }
  }
  return devices;
}

/**
 * Translate the small Docker-compatible argv subset used by managed NIM and
 * single-host vLLM. GPU selection is converted to Podman's CDI-native form;
 * a Docker-only selector fails closed instead of silently launching on CPU.
 */
export function translateLocalInferenceArgsForPodman(
  args: readonly string[],
  options: PodmanLocalInferenceTranslationOptions = {},
): string[] {
  const translated: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (value === "--gpus") {
      const selector = args[index + 1];
      if (!selector) throw new Error("Podman local inference requires a GPU selector value.");
      for (const device of normalizePodmanGpuSelector(selector, options)) {
        translated.push("--device", device);
      }
      index += 1;
      continue;
    }
    if (value.startsWith("--gpus=")) {
      const selector = value.slice("--gpus=".length);
      for (const device of normalizePodmanGpuSelector(selector, options)) {
        translated.push("--device", device);
      }
      continue;
    }
    if (value === "--runtime" && String(args[index + 1] ?? "").toLowerCase() === "nvidia") {
      throw new Error(
        "Podman local inference refuses Docker's NVIDIA runtime mode; an exact CDI device is required.",
      );
    }
    if (value.toLowerCase() === "--runtime=nvidia") {
      throw new Error(
        "Podman local inference refuses Docker's NVIDIA runtime mode; an exact CDI device is required.",
      );
    }
    if (value === "--device") {
      const device = args[index + 1];
      if (!device) throw new Error("Podman local inference requires a --device value.");
      if (device.startsWith("nvidia.com/gpu=")) {
        const normalized = normalizeNvidiaCdiDevice(device);
        if (options.availableCdiDevices) {
          assertPodmanGpuAttachmentQualified(options.availableCdiDevices, {
            kind: "cdi",
            device: normalized,
          });
        }
        translated.push("--device", normalized);
        index += 1;
        continue;
      }
      if (/^\/dev\/nvidia/u.test(device)) {
        throw new Error(
          "Podman local inference refuses raw NVIDIA device paths; an exact CDI device is required.",
        );
      }
    }
    if (value.startsWith("name=^/") && value.endsWith("$")) {
      translated.push(`name=^${value.slice("name=^/".length)}`);
      continue;
    }
    translated.push(value);
  }
  return translated;
}

function podmanCommand(input: {
  readonly assertAuthority: (authority: PodmanSocketAuthority) => void;
  readonly authority: PodmanSocketAuthority;
  readonly availableCdiDevices: readonly string[];
  readonly architecture: "amd64" | "arm64";
  readonly networkName: string;
  readonly podmanBin: string;
}): HostContainerEngineCommand {
  return {
    driverName: "podman",
    executable: input.podmanBin,
    prefixArgs: ["--url", `unix://${input.authority.socketPath}`],
    runtimeArchitecture: input.architecture,
    sandboxNetworkName: input.networkName,
    hostGatewayTarget: "host-gateway",
    assertAuthority: () => input.assertAuthority(input.authority),
    translateArgs: (args) =>
      translateLocalInferenceArgsForPodman(args, {
        availableCdiDevices: input.availableCdiDevices,
      }),
  };
}

const podmanRuntimeAdapter: HostLocalInferenceRuntimeAdapter = {
  driverName: "podman",
  activate(input) {
    const environment = input.environment ?? process.env;
    const socketPath = environment.OPENSHELL_PODMAN_SOCKET?.trim();
    if (!socketPath) {
      throw new Error(
        "Native Podman host-local inference requires the qualified OPENSHELL_PODMAN_SOCKET.",
      );
    }
    const qualified =
      input.qualifiedPodmanRuntime ??
      assessNativePodman({
        ...input.nativePodmanDeps,
        env: environment,
      });
    if (qualified.driverName !== "podman" || qualified.socketPath !== socketPath) {
      throw new Error(
        "Native Podman host-local inference runtime does not match the qualified Podman socket.",
      );
    }
    const authority = qualified.socketAuthority;
    if (authority.socketPath !== socketPath) {
      throw new Error(
        "Native Podman host-local inference socket authority does not match the qualified runtime.",
      );
    }
    const assertAuthority = (expected: PodmanSocketAuthority) =>
      assertPodmanSocketAuthority(expected, input.socketAuthorityDeps);
    assertAuthority(authority);
    const configure = input.configureContainerEngine ?? configureHostContainerEngine;
    return configure(
      podmanCommand({
        assertAuthority,
        authority,
        availableCdiDevices: qualified.cdiDevices,
        architecture: qualified.architecture,
        networkName: environment.OPENSHELL_PODMAN_NETWORK_NAME?.trim() || "openshell",
        podmanBin: input.podmanBin ?? environment.NEMOCLAW_PODMAN_BIN?.trim() ?? "podman",
      }),
    );
  },
};

export const CURRENT_HOST_LOCAL_INFERENCE_RUNTIME_ADAPTERS = {
  docker: dockerRuntimeAdapter("docker"),
  kubernetes: dockerRuntimeAdapter("kubernetes"),
  podman: podmanRuntimeAdapter,
} as const satisfies HostLocalInferenceRuntimeAdapterRegistry;

/**
 * Activate the host-container lifecycle used by Ollama's optional probe
 * containers and by managed NIM/vLLM. The registry is keyed by compute driver,
 * so MXC can supply its own engine/endpoint without inheriting Podman.
 */
export function activateHostLocalInferenceRuntime(
  plan: Pick<OpenShellComputePlan, "driverName">,
  input: HostLocalInferenceRuntimeActivationInput = {},
  adapters: HostLocalInferenceRuntimeAdapterRegistry = CURRENT_HOST_LOCAL_INFERENCE_RUNTIME_ADAPTERS,
): () => void {
  const adapter = Object.hasOwn(adapters, plan.driverName) ? adapters[plan.driverName] : undefined;
  if (!adapter || adapter.driverName !== plan.driverName) {
    throw new Error(
      `OpenShell compute driver '${plan.driverName}' has no registered host-local inference runtime adapter.`,
    );
  }
  return adapter.activate(input);
}
