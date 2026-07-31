// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type TestCommandOptions = Record<string, unknown> | undefined;
export type TestCommandResult = {
  readonly status: number;
  readonly output: string;
  readonly stdout?: string;
  readonly stderr?: string;
};
export type TestCommandHandler = (
  args: string[],
  options?: TestCommandOptions,
) => TestCommandResult;

const SUCCESSFUL_COMMAND: TestCommandResult = { status: 0, output: "" };

function missingProviderCommand(providerName: string): TestCommandResult {
  return {
    status: 1,
    stdout: "",
    stderr: `provider '${providerName}' not found`,
    output: "",
  };
}

export function providerMetadata(name: string, type: string, credentialEnv: string): string {
  return [
    `Name: ${name}`,
    `Type: ${type}`,
    `Credential keys: ${credentialEnv}`,
    "Config keys: <none>",
    "",
  ].join("\n");
}

/** In-memory provider CRUD runner shared by dormant clone lifecycle tests. */
export function managedProviderCreationRunner(
  bindings: Readonly<Record<string, { readonly type: string; readonly credential: string }>>,
): TestCommandHandler {
  const createdProviders = new Set<string>();
  return (args) => {
    if (args[0] === "provider" && args[1] === "get") {
      const providerName = args[2] ?? "";
      const binding = bindings[providerName];
      return binding !== undefined && createdProviders.has(providerName)
        ? {
            status: 0,
            stdout: providerMetadata(providerName, binding.type, binding.credential),
            stderr: "",
            output: "",
          }
        : missingProviderCommand(providerName);
    }
    if (args[0] === "provider" && args[1] === "create") {
      createdProviders.add(args[3] ?? "");
      return { status: 0, stdout: "", stderr: "", output: "" };
    }
    return SUCCESSFUL_COMMAND;
  };
}
