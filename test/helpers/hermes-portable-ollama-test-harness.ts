// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ContainerEngineCommandCapture,
  ContainerEngineCommandResult,
} from "../../src/lib/adapters/container-engine";

const REGISTRY_ID = "7".repeat(64);

export interface PortablePodmanAuthorityState {
  networkId: string;
  networkLabels?: Record<string, string>;
  networkBackend?: string;
  subordinateIdSize?: number;
  registryCopies?: number;
  registryId?: string;
  registryLabel?: string;
  registryNetworkId?: string;
  images?: Set<string>;
  failPull?: string | null;
}

export function createPortablePodmanCapture(
  events: string[],
  authorityState: PortablePodmanAuthorityState,
  fallback?: (
    args: readonly string[],
    timeoutMs?: number,
    input?: Buffer,
  ) => ContainerEngineCommandResult,
): ContainerEngineCommandCapture {
  return (executable, args, timeoutMs, input) => {
    const socketUrl = args[1];
    if (args[0] !== "--url" || typeof socketUrl !== "string" || socketUrl.length === 0) {
      throw new Error(`Unexpected Podman global arguments: ${args.join(" ")}`);
    }
    const command = args.slice(2);
    events.push(`podman:${command.join(" ")} executable=${executable} socket=${socketUrl}`);
    if (command[0] === "version") {
      return {
        status: 0,
        stdout: JSON.stringify({ Client: { Version: "5.7.0" }, Server: { Version: "5.7.0" } }),
        stderr: "",
      };
    }
    if (command[0] === "info") {
      return {
        status: 0,
        stdout: JSON.stringify({
          host: {
            arch: "amd64",
            os: "linux",
            cgroupVersion: "v2",
            networkBackend: authorityState.networkBackend ?? "netavark",
            security: { rootless: true },
            idMappings: {
              uidmap: [
                { container_id: 0, host_id: 1000, size: 1 },
                {
                  container_id: 1,
                  host_id: 100000,
                  size: authorityState.subordinateIdSize ?? 65536,
                },
              ],
              gidmap: [
                { container_id: 0, host_id: 1000, size: 1 },
                {
                  container_id: 1,
                  host_id: 100000,
                  size: authorityState.subordinateIdSize ?? 65536,
                },
              ],
            },
          },
        }),
        stderr: "",
      };
    }
    if (command[0] === "network" && command[1] === "inspect") {
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            id: authorityState.networkId,
            name: "openshell-docker",
            driver: "bridge",
            internal: false,
            ipv6_enabled: false,
            dns_enabled: true,
            network_interface: "podman9",
            subnets: [{ subnet: "10.87.0.0/24", gateway: "10.87.0.1" }],
            labels: authorityState.networkLabels ?? {},
            ipam_options: {},
            options: {},
          },
        ]),
        stderr: "",
      };
    }
    if (
      command[0] === "container" &&
      command[1] === "inspect" &&
      command[2] === "nemoclaw-portable-registry"
    ) {
      const registry = {
        Id: authorityState.registryId ?? REGISTRY_ID,
        Name: "nemoclaw-portable-registry",
        Config: {
          Labels: { "com.nvidia.nemoclaw.portable": authorityState.registryLabel ?? "1" },
        },
        State: { Running: true },
        NetworkSettings: {
          Networks: {
            "openshell-docker": {
              NetworkID: authorityState.registryNetworkId ?? authorityState.networkId,
              IPAddress: "10.87.0.3",
            },
          },
        },
      };
      return {
        status: 0,
        stdout: JSON.stringify(
          Array.from({ length: authorityState.registryCopies ?? 1 }, () => registry),
        ),
        stderr: "",
      };
    }
    if (command[0] === "image" && command[1] === "exists") {
      return {
        status: authorityState.images?.has(String(command[2])) === false ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    }
    if (command[0] === "pull") {
      if (authorityState.failPull === command[1]) {
        return { status: 125, stdout: "", stderr: "injected image pull failure" };
      }
      authorityState.images?.add(String(command[1]));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (fallback) return fallback(command, timeoutMs, input);
    throw new Error(`Unexpected Podman command: ${command.join(" ")}`);
  };
}

export interface PortableGatewayProviderHarness {
  readonly run: (
    args: string[],
    options: {
      ignoreError: true;
      suppressOutput: true;
      stdio: ["ignore", "pipe", "pipe"];
      env?: NodeJS.ProcessEnv;
      timeout: number;
    },
  ) => ContainerEngineCommandResult;
  readonly calls: () => ReadonlyArray<{
    readonly args: readonly string[];
    readonly timeout: number;
  }>;
  readonly credentialEnv: () => string;
  readonly isPresent: () => boolean;
  readonly bumpResourceVersion: () => void;
  readonly setDeleteFailure: (value: boolean) => void;
  readonly setCreateTransportAmbiguity: (value: boolean) => void;
  readonly setForeignCreateCredentialEnv: (value: string | null) => void;
  readonly setCredentialEnv: (value: string) => void;
  readonly setLookupFailure: (value: boolean) => void;
  readonly setMalformed: (value: boolean) => void;
  readonly setPresent: (value: boolean) => void;
  readonly setProfileState: (
    value: "exact" | "missing" | "incompatible" | "import-failed",
  ) => void;
}

