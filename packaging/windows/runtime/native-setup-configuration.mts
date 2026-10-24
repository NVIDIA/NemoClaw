// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Configuration is a separate executable entrypoint: it must not import agent startup.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PROVIDER_CONFIGURATION } from "./native-provider-policy.mts";
import { assertNativePackageIncludesAgent } from "./native-package-availability.mts";
import {
  assertNativeInferenceEndpoint,
  resolveNativeInferenceAddresses,
  type NativeEndpointLookup,
} from "./native-inference-endpoint.mts";
import { inspectPrebuiltNativeModel } from "./native-prebuilt-inference.mts";
import { inspectBundledNativeModel } from "./native-bundled-inference.mts";
import { isDownloadedLocalModel, localModelIdentityMatches } from "./native-local-models.mts";
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
import { acquireNativeStateConfiguration, acquireNativeStateInspection } from "./native-state.mts";
import {
  NativeCredentialTransactionError,
  nativeConfigurationCredentialStore,
  withNativeCredentialTransaction,
  type CredentialChange,
} from "./native-configuration-credentials.mts";
import {
  beginNativeConfigurationRecovery,
  completeNativeConfigurationRecovery,
  readNativeConfigurationRecovery,
} from "./native-configuration-recovery.mts";

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
  submitted: {
    agent: string;
    inference: string;
    options: Record<string, unknown>;
  },
  qualification: boolean,
  metadataOnly = false,
): NativeOnboardingConfiguration {
  const agents = new Set(["openclaw", "hermes"]);
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
  if (
    typeof submitted?.inference !== "string" ||
    !Object.hasOwn(PROVIDER_CONFIGURATION, submitted.inference)
  )
    throw new Error("Select a valid inference provider.");
  const provider = PROVIDER_CONFIGURATION[submitted.inference];
  const options = submitted?.options;
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new Error("Onboarding options are invalid.");
  if (options.localModel !== undefined) {
    if (
      submitted.inference !== "local" ||
      typeof options.localModel !== "string" ||
      typeof options.model !== "string" ||
      !localModelIdentityMatches(options.localModel, options.model) ||
      options.endpoint !== undefined ||
      (options.credential !== undefined && options.credential !== "")
    )
      throw new Error(
        "The managed local model must be a catalog selection without an endpoint or external key.",
      );
    return {
      agent: submitted.agent,
      inference: "local",
      model: options.model,
      localModel: options.localModel,
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
  const endpointIsAllowed = provider.loopbackOnly
    ? endpointUrl.protocol === "http:" || endpointUrl.protocol === "https:"
    : endpointUrl.protocol === "https:";
  if (!endpointIsAllowed) throw new Error("The selected inference endpoint protocol is unsafe.");
  if (provider.loopbackOnly && !["127.0.0.1", "localhost", "[::1]"].includes(endpointUrl.hostname))
    throw new Error("Local inference must use a loopback endpoint.");
  assertNativeInferenceEndpoint(endpointUrl, submitted.inference);
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

function nativeConfigurationChoices(configuration: NativeOnboardingConfiguration) {
  return {
    agent: configuration.agent,
    inference: configuration.inference,
    endpoint: configuration.endpoint,
    model: configuration.model,
    credentialStored: Boolean(configuration.credential),
    ...(configuration.localModel ? { localModel: configuration.localModel } : {}),
    options: Object.fromEntries(
      Object.entries(configuration.options).filter(
        ([name]) => !["credential", "endpoint", "launch", "model"].includes(name),
      ),
    ),
  };
}

export function nativeSetupRequest(configuration: NativeOnboardingConfiguration) {
  return { kind: "native-setup-request", ...nativeConfigurationChoices(configuration) };
}

export function nativeAgentConfigurationRecord(configuration: NativeOnboardingConfiguration) {
  return {
    schemaVersion: 1,
    classification: "nemoclaw-native-windows-agent-configuration",
    ...nativeConfigurationChoices(configuration),
    profile: "personal",
  };
}

export function readNativeAgentConfiguration(agent: string) {
  if (!["openclaw", "hermes"].includes(agent)) fail("the configured agent is invalid");
  const localAppData = requiredDirectory(
    process.env.LOCALAPPDATA ?? "",
    "Windows local application-data directory",
  );
  const stateRoot = path.join(localAppData, "NVIDIA", "NemoClaw", "agents", agent);
  if (readNativeConfigurationRecovery(stateRoot, agent))
    fail(
      "a previous settings save is unfinished. Open NemoClaw Setup, review your choices and save again before launching",
    );
  const configPath = path.join(stateRoot, "native-windows.json");
  if (!fs.statSync(configPath, { throwIfNoEntry: false })?.isFile())
    fail("the graphical onboarding configuration is missing");
  const configText = readOpenedRegularFile(configPath, {
    encoding: "utf8",
    maxBytes: 1024 * 1024,
  });
  if (configText === null) fail("the graphical onboarding configuration disappeared");
  const config = JSON.parse(configText);
  if (
    config?.schemaVersion !== 1 ||
    config?.classification !== "nemoclaw-native-windows-agent-configuration" ||
    config?.agent !== agent ||
    typeof config?.inference !== "string" ||
    !Object.hasOwn(PROVIDER_CONFIGURATION, config.inference) ||
    (typeof config?.endpoint !== "string" && config.localModel === undefined) ||
    typeof config?.model !== "string" ||
    typeof config?.credentialStored !== "boolean"
  )
    fail("the graphical onboarding configuration is incomplete");
  return { config, stateRoot };
}

function writeNativeAgentConfiguration(configuration: NativeOnboardingConfiguration) {
  const localAppData = requiredDirectory(
    process.env.LOCALAPPDATA ?? "",
    "Windows local application-data directory",
  );
  const stateRoot = path.join(localAppData, "NVIDIA", "NemoClaw", "agents", configuration.agent);
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const configPath = path.join(stateRoot, "native-windows.json");
  const temporaryPath = `${configPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const persisted = nativeAgentConfigurationRecord(configuration);
  const activePath = path.join(localAppData, "NVIDIA", "NemoClaw", "active-agent.txt");
  const activeTemporaryPath = `${activePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const previous = readOpenedRegularFile(configPath, { maxBytes: 16 * 1024 });
  let replaced = false;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.writeFileSync(activeTemporaryPath, `${configuration.agent}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, configPath);
    replaced = true;
    fs.renameSync(activeTemporaryPath, activePath);
  } catch (error) {
    if (replaced) {
      if (previous === null) fs.unlinkSync(configPath);
      else {
        fs.writeFileSync(temporaryPath, previous, { flag: "wx", mode: 0o600 });
        fs.renameSync(temporaryPath, configPath);
      }
    }
    throw error;
  } finally {
    fs.rmSync(temporaryPath, { force: true });
    fs.rmSync(activeTemporaryPath, { force: true });
  }
  return configPath;
}

export async function configureNativeFromStdin(
  launcher: string,
  args: readonly string[] = process.argv,
  input: AsyncIterable<Buffer> = process.stdin,
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  dependencies: {
    lookupEndpoint?: NativeEndpointLookup;
    inspectModel?: (
      root: string,
      launcher: string,
      id: string,
    ) => Promise<
      | Awaited<ReturnType<typeof inspectPrebuiltNativeModel>>
      | Awaited<ReturnType<typeof inspectBundledNativeModel>>
    >;
    acquireState?: typeof acquireNativeStateConfiguration;
    inspectState?: typeof acquireNativeStateInspection;
    readCredential?: typeof readWindowsCredential;
    readServices?: typeof readNativeServiceEnvironment;
    deleteCredential?: typeof deleteCredentialByBinding;
    credentialStore?: typeof nativeConfigurationCredentialStore;
    writeConfiguration?: typeof writeNativeAgentConfiguration;
  } = {},
) {
  const settingsPosition = args.indexOf("--read-settings");
  if (settingsPosition !== -1) {
    const agent = args[settingsPosition + 1];
    if (
      !["openclaw", "hermes"].includes(agent) ||
      settingsPosition !== args.length - 2 ||
      args.filter((value) => value === "--read-settings").length !== 1 ||
      args.some(
        (value) =>
          value.startsWith("--") && !["--configure-native", "--read-settings"].includes(value),
      )
    )
      fail("the saved settings request is invalid");
    assertNativePackageIncludesAgent(path.dirname(path.dirname(launcher)), agent);
    const owner = await (dependencies.inspectState ?? acquireNativeStateInspection)(
      launcher,
      agent,
    );
    try {
      owner.assertHeld();
      if (typeof owner.present !== "boolean" || owner.created || owner.removed)
        fail("the saved settings inspection is invalid");
      let settings: Record<string, unknown> | null = null;
      let state = "unconfigured";
      if (owner.present) {
        const directory = path.join(
          requiredDirectory(
            process.env.LOCALAPPDATA ?? "",
            "Windows local application-data directory",
          ),
          "NVIDIA",
          "NemoClaw",
          "agents",
          agent,
        );
        const recovery = readNativeConfigurationRecovery(directory, agent);
        if (recovery) state = "needs-resave";
        else {
          const bytes = readOpenedRegularFile(path.join(directory, "native-windows.json"), {
            maxBytes: 16 * 1024,
            rejectLinks: true,
            rejectHardLinks: true,
          });
          if (bytes !== null) {
            let saved;
            try {
              saved = JSON.parse(
                new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
              );
            } catch {
              fail("the saved settings record is invalid");
            }
            if (
              !saved ||
              typeof saved !== "object" ||
              Array.isArray(saved) ||
              Object.keys(saved).some(
                (key) =>
                  ![
                    "schemaVersion",
                    "classification",
                    "agent",
                    "inference",
                    "endpoint",
                    "model",
                    "credentialStored",
                    "profile",
                    "options",
                    "localModel",
                  ].includes(key),
              ) ||
              saved.schemaVersion !== 1 ||
              saved.classification !== "nemoclaw-native-windows-agent-configuration" ||
              saved.agent !== agent ||
              saved.profile !== "personal" ||
              typeof saved.credentialStored !== "boolean" ||
              (saved.localModel !== undefined
                ? saved.endpoint !== undefined || saved.credentialStored
                : typeof saved.endpoint !== "string")
            )
              fail("the saved settings record is invalid");
            const normalized = normalizeOnboardingConfiguration(
              {
                agent,
                inference: saved.inference,
                options: {
                  endpoint: saved.endpoint,
                  model: saved.model,
                  ...(saved.localModel !== undefined ? { localModel: saved.localModel } : {}),
                },
              },
              false,
              true,
            );
            const options = normalizeNativeOptions(agent, saved.options);
            if (saved.localModel === undefined) nativeCredentialBinding(saved);
            if (
              PROVIDER_CONFIGURATION[normalized.inference].credentialRequired &&
              !saved.credentialStored
            )
              fail("the saved settings record is invalid");
            settings = {
              inference: normalized.inference,
              model: normalized.model,
              credentialStored: saved.credentialStored,
              options,
              ...(normalized.localModel
                ? { localModel: normalized.localModel }
                : { endpoint: normalized.endpoint }),
            };
            state = "saved";
          }
        }
      }
      const response = JSON.stringify({
        schemaVersion: 1,
        kind: "native-saved-settings",
        agent,
        state,
        settings,
      });
      if (Buffer.byteLength(response, "utf8") > 16 * 1024)
        fail("the saved settings response exceeds its limit");
      owner.assertHeld();
      output.write(response);
    } finally {
      await owner.release();
    }
    return;
  }
  const recoveryPosition = args.indexOf("--recovery-status");
  if (recoveryPosition !== -1) {
    const agent = args[recoveryPosition + 1];
    if (
      !["openclaw", "hermes"].includes(agent) ||
      recoveryPosition !== args.length - 2 ||
      args.some((argument) => argument === "--transaction" || argument.startsWith("--prepare"))
    )
      fail("the configuration recovery request is invalid");
    const owner = await (dependencies.acquireState ?? acquireNativeStateConfiguration)(
      launcher,
      agent,
    );
    try {
      owner.assertHeld();
      const directory = path.join(
        requiredDirectory(
          process.env.LOCALAPPDATA ?? "",
          "Windows local application-data directory",
        ),
        "NVIDIA",
        "NemoClaw",
        "agents",
        agent,
      );
      const pending = readNativeConfigurationRecovery(directory, agent);
      owner.assertHeld();
      output.write(
        JSON.stringify({
          schemaVersion: 1,
          kind: "native-configuration-recovery",
          agent,
          state: pending ? "needs-resave" : "clear",
          ...(pending
            ? { operationId: pending.operationId, writerProcessId: pending.writerProcessId }
            : {}),
        }),
      );
    } finally {
      await owner.release();
    }
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const transaction = args.includes("--transaction");
  let payload;
  try {
    for await (const chunk of input) {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > (transaction ? 128 : 16) * 1024)
        fail("native setup configuration exceeds its size limit");
    }
    const serialized = Buffer.concat(chunks);
    try {
      payload = JSON.parse(serialized.toString("utf8"));
    } catch {
      // JSON parser diagnostics can quote the private transaction input.
      fail("native setup configuration is invalid");
    } finally {
      serialized.fill(0);
    }
  } finally {
    chunks.forEach((chunk) => chunk.fill(0));
  }
  const submitted = transaction ? payload?.configuration : payload;
  const credentials = transaction ? payload?.credentials : undefined;
  // Migration and qualification can submit an existing saved record. New UI
  // requests carry choices only; this runtime owns the persisted schema.
  const request = submitted?.kind === "native-setup-request";
  const validEnvelope = request
    ? !["schemaVersion", "classification", "profile"].some((key) => Object.hasOwn(submitted, key))
    : submitted?.kind === undefined &&
      submitted?.schemaVersion === 1 &&
      submitted?.classification === "nemoclaw-native-windows-agent-configuration";
  if (
    transaction &&
    (args.some((arg) => arg.startsWith("--prepare")) ||
      !credentials ||
      typeof credentials !== "object" ||
      Array.isArray(credentials) ||
      Object.keys(credentials).some((key) => !["inference", "services"].includes(key)) ||
      typeof credentials.inference !== "string" ||
      typeof credentials.services !== "object" ||
      Array.isArray(credentials.services))
  )
    fail("native setup credential transaction is invalid");
  if (
    !validEnvelope ||
    typeof submitted?.credentialStored !== "boolean" ||
    (submitted?.localModel === undefined
      ? typeof submitted?.endpoint !== "string"
      : submitted.endpoint !== undefined) ||
    typeof submitted?.model !== "string" ||
    typeof submitted?.inference !== "string" ||
    !Object.hasOwn(PROVIDER_CONFIGURATION, submitted.inference) ||
    submitted?.options === null ||
    typeof submitted?.options !== "object" ||
    Array.isArray(submitted.options) ||
    (submitted.profile !== undefined && submitted.profile !== "personal") ||
    (submitted.localModel !== undefined &&
      (!localModelIdentityMatches(submitted.localModel, submitted.model) ||
        submitted.inference !== "local" ||
        submitted.credentialStored))
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
  // Qualification configures included, not-yet-qualified runtimes through this
  // same entrypoint. Inclusion does not grant launch admission. Reject an absent
  // agent before preparation, model inspection, state acquisition or credentials.
  assertNativePackageIncludesAgent(path.dirname(path.dirname(launcher)), normalized.agent);
  if (transaction) {
    const value = normalizeProviderCredential(normalized.inference, credentials.inference);
    if (value !== credentials.inference || Boolean(value) !== submitted.credentialStored)
      fail("native setup credential does not match the configuration");
    const services = selectedNativeServices(normalized.options);
    if (
      credentials.services !== null &&
      (Object.keys(credentials.services).length !== services.length ||
        services.some((service) => !Object.hasOwn(credentials.services, service)))
    )
      fail("native setup service credentials do not match the configuration");
    for (const service of services) {
      if (credentials.services === null) continue;
      const key = credentials.services[service];
      if (
        typeof key !== "string" ||
        !key ||
        Buffer.byteLength(key, "utf8") > 2048 ||
        /[\u0000\r\n]/u.test(key) ||
        (service === "slack-bot" && !key.startsWith("xoxb-")) ||
        (service === "slack-app" && !key.startsWith("xapp-"))
      )
        fail("native setup service credential is invalid");
    }
  }
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
    ? await (
        dependencies.inspectModel ??
        ((root, owner, id) =>
          isDownloadedLocalModel(id)
            ? inspectBundledNativeModel(root, owner, id)
            : inspectPrebuiltNativeModel(root, owner))
      )(path.dirname(path.dirname(launcher)), launcher, normalized.localModel)
    : undefined;
  const binding = normalized.localModel
    ? null
    : nativeCredentialBinding({
        ...normalized,
        endpoint: normalized.endpoint!,
      });
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
  // DNS admission precedes state or credential mutation. Credential binding
  // itself stays independent of DNS so removal can clean up historical entries.
  if (normalized.endpoint)
    await resolveNativeInferenceAddresses(
      new URL(normalized.endpoint),
      normalized.inference,
      dependencies.lookupEndpoint,
    );
  const state = await (dependencies.acquireState ?? acquireNativeStateConfiguration)(
    launcher,
    normalized.agent,
  );
  try {
    state.assertHeld();
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
    const configurationDirectory = path.dirname(previousPath);
    const activeSelectionPath = path.join(
      path.dirname(path.dirname(configurationDirectory)),
      "active-agent.txt",
    );
    const previousActiveSelection = readOpenedRegularFile(activeSelectionPath, {
      encoding: "utf8",
      maxBytes: 64,
    });
    const pendingRecovery = readNativeConfigurationRecovery(
      configurationDirectory,
      normalized.agent,
    );
    if (pendingRecovery && !transaction)
      fail("an unfinished settings save requires a new complete Setup credential transaction");
    const previousBinding =
      previous?.schemaVersion === 1 &&
      previous?.agent === normalized.agent &&
      previous?.credentialStored === true
        ? nativeCredentialBinding(previous)
        : null;
    const commit = async () => {
      normalized.credential = normalizeProviderCredential(
        normalized.inference,
        normalized.localModel
          ? ""
          : await (dependencies.readCredential ?? readWindowsCredential)(
              launcher,
              { ...normalized, endpoint: normalized.endpoint! },
              submitted.credentialStored,
            ),
      );
      await (dependencies.readServices ?? readNativeServiceEnvironment)(
        launcher,
        normalized.agent,
        normalized.options,
      );
      state.assertHeld();
      return (dependencies.writeConfiguration ?? writeNativeAgentConfiguration)(normalized);
    };
    if (transaction) {
      const changes: CredentialChange[] = [];
      if (binding)
        changes.push({ provider: normalized.inference, binding, value: credentials.inference });
      if (previousBinding && previousBinding !== binding)
        changes.push({ provider: previous.inference, binding: previousBinding, value: "" });
      for (const service of Object.keys(NATIVE_SERVICES)) {
        // The graphical repair UI can retain selected service keys; they are still verified
        // under this lease before configuration is committed.
        if (
          credentials.services === null &&
          selectedNativeServices(normalized.options).some((selected) => selected === service)
        )
          continue;
        changes.push({
          provider: service,
          binding: nativeServiceBinding(normalized.agent, service),
          value: credentials.services?.[service] ?? "",
        });
      }
      for (const identity of pendingRecovery?.identities ?? []) {
        const pendingBinding = nativeCredentialBinding(identity);
        if (!changes.some((change) => change.binding === pendingBinding))
          changes.push({ provider: identity.inference, binding: pendingBinding, value: "" });
      }
      const identities = [
        ...(normalized.endpoint
          ? [
              {
                agent: normalized.agent,
                inference: normalized.inference,
                endpoint: normalized.endpoint,
              },
            ]
          : []),
        ...(previousBinding
          ? [{ agent: previous.agent, inference: previous.inference, endpoint: previous.endpoint }]
          : []),
      ];
      const recovery = beginNativeConfigurationRecovery(
        configurationDirectory,
        normalized.agent,
        identities,
        () => state.assertHeld(),
      );
      try {
        const result = await withNativeCredentialTransaction(
          launcher,
          changes,
          () => state.assertHeld(),
          commit,
          dependencies.credentialStore,
        );
        completeNativeConfigurationRecovery(configurationDirectory, recovery, () =>
          state.assertHeld(),
        );
        return result;
      } catch (error) {
        if (
          error instanceof NativeCredentialTransactionError &&
          error.recoveryComplete &&
          !pendingRecovery &&
          readOpenedRegularFile(previousPath, { encoding: "utf8", maxBytes: 16 * 1024 }) ===
            previousText &&
          readOpenedRegularFile(activeSelectionPath, { encoding: "utf8", maxBytes: 64 }) ===
            previousActiveSelection
        )
          completeNativeConfigurationRecovery(configurationDirectory, recovery, () =>
            state.assertHeld(),
          );
        throw error;
      } finally {
        for (const change of changes) change.value = "";
        credentials.inference = "";
        for (const service of Object.keys(credentials.services ?? {}))
          credentials.services[service] = "";
      }
    }
    const configPath = await commit();
    if (previousBinding && previousBinding !== binding)
      await (dependencies.deleteCredential ?? deleteCredentialByBinding)(
        launcher,
        previous.inference,
        previousBinding,
      );
    const selectedServices = selectedNativeServices(normalized.options);
    for (const service of Object.keys(NATIVE_SERVICES)) {
      if (!selectedServices.some((selected) => selected === service))
        await (dependencies.deleteCredential ?? deleteCredentialByBinding)(
          launcher,
          service,
          nativeServiceBinding(normalized.agent, service),
        );
    }
    state.assertHeld();
    return configPath;
  } finally {
    await state.release();
  }
}
