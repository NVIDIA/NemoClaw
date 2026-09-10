// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Configuration is a separate executable entrypoint: it must not import agent startup.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { NATIVE_EXPRESS } from "./native-inference-manifest.mts";
import { inspectPrebuiltNativeModel } from "./native-prebuilt-inference.mts";
import {
  NATIVE_SERVICES,
  nativeServiceBinding,
  normalizeNativeOptions,
  readNativeServiceEnvironment,
  selectedNativeServices,
  type NativeOptions,
} from "./native-options.mts";
import {
  deleteCredentialByBinding,
  nativeCredentialBinding,
  readOpenedRegularFile,
  readWindowsCredential,
} from "./native-security.mts";

export type NativeOnboardingConfiguration = {
  agent: string;
  inference: string;
  endpoint?: string;
  model: string;
  credential: string;
  options: NativeOptions & Record<string, unknown>;
  localModel?: string;
};

function fail(message: string): never {
  throw new Error(`NemoClaw native Windows launch failed: ${message}`);
}

function requiredDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) fail(`${label} is missing`);
  return resolved;
}

const PROVIDER_CONFIGURATION: Record<
  string,
  { endpoint: string | null; credentialRequired: boolean; credentialPrefix: string | null }
> = {
  nvidia: {
    endpoint: "https://integrate.api.nvidia.com/v1",
    credentialRequired: true,
    credentialPrefix: "nvapi-",
  },
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1",
    credentialRequired: true,
    credentialPrefix: "sk-or-",
  },
  compatible: { endpoint: null, credentialRequired: false, credentialPrefix: null },
  local: { endpoint: null, credentialRequired: false, credentialPrefix: null },
};

function normalizeProviderCredential(inference: string, value: unknown): string {
  const provider = PROVIDER_CONFIGURATION[inference];
  const credential = typeof value === "string" ? value.trim() : "";
  if (Buffer.byteLength(credential, "utf8") > 2048 || /[\u0000\r\n]/u.test(credential))
    throw new Error("The provider credential is invalid.");
  if (provider.credentialRequired && !credential)
    throw new Error("The selected provider requires an API key.");
  if (provider.credentialPrefix && !credential.startsWith(provider.credentialPrefix))
    throw new Error(`The ${inference} API key has an unexpected format.`);
  return credential;
}

export function normalizeOnboardingConfiguration(
  submitted: { agent: string; inference: string; options: Record<string, unknown> },
  qualification: boolean,
  metadataOnly = false,
): NativeOnboardingConfiguration {
  const agents = new Set(["openclaw", "hermes", "langchain-deepagents-code", "pi", "nemocua"]);
  if (!agents.has(submitted?.agent)) throw new Error("Select a valid agent runtime.");
  if (qualification) {
    if (submitted?.inference !== "qualification")
      throw new Error("Qualification must use its deterministic local inference endpoint.");
    return {
      agent: submitted.agent,
      inference: "qualification",
      endpoint: "http://127.0.0.1/qualification",
      model: "native-preview",
      credential: "",
      options: submitted.options ?? {},
    };
  }
  if (!Object.hasOwn(PROVIDER_CONFIGURATION, submitted?.inference))
    throw new Error("Select a valid inference provider.");
  const provider = PROVIDER_CONFIGURATION[submitted.inference];
  const options = submitted?.options;
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new Error("Onboarding options are invalid.");
  if (options.localModel !== undefined) {
    if (
      submitted.inference !== "local" ||
      options.localModel !== NATIVE_EXPRESS.id ||
      options.model !== NATIVE_EXPRESS.model ||
      options.endpoint !== undefined ||
      (options.credential !== undefined && options.credential !== "")
    )
      throw new Error(
        "The prebuilt local model must be a logical selection without an endpoint or external key.",
      );
    return {
      agent: submitted.agent,
      inference: "local",
      model: NATIVE_EXPRESS.model,
      localModel: NATIVE_EXPRESS.id,
      credential: "",
      options,
    };
  }
  const submittedEndpoint = typeof options.endpoint === "string" ? options.endpoint.trim() : "";
  const endpoint = provider.endpoint ?? submittedEndpoint;
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint ?? "");
  } catch {
    throw new Error("Enter a complete inference endpoint URL.");
  }
  const endpointIsAllowed =
    submitted.inference === "local"
      ? endpointUrl.protocol === "http:" || endpointUrl.protocol === "https:"
      : endpointUrl.protocol === "https:";
  if (!endpointIsAllowed) throw new Error("The selected inference endpoint protocol is unsafe.");
  if (
    submitted.inference === "local" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(endpointUrl.hostname)
  )
    throw new Error("Local inference must use a loopback endpoint.");
  const model = typeof options.model === "string" ? options.model.trim() : "";
  if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model))
    throw new Error("Enter a valid model ID.");
  const credential = metadataOnly
    ? ""
    : normalizeProviderCredential(submitted.inference, options.credential);
  return {
    agent: submitted.agent,
    inference: submitted.inference,
    endpoint: endpointUrl.toString().replace(/\/$/u, ""),
    model,
    credential,
    options,
  };
}