export function createPortableGatewayProviderHarness(
  events: string[],
): PortableGatewayProviderHarness {
  let present = false;
  let malformed = false;
  let deleteFailure = false;
  let createTransportAmbiguity = false;
  let foreignCreateCredentialEnv: string | null = null;
  let lookupFailure = false;
  let resourceVersion = 1;
  let credentialEnv = "NEMOCLAW_OLLAMA_PROXY_TOKEN";
  let profileState: "exact" | "missing" | "incompatible" | "import-failed" = "exact";
  const calls: Array<{ readonly args: readonly string[]; readonly timeout: number }> = [];
  return Object.freeze({
    calls: () => calls,
    credentialEnv: () => credentialEnv,
    isPresent: () => present,
    bumpResourceVersion: () => {
      resourceVersion += 1;
    },
    setDeleteFailure: (value: boolean) => {
      deleteFailure = value;
    },
    setCreateTransportAmbiguity: (value: boolean) => {
      createTransportAmbiguity = value;
    },
    setForeignCreateCredentialEnv: (value: string | null) => {
      foreignCreateCredentialEnv = value;
    },
    setCredentialEnv: (value: string) => {
      credentialEnv = value;
    },
    setLookupFailure: (value: boolean) => {
      lookupFailure = value;
    },
    setMalformed: (value: boolean) => {
      malformed = value;
    },
    setPresent: (value: boolean) => {
      present = value;
    },
    setProfileState: (value: "exact" | "missing" | "incompatible" | "import-failed") => {
      profileState = value;
    },
    run(args: string[], options: Parameters<PortableGatewayProviderHarness["run"]>[1]) {
      calls.push(Object.freeze({ args: Object.freeze([...args]), timeout: options.timeout }));
      events.push(`openshell:${args.join(" ")}`);
      if (args[0] === "provider" && args[1] === "profile" && args[2] === "export") {
        if (profileState === "missing" || profileState === "import-failed") {
          return { status: 1, stdout: "", stderr: "provider profile not found" };
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            id: "openai",
            credentials: [],
            endpoints: profileState === "exact" ? [] : ["https://example.invalid"],
            binaries: [],
            inference_capable: true,
          }),
          stderr: "",
        };
      }
      if (args[0] === "provider" && args[1] === "profile" && args[2] === "import") {
        if (profileState === "import-failed") {
          return { status: 1, stdout: "", stderr: "profile import failed" };
        }
        profileState = "exact";
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "provider" && args[1] === "get") {
        if (lookupFailure) {
          return { status: 1, stdout: "", stderr: "gateway lookup failed" };
        }
        if (malformed) {
          return { status: 0, stdout: "untrusted provider output", stderr: "" };
        }
        return present
          ? {
              status: 0,
              stdout: [
                "\u001b[2mId:\u001b[0m portable-ollama-provider",
                `\u001b[2mResource version:\u001b[0m ${String(resourceVersion)}`,
                "Name: ollama-local",
                "Type: openai",
                `Credential keys: ${credentialEnv}`,
                "Config keys: OPENAI_BASE_URL",
              ].join("\n"),
              stderr: "",
            }
          : {
              status: 1,
              stdout: "",
              stderr:
                "Error: code: 'Some requested entity was not found', message: \"Provider not found\"",
            };
      }
      if (args[0] === "provider" && args[1] === "create") {
        if (present) return { status: 1, stdout: "", stderr: "provider already exists" };
        if (foreignCreateCredentialEnv !== null) {
          credentialEnv = foreignCreateCredentialEnv;
          present = true;
          resourceVersion = 1;
          return { status: 1, stdout: "", stderr: "provider already exists" };
        }
        const credentialIndex = args.indexOf("--credential");
        if (credentialIndex < 0 || typeof args[credentialIndex + 1] !== "string") {
          throw new Error("Unexpected OpenShell provider create without a credential value.");
        }
        credentialEnv = args[credentialIndex + 1];
        present = true;
        resourceVersion = 1;
        return createTransportAmbiguity
          ? { status: 1, stdout: "", stderr: "transport result unavailable" }
          : { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "provider" && args[1] === "delete") {
        if (deleteFailure) {
          return { status: 1, stdout: "", stderr: "gateway delete failed" };
        }
        present = false;
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
    },
  });
}