export function writeNativeAgentConfiguration(configuration: NativeOnboardingConfiguration) {
  const localAppData = requiredDirectory(
    process.env.LOCALAPPDATA ?? "",
    "Windows local application-data directory",
  );
  const stateRoot = path.join(localAppData, "NVIDIA", "NemoClaw", "agents", configuration.agent);
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const configPath = path.join(stateRoot, "native-windows.json");
  const temporaryPath = `${configPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const persisted = {
    schemaVersion: 1,
    classification: "nemoclaw-native-windows-agent-configuration",
    agent: configuration.agent,
    inference: configuration.inference,
    endpoint: configuration.endpoint,
    model: configuration.model,
    credentialStored: Boolean(configuration.credential),
    profile: "personal",
    ...(configuration.localModel ? { localModel: configuration.localModel } : {}),
    options: Object.fromEntries(
      Object.entries(configuration.options).filter(
        ([name]) => !["credential", "endpoint", "model"].includes(name),
      ),
    ),
  };
  fs.writeFileSync(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, configPath);
  const activePath = path.join(localAppData, "NVIDIA", "NemoClaw", "active-agent.txt");
  const activeTemporaryPath = `${activePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(activeTemporaryPath, `${configuration.agent}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(activeTemporaryPath, activePath);
  return configPath;
}

export async function configureNativeFromStdin(
  launcher: string,
  args: readonly string[] = process.argv,
  input: AsyncIterable<Buffer> = process.stdin,
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  dependencies: { inspectModel?: typeof inspectPrebuiltNativeModel } = {},
) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) fail("native setup configuration exceeds its size limit");
    chunks.push(chunk);
  }
  const submitted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    submitted?.schemaVersion !== 1 ||
    submitted?.classification !== "nemoclaw-native-windows-agent-configuration" ||
    typeof submitted?.credentialStored !== "boolean" ||
    (submitted?.localModel === undefined
      ? typeof submitted?.endpoint !== "string"
      : submitted.endpoint !== undefined) ||
    typeof submitted?.model !== "string" ||
    !Object.hasOwn(PROVIDER_CONFIGURATION, submitted?.inference) ||
    submitted?.options === null ||
    typeof submitted?.options !== "object" ||
    Array.isArray(submitted.options) ||
    (submitted.profile !== undefined && submitted.profile !== "personal") ||
    (submitted.localModel !== undefined &&
      (submitted.localModel !== "n1x-qwen3.6-35b-a3b" ||
        submitted.inference !== "local" ||
        submitted.credentialStored ||
        submitted.model !== NATIVE_EXPRESS.model))
  )
    fail("native setup configuration is invalid");
  const normalized = normalizeOnboardingConfiguration(
    {
      agent: submitted.agent,
      inference: submitted.inference,
      options: {
        endpoint: submitted.endpoint,
        model: submitted.model,
        ...(submitted.localModel ? { localModel: submitted.localModel } : {}),
      },
    },
    false,
    true,
  );
  normalized.options = normalizeNativeOptions(submitted.agent, submitted.options);
  if (submitted.localModel) normalized.localModel = submitted.localModel;
  const servicePosition = args.indexOf("--prepare-service");
  if (servicePosition !== -1) {
    const service = args[servicePosition + 1] ?? "";
    if (!selectedNativeServices(normalized.options).some((selected) => selected === service))
      fail("the service is not selected for this agent");
    output.write(nativeServiceBinding(submitted.agent, service ?? ""));
    return;
  }
  if (
    PROVIDER_CONFIGURATION[normalized.inference].credentialRequired &&
    !submitted.credentialStored
  )
    fail("the selected provider requires a credential");
  const localModel = normalized.localModel
    ? await (dependencies.inspectModel ?? inspectPrebuiltNativeModel)(
        path.dirname(path.dirname(launcher)),
        launcher,
      )
    : undefined;
  const binding = normalized.localModel
    ? null
    : nativeCredentialBinding({ ...normalized, endpoint: normalized.endpoint! });
  if (args.includes("--prepare-all")) {
    output.write(
      JSON.stringify({
        schemaVersion: 1,
        inference: binding,
        ...(localModel ? { localModel } : {}),
        services: Object.fromEntries(
          selectedNativeServices(normalized.options).map((service) => [
            service,
            nativeServiceBinding(normalized.agent, service),
          ]),
        ),
      }),
    );
    return;
  }
  if (args.includes("--prepare")) {
    if (binding === null)
      fail("a prebuilt local model does not use an external inference credential binding");
    output.write(binding);
    return;
  }
  const credential = normalized.localModel
    ? ""
    : await readWindowsCredential(
        launcher,
        { ...normalized, endpoint: normalized.endpoint! },
        submitted.credentialStored,
      );
  normalized.credential = normalizeProviderCredential(normalized.inference, credential);
  await readNativeServiceEnvironment(launcher, normalized.agent, normalized.options);
  const previousPath = path.join(
    requiredDirectory(process.env.LOCALAPPDATA ?? "", "Windows local application-data directory"),
    "NVIDIA",
    "NemoClaw",
    "agents",
    normalized.agent,
    "native-windows.json",
  );
  const previousText = readOpenedRegularFile(previousPath, {
    encoding: "utf8",
    maxBytes: 16 * 1024,
  });
  const previous = previousText === null ? null : JSON.parse(previousText);
  const previousBinding =
    previous?.schemaVersion === 1 &&
    previous?.agent === normalized.agent &&
    previous?.credentialStored === true
      ? nativeCredentialBinding(previous)
      : null;
  writeNativeAgentConfiguration(normalized);
  if (previousBinding && previousBinding !== binding)
    await deleteCredentialByBinding(launcher, previous.inference, previousBinding);
  const selectedServices = selectedNativeServices(normalized.options);
  for (const service of Object.keys(NATIVE_SERVICES)) {
    if (!selectedServices.some((selected) => selected === service))
      await deleteCredentialByBinding(
        launcher,
        service,
        nativeServiceBinding(normalized.agent, service),
      );
  }
}
