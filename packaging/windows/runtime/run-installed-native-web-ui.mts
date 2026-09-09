// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { watchNativeUiSandbox, attemptNativeUiCleanup } from "./native-ui-lifecycle.mts";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  NATIVE_SERVICES,
  nativeServiceBinding,
  normalizeNativeOptions,
  readNativeServiceEnvironment,
  selectedNativeServices,
} from "./native-options.mts";

import { openNativeWebSession } from "./native-web-session.mts";
import { removeNativeAgentData } from "./native-remove-data.mts";
import { startNativeInferenceBroker } from "./native-inference-broker.mts";
import { startFileTcpRelay } from "./native-ui-relay.mts";
import { acquireNativeStateSession } from "./native-state.mts";
import { resolveNativeConfiguredInference } from "./native-configured-inference.mts";

import {
  deleteCredentialByBinding,
  nativeCredentialBinding,
  readOpenedRegularFile,
  readWindowsCredential,
  writeNativeGatewayConfig,
} from "./native-security.mts";

import {
  allowlistedWindowsEnvironment,
  argumentValue,
  freePort,
  jsonContainsExactValue,
  quoteYamlPath,
  removeDirectory,
  requiredDirectory,
  requiredFile,
  run,
  sanitizedDiagnostic,
  stopChild,
  waitForPort,
} from "./run-installed-native-turn.mts";

const TURN_PROOFS = [
  ["Reply exactly with NATIVE_WINDOWS_TURN_1_OK", "NATIVE_WINDOWS_TURN_1_OK"],
  ["Reply exactly with NATIVE_WINDOWS_TURN_2_OK", "NATIVE_WINDOWS_TURN_2_OK"],
  ["Reply exactly with NATIVE_WINDOWS_TURN_3_OK", "NATIVE_WINDOWS_TURN_3_OK"],
];

const AGENT_CHOICE_PROOF = ["openclaw", "hermes", "langchain-deepagents-code", "pi", "nemocua"];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const execFileAsync = promisify(execFile);

function fail(message) {
  throw new Error(`NemoClaw native Windows launch failed: ${message}`);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function withTimeout(promise, timeout, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} exceeded its timeout`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

const PROVIDER_CONFIGURATION = {
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

function normalizeProviderCredential(inference, value) {
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

function normalizeOnboardingConfiguration(submitted, qualification, metadataOnly = false) {
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
  const submittedEndpoint = typeof options.endpoint === "string" ? options.endpoint.trim() : "";
  const endpoint = provider.endpoint ?? submittedEndpoint;
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
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

async function updateWindowsCredential(launcher, configuration) {
  const { inference: provider, credential } = configuration;
  const binding = nativeCredentialBinding(configuration);
  const operation = credential ? "--credential-write" : "--credential-delete";
  const result = await new Promise((resolve, reject) => {
    const child = spawn(launcher, [operation, provider, "--binding", binding], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-4096);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(credential, "utf8");
  });
  if (result.code !== 0 || result.stdout)
    throw new Error(
      credential
        ? "Windows Credential Manager could not protect this API key."
        : "Windows Credential Manager could not clear the previous API key.",
    );
}

function writeNativeAgentConfiguration(configuration) {
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

async function configureNativeFromStdin(launcher) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) fail("native setup configuration exceeds its size limit");
    chunks.push(chunk);
  }
  const submitted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    submitted?.schemaVersion !== 1 ||
    submitted?.classification !== "nemoclaw-native-windows-agent-configuration" ||
    typeof submitted?.credentialStored !== "boolean" ||
    typeof submitted?.endpoint !== "string" ||
    typeof submitted?.model !== "string" ||
    !Object.hasOwn(PROVIDER_CONFIGURATION, submitted?.inference) ||
    submitted?.options === null ||
    typeof submitted?.options !== "object" ||
    Array.isArray(submitted.options) ||
    (submitted.profile !== undefined && submitted.profile !== "personal") ||
    (submitted.localModel !== undefined &&
      (submitted.localModel !== "n1x-qwen3.6-35b-a3b" ||
        submitted.inference !== "local" ||
        submitted.credentialStored))
  )
    fail("native setup configuration is invalid");
  const normalized = normalizeOnboardingConfiguration(
    {
      agent: submitted.agent,
      inference: submitted.inference,
      options: { endpoint: submitted.endpoint, model: submitted.model },
    },
    false,
    true,
  );
  normalized.options = normalizeNativeOptions(submitted.agent, submitted.options);
  if (submitted.localModel) normalized.localModel = submitted.localModel;
  const servicePosition = process.argv.indexOf("--prepare-service");
  if (servicePosition !== -1) {
    const service = process.argv[servicePosition + 1];
    if (!selectedNativeServices(normalized.options).includes(service))
      fail("the service is not selected for this agent");
    process.stdout.write(nativeServiceBinding(submitted.agent, service ?? ""));
    return;
  }
  if (
    PROVIDER_CONFIGURATION[normalized.inference].credentialRequired &&
    !submitted.credentialStored
  )
    fail("the selected provider requires a credential");
  const binding = nativeCredentialBinding(normalized);
  if (process.argv.includes("--prepare")) {
    process.stdout.write(binding);
    return;
  }
  const credential = await readWindowsCredential(launcher, normalized, submitted.credentialStored);
  normalized.credential = normalizeProviderCredential(normalized.inference, credential);
  await readNativeServiceEnvironment(launcher, normalized.agent, normalized.options);
  const previousPath = path.join(
    process.env.LOCALAPPDATA,
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
    if (!selectedServices.includes(service))
      await deleteCredentialByBinding(
        launcher,
        service,
        nativeServiceBinding(normalized.agent, service),
      );
  }
}

function readNativeAgentConfiguration(agent) {
  const localAppData = requiredDirectory(
    process.env.LOCALAPPDATA ?? "",
    "Windows local application-data directory",
  );
  const stateRoot = path.join(localAppData, "NVIDIA", "NemoClaw", "agents", agent);
  const configPath = requiredFile(
    path.join(stateRoot, "native-windows.json"),
    `${agentNamesForLaunch[agent]} configuration`,
  );
  const configText = readOpenedRegularFile(configPath, { encoding: "utf8", maxBytes: 1024 * 1024 });
  if (configText === null) fail("graphical onboarding configuration disappeared");
  const config = JSON.parse(configText);
  if (
    config?.schemaVersion !== 1 ||
    config?.classification !== "nemoclaw-native-windows-agent-configuration" ||
    config?.agent !== agent ||
    !["nvidia", "openrouter", "compatible", "local"].includes(config?.inference) ||
    typeof config?.endpoint !== "string" ||
    typeof config?.model !== "string" ||
    typeof config?.credentialStored !== "boolean"
  )
    fail(`${agentNamesForLaunch[agent]} graphical configuration is incomplete`);
  return { config, stateRoot };
}

function gatewaySource() {
  return String.raw`import fs, { mkdirSync, writeFileSync } from "node:fs";
import { startNativeUiTunnel } from "./native-ui-tunnel.mts";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const launcher = required("NEMOCLAW_MXC_OPENCLAW_ENTRY");
const home = required("NEMOCLAW_MXC_HOME");
const modelPort = Number(required("NEMOCLAW_MXC_MODEL_PORT"));
const modelId = required("NEMOCLAW_MXC_MODEL_ID");
const modelToken = required("NEMOCLAW_MXC_MODEL_TOKEN");
const qualification = required("NEMOCLAW_MXC_QUALIFICATION") === "1";
const relayRoot = required("NEMOCLAW_MXC_RELAY_ROOT");
const relayToken = required("NEMOCLAW_MXC_RELAY_TOKEN");
const uiPort = Number(required("NEMOCLAW_MXC_UI_PORT"));
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
const contentText = (value) => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "string" ? part : part?.text ?? "").join(" ");
};
const responseFor = (body) => {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let text = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    text = contentText(messages[index]?.content);
    break;
  }
  const turn = text.match(/NATIVE_WINDOWS_TURN_([123])_OK/u)?.[1];
  return turn ? "NATIVE_WINDOWS_TURN_" + turn + "_OK" : "NEMOCLAW_NATIVE_PREVIEW_OK";
};
const mock = qualification ? createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "native-preview", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  const body = JSON.parse(await readBody(request));
  if (request.headers.authorization !== "Bearer " + modelToken || body?.model !== modelId || !Array.isArray(body?.messages)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected request" } }));
    return;
  }
  const content = responseFor(body);
  const id = "chatcmpl-nemoclaw-native-ui";
  const created = Math.floor(Date.now() / 1000);
  if (body.stream === true) {
    response.writeHead(200, { "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream" });
    for (const value of [
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: { content }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "native-preview", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) response.write("data: " + JSON.stringify(value) + "\n\n");
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: "native-preview",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  }));
}) : null;
if (mock !== null) await new Promise((resolve, reject) => {
  mock.once("error", reject);
  mock.listen(modelPort, "127.0.0.1", resolve);
});
const configDirectory = join(home, ".openclaw");
mkdirSync(configDirectory, { recursive: true });
const agentDirectory = join(configDirectory, "agents", "main", "agent");
mkdirSync(agentDirectory, { recursive: true });
const canonicalAgentDirectory = resolve(agentDirectory);
const canUseAgentDirectoryFallback = (target, error) => {
  if (error?.code !== "EPERM" || typeof target !== "string") return false;
  if (resolve(target).toLowerCase() !== canonicalAgentDirectory.toLowerCase()) return false;
  const entry = fs.lstatSync(canonicalAgentDirectory);
  return entry.isDirectory() && !entry.isSymbolicLink();
};
const encodedAgentDirectory = (options) =>
  options === "buffer" || options?.encoding === "buffer"
    ? Buffer.from(canonicalAgentDirectory)
    : canonicalAgentDirectory;
const originalPromiseRealpath = fs.promises.realpath.bind(fs.promises);
fs.promises.realpath = async (target, options) => {
  try {
    return await originalPromiseRealpath(target, options);
  } catch (error) {
    if (!canUseAgentDirectoryFallback(target, error)) throw error;
    return encodedAgentDirectory(options);
  }
};
const originalRealpath = fs.realpath.bind(fs);
const patchedRealpath = (target, options, callback) => {
  const resolvedCallback = typeof options === "function" ? options : callback;
  const resolvedOptions = typeof options === "function" ? undefined : options;
  return originalRealpath(target, resolvedOptions, (error, value) => {
    if (error && canUseAgentDirectoryFallback(target, error)) {
      resolvedCallback(null, encodedAgentDirectory(resolvedOptions));
      return;
    }
    resolvedCallback(error, value);
  });
};
const originalRealpathSync = fs.realpathSync.bind(fs);
const originalNativeRealpathSync = fs.realpathSync.native.bind(fs.realpathSync);
const patchedRealpathSync = (target, options) => {
  try {
    return originalRealpathSync(target, options);
  } catch (error) {
    if (!canUseAgentDirectoryFallback(target, error)) throw error;
    return encodedAgentDirectory(options);
  }
};
patchedRealpathSync.native = (target, options) => {
  try {
    return originalNativeRealpathSync(target, options);
  } catch (error) {
    if (!canUseAgentDirectoryFallback(target, error)) throw error;
    return encodedAgentDirectory(options);
  }
};
patchedRealpath.native = patchedRealpath;
fs.realpath = patchedRealpath;
fs.realpathSync = patchedRealpathSync;
syncBuiltinESMExports();
let serviceConfiguration = {};
if (process.env.NEMOCLAW_NATIVE_SERVICES === "1") {
  const response = await fetch("http://127.0.0.1:" + modelPort + "/native/bootstrap", {
    method: "POST", headers: { authorization: "Bearer " + modelToken }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("NemoClaw could not supply the selected optional services.");
  const services = await response.json();
  Object.assign(process.env, services.environment);
  serviceConfiguration = services.openclaw;
  if (services.options.search?.provider === "brave") {
    serviceConfiguration.plugins.load = { paths: [required("NEMOCLAW_NATIVE_BRAVE_PLUGIN")] };
  }
}
writeFileSync(join(configDirectory, "openclaw.json"), JSON.stringify({
  ...serviceConfiguration,
  gateway: {
    mode: "local",
    bind: "loopback",
    auth: { mode: "none" },
    controlUi: { allowedOrigins: ["http://127.0.0.1:" + uiPort, "http://localhost:" + uiPort] },
  },
  models: { mode: "merge", providers: { nemoclawNative: {
    baseUrl: "http://127.0.0.1:" + modelPort + "/v1",
    apiKey: modelToken,
    api: "openai-completions",
    timeoutSeconds: 180,
    models: [{ id: modelId, name: modelId, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }],
  } } },
  agents: { defaults: { model: { primary: "nemoclawNative/" + modelId }, timeoutSeconds: 180, skipBootstrap: true, thinkingDefault: "off" }, list: [{ id: "main", default: true }] },
}), "utf8");
Object.assign(process.env, {
  HOME: home,
  NODE_DISABLE_COMPILE_CACHE: "1",
  OPENCLAW_HOME: home,
  OPENCLAW_NO_RESPAWN: "1",
  USERPROFILE: home,
});
process.argv = [process.execPath, launcher, "gateway", "run", "--allow-unconfigured", "--port", String(uiPort), "--bind", "loopback", "--auth", "none"];
const fileTunnelTask = startNativeUiTunnel({ relayRoot, relayToken, uiPort });
void fileTunnelTask.catch(() => {});
await import(pathToFileURL(launcher).href);
await fileTunnelTask;
`;
}

function resolveEdge() {
  const systemDrive = process.env.SystemDrive;
  const driveRoots =
    systemDrive && /^[A-Za-z]:$/u.test(systemDrive)
      ? [
          path.join(`${systemDrive}\\`, "Program Files (x86)"),
          path.join(`${systemDrive}\\`, "Program Files"),
        ]
      : [];
  const candidates = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
    ...driveRoots,
  ]
    .filter(Boolean)
    .map((root) => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
  for (const candidate of candidates) {
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  fail("Microsoft Edge is required for the visible Control UI proof");
}

async function startOnboardingServer(
  installRoot,
  openClawUrl,
  evidenceRoot,
  qualification,
  launcher,
) {
  const onboardingRoot = requiredDirectory(
    path.join(installRoot, "onboarding"),
    "NemoClaw graphical onboarder",
  );
  const files = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/app.ts", ["app.ts", "text/javascript; charset=utf-8"]],
    ["/assets/nvidia.svg", ["assets/nvidia.svg", "image/svg+xml"]],
    ["/assets/openclaw.png", ["assets/openclaw.png", "image/png"]],
    ["/assets/hermes.png", ["assets/hermes.png", "image/png"]],
    ["/assets/deepagents.png", ["assets/deepagents.png", "image/png"]],
    ["/assets/pi.svg", ["assets/pi.svg", "image/svg+xml"]],
    ["/assets/nemocua.png", ["assets/nemocua.png", "image/png"]],
  ]);
  let selection = null;
  let runtimeConfiguration = null;
  const sessionToken = randomBytes(32).toString("base64url");
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method === "POST" && pathname === "/api/configure") {
        if (request.headers["x-nemoclaw-session"] !== sessionToken)
          throw new Error("The onboarding session token is invalid.");
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 64 * 1024) throw new Error("onboarding request is too large");
          chunks.push(chunk);
        }
        const submitted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const normalized = normalizeOnboardingConfiguration(submitted, qualification);
        if (!qualification) {
          await updateWindowsCredential(launcher, normalized);
        }
        const configPath = qualification ? null : writeNativeAgentConfiguration(normalized);
        selection = {
          schemaVersion: 1,
          agent: normalized.agent,
          inference: normalized.inference,
          endpoint: qualification ? "deterministic-loopback" : normalized.endpoint,
          model: normalized.model,
          credentialStorage: qualification
            ? "none"
            : normalized.credential
              ? "Windows Credential Manager"
              : "not required",
          options: Object.fromEntries(
            Object.entries(normalized.options).filter(
              ([name]) => !["credential", "endpoint", "model"].includes(name),
            ),
          ),
        };
        runtimeConfiguration = {
          agent: normalized.agent,
          inference: normalized.inference,
          endpoint: normalized.endpoint,
          model: normalized.model,
          credentialStored: !qualification && Boolean(normalized.credential),
          configPath,
        };
        fs.writeFileSync(
          path.join(evidenceRoot, "onboarding-selection.json"),
          `${JSON.stringify(selection, null, 2)}\n`,
          "utf8",
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            redirect:
              qualification && submitted.agent === "openclaw" && openClawUrl
                ? `${openClawUrl}/chat`
                : `/launching.html?agent=${encodeURIComponent(submitted.agent)}`,
          }),
        );
        return;
      }
      if (request.method === "GET" && pathname === "/launching.html") {
        const agent = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("agent");
        const displayName = agentNamesForLaunch[agent] ?? "selected agent";
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
          "content-type": "text/html; charset=utf-8",
        });
        response.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>NemoClaw Native Windows · ${displayName}</title><style>:root{font-family:"Segoe UI",system-ui;color:#202020;background:#f1f2ef}body{min-height:100vh;margin:0;display:grid;place-items:center}.card{width:650px;padding:52px;background:white;border:1px solid #ddd;border-radius:16px;box-shadow:0 24px 70px #0001}.mark{width:18px;height:18px;background:#76b900;border-radius:4px}h1{font-size:34px;letter-spacing:-.03em;margin:22px 0 10px}p{color:#666;line-height:1.6}.status{margin-top:26px;padding:16px;background:#f0f7e4;border-left:4px solid #76b900;color:#3f5f12;font-weight:600}</style></head><body><main class="card"><div class="mark"></div><h1>Starting ${displayName}</h1><p>NemoClaw is creating a native OpenShell/MXC sandbox and opening the agent's authentic Windows surface.</p><div class="status">Native ARM64 · no WSL · no Docker</div></main></body></html>`,
        );
        return;
      }
      const file = files.get(pathname);
      if (request.method !== "GET" || !file) {
        response.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("Not found");
        return;
      }
      const [relative, contentType] = file;
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'",
        "content-type": contentType,
        "x-content-type-options": "nosniff",
      });
      const content = readOpenedRegularFile(
        requiredFile(path.join(onboardingRoot, relative), relative),
        {
          maxBytes: 2 * 1024 * 1024,
        },
      );
      if (content === null) fail("the onboarding asset disappeared");
      response.end(content);
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          message: error instanceof Error ? error.message : "Invalid request",
        }),
      );
    }
  });
  const port = await freePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${port}`;
  return {
    server,
    origin,
    url: `${origin}?session=${sessionToken}`,
    selection: () => selection,
    runtimeConfiguration: () => runtimeConfiguration,
  };
}

const agentNamesForLaunch = {
  openclaw: "OpenClaw",
  hermes: "Hermes Agent",
  "langchain-deepagents-code": "Deep Agents Code",
  pi: "Pi",
  nemocua: "NemoCUA",
};

async function driveBrowser(
  openClawRoot,
  onboardingUrl,
  openClawUrl,
  evidenceRoot,
  qualification,
  targetAgent = "openclaw",
  skipOnboarding = false,
) {
  const playwrightRoot = requiredDirectory(
    path.join(openClawRoot, "node_modules", "openclaw", "node_modules", "playwright-core"),
    "installed Playwright browser driver",
  );
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightRoot);
  const browser = await chromium.launch({
    executablePath: resolveEdge(),
    headless: false,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--window-position=20,10",
      "--window-size=1440,810",
    ],
  });
  let browserVersion;
  try {
    browserVersion = browser.version();
    const context = await browser.newContext({
      viewport: { width: 1400, height: 730 },
    });
    const page = await context.newPage();
    const demonstratedAgentChoices = [];
    const disabledAgentChoices = [];
    if (skipOnboarding) {
      await page.goto(`${openClawUrl}/chat`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    } else {
      const onboardingPageUrl = new URL(onboardingUrl);
      const onboardingOrigin = onboardingPageUrl.origin;
      onboardingPageUrl.searchParams.set("agent", targetAgent);
      if (qualification) onboardingPageUrl.searchParams.set("qualification", "1");
      await page.goto(onboardingPageUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      await page.locator("[data-agent='openclaw']").waitFor({
        state: "visible",
        timeout: 30_000,
      });
      if (!qualification) {
        await page.screenshot({
          path: path.join(evidenceRoot, "onboarding-agent.png"),
        });
        console.log(`WEB UI> READY ${onboardingOrigin}`);
        await page.waitForURL(`${onboardingOrigin}/launching.html?agent=*`, {
          timeout: 30 * 60_000,
        });
        return {
          browserVersion,
          demonstratedAgentChoices: [],
          disabledAgentChoices: [],
          turns: [],
        };
      }
      console.log("WEB UI> Showing every real native agent choice");
      await sleep(3000);
      for (const agent of AGENT_CHOICE_PROOF) {
        const card = page.locator(`[data-agent='${agent}']`);
        if (await card.isDisabled()) fail(`native agent ${agent} is not selectable`);
        await card.click();
        if ((await card.getAttribute("aria-checked")) !== "true")
          fail(`graphical onboarding did not select ${agent}`);
        demonstratedAgentChoices.push(agent);
        console.log(`WEB UI> AGENT CHOICE selected ${agent}`);
        await sleep(1500);
      }
      await page.locator(`[data-agent='${targetAgent}']`).click();
      await page.screenshot({
        path: path.join(evidenceRoot, "onboarding-agent.png"),
        fullPage: false,
      });
      await sleep(2500);
      await page.locator("#next").click();
      await sleep(3000);
      await page.screenshot({
        path: path.join(evidenceRoot, "onboarding-inference.png"),
      });
      await page.locator("#next").click();
      await sleep(3000);
      await page.screenshot({
        path: path.join(evidenceRoot, "onboarding-experience.png"),
      });
      await page.locator("#next").click();
      await sleep(3000);
      await page.screenshot({
        path: path.join(evidenceRoot, "onboarding-review.png"),
      });
      await sleep(2500);
      await page.locator("#launch").click();
      if (targetAgent !== "openclaw" || !openClawUrl) {
        await page.waitForURL(`${onboardingOrigin}/launching.html?agent=${targetAgent}`, {
          timeout: 30_000,
        });
        if (targetAgent !== "openclaw") {
          await page.screenshot({
            path: path.join(evidenceRoot, `onboarding-${targetAgent}-launching.png`),
            fullPage: false,
          });
        }
        await sleep(3000);
        return { browserVersion, demonstratedAgentChoices, disabledAgentChoices, turns: [] };
      }
    }
    await page.waitForURL(`${openClawUrl}/chat`, { timeout: 30_000 });
    const composer = page.locator(".agent-chat__composer-combobox > textarea").first();
    await composer.waitFor({ state: "visible", timeout: 90_000 });
    await page.waitForFunction(
      () => {
        const input = document.querySelector(".agent-chat__composer-combobox > textarea");
        return input instanceof HTMLTextAreaElement && !input.disabled;
      },
      undefined,
      { timeout: 90_000 },
    );
    await page.evaluate(() => {
      document.title = "NemoClaw Native Windows · OpenClaw Control UI";
    });
    await page.screenshot({
      path: path.join(evidenceRoot, "web-ui-ready.png"),
    });
    const turns = [];
    for (let index = 0; index < TURN_PROOFS.length; index += 1) {
      const [prompt, expected] = TURN_PROOFS[index];
      console.log(`WEB UI> TURN ${index + 1} typing in the real OpenClaw Control UI`);
      await composer.fill("");
      await composer.pressSequentially(prompt, { delay: 20 });
      await sleep(750);
      await composer.press("Enter");
      await page.getByText(expected, { exact: true }).last().waitFor({
        state: "visible",
        timeout: 120_000,
      });
      await page.screenshot({
        path: path.join(evidenceRoot, `web-ui-turn-${index + 1}.png`),
        fullPage: false,
      });
      console.log(`WEB UI> TURN ${index + 1} PASS ${expected}`);
      turns.push({ prompt, expected, visible: true });
      await sleep(2000);
    }
    await sleep(3000);
    return { browserVersion, demonstratedAgentChoices, disabledAgentChoices, turns };
  } finally {
    if (browser.isConnected()) await browser.close();
  }
}

async function runInitialOnboarding(
  installRoot,
  installedOpenClawRoot,
  initialAgent,
  evidenceRoot,
) {
  const launcher = requiredFile(path.join(installRoot, "bin", "NemoClaw.exe"), "NemoClaw launcher");
  const onboarding = await startOnboardingServer(installRoot, "", evidenceRoot, false, launcher);
  try {
    console.log(`WEB UI> Launching graphical onboarding for ${agentNamesForLaunch[initialAgent]}`);
    await driveBrowser(
      installedOpenClawRoot,
      onboarding.url,
      "",
      evidenceRoot,
      false,
      initialAgent,
    );
  } finally {
    await new Promise((resolve) => onboarding.server.close(() => resolve()));
  }
  const selection = onboarding.selection();
  const runtimeConfiguration = onboarding.runtimeConfiguration();
  if (
    !Object.hasOwn(agentNamesForLaunch, selection?.agent) ||
    runtimeConfiguration?.agent !== selection.agent ||
    typeof runtimeConfiguration.configPath !== "string"
  )
    fail("graphical onboarding did not publish a complete agent configuration");
  if (selection.options.launch !== "on") {
    console.log(`WEB UI> Saved ${agentNamesForLaunch[selection.agent]} configuration for later`);
    return;
  }
  const arguments_ = ["--configured", "--agent", selection.agent];
  arguments_.unshift("--console");
  const child = spawn(launcher, arguments_, {
    cwd: installRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.once("error", (error) => {
    console.error(
      `WEB UI> ${agentNamesForLaunch[selection.agent]} launch failed: ${error.message}`,
    );
  });
  child.unref();
  console.log(`WEB UI> Opened the authentic ${agentNamesForLaunch[selection.agent]} surface`);
}

async function runSelectedNonOpenClaw(
  installRoot,
  installedNode,
  installedOpenClawRoot,
  targetAgent,
  qualification,
  evidenceRoot,
) {
  const launcher = requiredFile(path.join(installRoot, "bin", "NemoClaw.exe"), "NemoClaw launcher");
  const onboarding = await startOnboardingServer(
    installRoot,
    "",
    evidenceRoot,
    qualification,
    launcher,
  );
  let browserProof;
  try {
    console.log(`WEB UI> Launching graphical onboarding for ${agentNamesForLaunch[targetAgent]}`);
    browserProof = await driveBrowser(
      installedOpenClawRoot,
      onboarding.url,
      "",
      evidenceRoot,
      qualification,
      targetAgent,
    );
  } finally {
    await new Promise((resolve) => onboarding.server.close(() => resolve()));
  }
  const onboardingSelection = onboarding.selection();
  if (onboardingSelection?.agent !== targetAgent)
    fail(`graphical onboarding did not select ${targetAgent}`);
  if (!qualification) fail("the non-OpenClaw runtime bypassed its configured adapter");

  const runtimeEvidence = path.join(evidenceRoot, "runtime");
  fs.mkdirSync(runtimeEvidence, { recursive: true });
  const isNemoCua = targetAgent === "nemocua";
  const runner = requiredFile(
    path.join(
      installRoot,
      "qualification",
      isNemoCua ? "run-installed-native-nemocua.mts" : "run-installed-native-pi.mts",
    ),
    `${agentNamesForLaunch[targetAgent]} native adapter`,
  );
  const arguments_ = [
    "--experimental-strip-types",
    "--no-warnings",
    runner,
    "--qualification",
    "--artifact-directory",
    runtimeEvidence,
  ];
  if (!isNemoCua) arguments_.push("--agent", targetAgent);
  const environment = allowlistedWindowsEnvironment({
    NEMOCLAW_NATIVE_INSTALL_ROOT: installRoot,
  });
  console.log(
    `WEB UI> Handing off to the authentic ${agentNamesForLaunch[targetAgent]} native surface`,
  );
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(installedNode, arguments_, {
      cwd: installRoot,
      env: environment,
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) fail(`${agentNamesForLaunch[targetAgent]} native adapter exited ${exitCode}`);
  const receiptPrefixes = {
    hermes: "native-windows-hermes-",
    "langchain-deepagents-code": "native-windows-langchain-deepagents-code-",
    pi: "native-windows-pi-",
    nemocua: "native-windows-nemocua-",
  };
  const runtimeReceipts = fs
    .readdirSync(runtimeEvidence)
    .filter(
      (name) =>
        name.startsWith(receiptPrefixes[targetAgent]) &&
        name.endsWith(".json") &&
        fs.statSync(path.join(runtimeEvidence, name)).isFile(),
    );
  if (runtimeReceipts.length !== 1)
    fail(`${agentNamesForLaunch[targetAgent]} did not publish exactly one runtime receipt`);
  const runtimeReceiptText = readOpenedRegularFile(path.join(runtimeEvidence, runtimeReceipts[0]), {
    encoding: "utf8",
    maxBytes: 1024 * 1024,
  });
  if (runtimeReceiptText === null) fail("the configured agent runtime receipt disappeared");
  const runtimeReceipt = JSON.parse(runtimeReceiptText);
  if (runtimeReceipt.verdict !== "pass" || runtimeReceipt.turnCount !== 3)
    fail(`${agentNamesForLaunch[targetAgent]} runtime receipt is incomplete`);
  const receipt = {
    schemaVersion: 1,
    classification: "installed-nemoclaw-native-windows-graphical-agent-launch",
    architecture: "arm64",
    selectedAgent: targetAgent,
    onboardingSelection,
    demonstratedAgentChoices: browserProof.demonstratedAgentChoices,
    disabledAgentChoices: browserProof.disabledAgentChoices,
    browser: "Microsoft Edge",
    browserVersion: browserProof.browserVersion,
    runtimeReceipt,
    turnCount: runtimeReceipt.turnCount,
    verdict: "pass",
  };
  fs.writeFileSync(
    path.join(evidenceRoot, `native-windows-agent-launch-${targetAgent}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `WEB UI> PASS graphical onboarding and three ${agentNamesForLaunch[targetAgent]} turns`,
  );
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "arm64")
    fail("native Windows ARM64 is required");
  const qualification = process.argv.includes("--qualification");
  const configured = process.argv.includes("--configured");
  const targetAgent = argumentValue("--agent") ?? "openclaw";
  const skipOnboarding = process.argv.includes("--skip-onboarding");
  if (skipOnboarding && (!qualification || targetAgent !== "openclaw"))
    fail("skipping onboarding is limited to OpenClaw qualification");
  if (!Object.hasOwn(agentNamesForLaunch, targetAgent)) fail(`unknown agent ${targetAgent}`);
  const installRoot = requiredDirectory(
    process.env.NEMOCLAW_NATIVE_INSTALL_ROOT ?? "",
    "NemoClaw installation root",
  );
  const binRoot = requiredDirectory(path.join(installRoot, "bin"), "NemoClaw bin directory");
  if (process.argv.includes("--remove-native-data")) {
    const launcher = requiredFile(
      path.join(installRoot, "bin", "NemoClaw.exe"),
      "NemoClaw launcher",
    );
    await removeNativeAgentData(launcher, argumentValue("--agent") ?? "");
    return;
  }
  if (process.argv.includes("--configure-native")) {
    const launcher = requiredFile(path.join(binRoot, "NemoClaw.exe"), "NemoClaw launcher");
    await configureNativeFromStdin(launcher);
    return;
  }
  const installedNode = requiredFile(path.join(binRoot, "node.exe"), "Node.js runtime");
  const openshell = requiredFile(path.join(binRoot, "openshell.exe"), "OpenShell CLI");
  const gatewayExecutable = requiredFile(
    path.join(binRoot, "openshell-gateway.exe"),
    "OpenShell gateway",
  );
  const installedOpenClawRoot = requiredDirectory(
    path.join(installRoot, "openclaw"),
    "OpenClaw runtime",
  );
  const installedOpenClawEntry = requiredFile(
    path.join(installedOpenClawRoot, "node_modules", "openclaw", "openclaw.mjs"),
    "OpenClaw entrypoint",
  );
  requiredFile(path.join(installRoot, "config", "mxc-gateway.toml"), "MXC gateway configuration");
  requiredFile(path.join(installRoot, "mxc", "wxc-exec.exe"), "MXC executor");

  const selectedEvidenceRoot = path.resolve(
    argumentValue("--artifact-directory") ??
      path.join(
        process.env.LOCALAPPDATA ?? installRoot,
        "NVIDIA",
        "NemoClaw",
        "evidence",
        targetAgent,
      ),
  );
  fs.mkdirSync(selectedEvidenceRoot, { recursive: true });
  if (!qualification && !configured) {
    await runInitialOnboarding(
      installRoot,
      installedOpenClawRoot,
      targetAgent,
      selectedEvidenceRoot,
    );
    return;
  }
  if (targetAgent !== "openclaw") {
    await runSelectedNonOpenClaw(
      installRoot,
      installedNode,
      installedOpenClawRoot,
      targetAgent,
      qualification,
      selectedEvidenceRoot,
    );
    return;
  }

  const launcherPath = requiredFile(path.join(binRoot, "NemoClaw.exe"), "NemoClaw launcher");
  const webSession = configured ? await openNativeWebSession(installRoot, "openclaw") : null;
  let interfacePassed = false;
  let interfaceError;
  try {
    webSession?.progress("inference");
    const configuredIdentity = configured ? readNativeAgentConfiguration("openclaw") : null;
    const resolvedInference = configuredIdentity
      ? await resolveNativeConfiguredInference(
          installRoot,
          launcherPath,
          configuredIdentity.config,
          { signal: webSession?.signal },
        )
      : null;
    if (configuredIdentity) configuredIdentity.config = resolvedInference.configuration;
    const modelId = configuredIdentity?.config.model ?? "native-preview";
    const modelToken = randomBytes(32).toString("base64url");
    const credential = resolvedInference?.credential ?? "";
    webSession?.assertRunning();
    webSession?.progress("runtime");
    const stateSession = configuredIdentity
      ? await acquireNativeStateSession(launcherPath, "openclaw")
      : null;
    const ownedRoots = [];
    const ownedLogs = [];
    let inferenceBroker = null;
    let uiRelay = null;
    let gateway = null;
    let create = null;
    let onboarding = null;
    let cliEnvironment;
    let sandboxName = "";
    let runRoot = "",
      shareRoot = "",
      runtimeRoot = "",
      relayToken = "";
    let gatewayLogPath = "",
      gatewayErrorPath = "";
    let createOutput = "",
      createError = "";
    let primaryError;
    let cleanupPromise;
    let monitor;
    const monitoring = new AbortController();
    const evidenceRoot = selectedEvidenceRoot;
    const runId = randomBytes(5).toString("hex");
    const cleanup = () =>
      (cleanupPromise ??= attemptNativeUiCleanup([
        [
          "backend monitoring",
          async () => {
            monitoring.abort();
            if (monitor) await monitor.catch(() => {});
          },
        ],
        [
          "UI relay shutdown",
          async () => {
            if (uiRelay) await uiRelay.close();
          },
        ],
        [
          "onboarding server",
          async () => {
            if (!onboarding) return;
            const closed = new Promise((resolve) => onboarding.server.close(resolve));
            onboarding.server.closeAllConnections();
            await withTimeout(closed, 5000, "Onboarding shutdown");
          },
        ],
        [
          "sandbox deletion",
          async () => {
            if (create)
              await run(
                openshell,
                ["sandbox", "delete", sandboxName],
                cliEnvironment,
                "Deleting the native Control UI sandbox",
                30_000,
              );
          },
        ],
        [
          "sandbox request watcher",
          async () => {
            if (create && create.pid && !(await stopChild(create))) throw new Error();
          },
        ],
        [
          "sandbox registry",
          async () => {
            if (!create) return;
            const listed = await execFileAsync(openshell, ["sandbox", "list", "-o", "json"], {
              env: cliEnvironment,
              encoding: "utf8",
              windowsHide: true,
              timeout: 10_000,
              maxBuffer: 1024 * 1024,
            });
            if (jsonContainsExactValue(JSON.parse(listed.stdout), sandboxName)) throw new Error();
          },
        ],
        [
          "OpenShell gateway",
          async () => {
            if (gateway && gateway.pid && !(await stopChild(gateway))) throw new Error();
          },
        ],
        [
          "UI file owner",
          async () => {
            if (uiRelay) await uiRelay.dispose();
          },
        ],
        [
          "gateway logs",
          async () => {
            let failed = false;
            for (const descriptor of ownedLogs) {
              try {
                fs.closeSync(descriptor);
              } catch {
                failed = true;
              }
            }
            if (failed) throw new Error();
          },
        ],
        [
          "failure diagnostics",
          async () => {
            if (!primaryError) return;
            const parts = [createOutput, createError];
            for (const file of [gatewayLogPath, gatewayErrorPath].filter(Boolean)) {
              const text = readOpenedRegularFile(file, {
                encoding: "utf8",
                maxBytes: 2 * 1024 * 1024,
              });
              if (text) parts.push(text);
            }
            if (!parts.some(Boolean)) return;
            const diagnostic = sanitizedDiagnostic(
              parts.join("\n"),
              [
                [modelToken, "<model-token>"],
                [relayToken, "<relay-token>"],
                [installRoot, "<install-root>"],
                [runtimeRoot, "<runtime-root>"],
                [shareRoot, "<share-root>"],
                [runRoot, "<run-root>"],
              ].filter(([value]) => value),
            );
            fs.writeFileSync(
              path.join(evidenceRoot, `native-windows-web-ui-diagnostic-${runId}.log`),
              diagnostic,
              "utf8",
            );
            console.error(
              "WEB UI> Failure diagnostics were saved with session identities removed.",
            );
          },
        ],
        [
          "temporary runtime directories",
          async () => {
            let failed = false;
            for (const directory of ownedRoots) {
              try {
                if (!(await removeDirectory(directory))) failed = true;
              } catch {
                failed = true;
              }
            }
            if (failed) throw new Error();
          },
        ],
        [
          "inference broker",
          async () => {
            if (!inferenceBroker) return;
            const closed = new Promise((resolve) => inferenceBroker.server.close(resolve));
            inferenceBroker.server.closeAllConnections();
            await withTimeout(closed, 5000, "Inference broker shutdown");
          },
        ],
        [
          "private agent state",
          async () => {
            if (stateSession) await stateSession.release();
          },
        ],
      ]));
    try {
      inferenceBroker = configuredIdentity
        ? await startNativeInferenceBroker(
            configuredIdentity.config,
            credential,
            modelToken,
            await readNativeServiceEnvironment(
              launcherPath,
              "openclaw",
              configuredIdentity.config.options,
            ),
          )
        : null;

      const systemDrive = process.env.SystemDrive;
      if (!systemDrive || !/^[A-Za-z]:$/u.test(systemDrive)) fail("SystemDrive is invalid");
      const systemRoot = requiredDirectory(process.env.SystemRoot ?? "", "Windows system root");
      runRoot = path.join(`${systemDrive}\\`, `NemoClawNativeUi-${runId}`);
      shareRoot = path.join(`${systemDrive}\\`, `NemoClawNativeUiShare-${runId}`);
      runtimeRoot = path.join(`${systemDrive}\\`, `NemoClawNativeUiRuntime-${runId}`);
      for (const directory of [runRoot, shareRoot, runtimeRoot]) {
        if (fs.existsSync(directory)) fail("qualification root already exists");
        fs.mkdirSync(directory);
        ownedRoots.push(directory);
      }
      const gatewayConfig = writeNativeGatewayConfig(installRoot, runRoot);
      relayToken = randomBytes(32).toString("base64url");
      const relayRoot = path.join(shareRoot, "ui-relay");
      uiRelay = await startFileTcpRelay(relayRoot, relayToken, launcherPath);
      const node = path.join(runtimeRoot, "node.exe");
      const openClawRoot = path.join(runtimeRoot, "openclaw");
      console.log("WEB UI> Staging the exact installed OpenClaw runtime for MXC");
      fs.copyFileSync(installedNode, node);
      fs.cpSync(installedOpenClawRoot, openClawRoot, { recursive: true });
      const openClawEntry = requiredFile(
        path.join(openClawRoot, "node_modules", "openclaw", "openclaw.mjs"),
        "staged OpenClaw entrypoint",
      );
      if (!fs.readFileSync(openClawEntry).equals(fs.readFileSync(installedOpenClawEntry)))
        fail("staged OpenClaw entrypoint does not match the installed payload");
      const gatewayScript = path.join(runtimeRoot, "openclaw-native-ui.mjs");
      fs.writeFileSync(gatewayScript, gatewaySource(), "utf8");
      fs.copyFileSync(
        path.join(installRoot, "qualification", "native-ui-tunnel.mts"),
        path.join(runtimeRoot, "native-ui-tunnel.mts"),
      );
      const home =
        configuredIdentity === null ? path.join(shareRoot, "home") : stateSession.stateRoot;
      stateSession?.assertHeld();
      fs.mkdirSync(home, { recursive: true });
      const policyPath = path.join(runRoot, "policy.yaml");
      fs.writeFileSync(
        policyPath,
        [
          "version: 1",
          "",
          "filesystem_policy:",
          "  include_workdir: false",
          "  read_only:",
          `    - ${quoteYamlPath(runtimeRoot)}`,
          "  read_write:",
          `    - ${quoteYamlPath(shareRoot)}`,
          `    - ${quoteYamlPath(relayRoot)}`,
          ...(configuredIdentity === null ? [] : [`    - ${quoteYamlPath(home)}`]),
          "",
        ].join("\n"),
        "utf8",
      );
      const configRoot = path.join(runRoot, "config");
      const stateRoot = path.join(runRoot, "state");
      const temp = path.join(shareRoot, "temp");
      for (const directory of [configRoot, stateRoot, home, temp])
        fs.mkdirSync(directory, { recursive: true });
      const openShellPort = await freePort();
      const uiPort = await freePort();
      const modelPort = inferenceBroker?.port ?? (await freePort());
      sandboxName = `nc-ui-${runId}`;
      const gatewayName = `nemoclaw-ui-${runId}`;
      gatewayLogPath = path.join(runRoot, "openshell-gateway.log");
      gatewayErrorPath = path.join(runRoot, "openshell-gateway.err.log");
      const gatewayLog = fs.openSync(gatewayLogPath, "w");
      ownedLogs.push(gatewayLog);
      const gatewayError = fs.openSync(gatewayErrorPath, "w");
      ownedLogs.push(gatewayError);
      const gatewayEnvironment = allowlistedWindowsEnvironment({
        OPENSHELL_DRIVERS: "mxc",
        OPENSHELL_GATEWAY_CONFIG: gatewayConfig,
        XDG_CONFIG_HOME: configRoot,
        XDG_STATE_HOME: stateRoot,
      });
      webSession?.assertRunning();
      stateSession?.assertHeld();
      webSession?.progress("sandbox");
      gateway = spawn(
        gatewayExecutable,
        [
          "--port",
          String(openShellPort),
          "--disable-tls",
          "--db-url",
          "sqlite::memory:",
          "--log-level",
          "info",
        ],
        {
          env: gatewayEnvironment,
          stdio: ["ignore", gatewayLog, gatewayError],
          windowsHide: true,
        },
      );
      cliEnvironment = gatewayEnvironment;
      const gatewayFailure = new Promise((_, reject) => {
        gateway.once("error", () => reject(new Error("The OpenShell gateway could not start.")));
        gateway.once("exit", () =>
          reject(new Error("The OpenShell gateway stopped unexpectedly.")),
        );
      });
      void gatewayFailure.catch(() => {});
      console.log("WEB UI> Starting the installed OpenShell MXC gateway");
      await Promise.race([waitForPort(openShellPort, gateway), gatewayFailure]);
      cliEnvironment = allowlistedWindowsEnvironment({
        ...gatewayEnvironment,
        OPENSHELL_GATEWAY: undefined,
      });
      await run(
        openshell,
        ["gateway", "add", `http://127.0.0.1:${openShellPort}`, "--local", "--name", gatewayName],
        cliEnvironment,
        "Registering the native UI gateway",
      );
      await run(
        openshell,
        ["gateway", "select", gatewayName],
        cliEnvironment,
        "Selecting the native UI gateway",
      );
      const sandboxEnvironment = {
        LOCALAPPDATA: home,
        NEMOCLAW_MXC_HOME: home,
        NEMOCLAW_MXC_MODEL_ID: modelId,
        NEMOCLAW_MXC_MODEL_PORT: String(modelPort),
        NEMOCLAW_MXC_MODEL_TOKEN: modelToken,
        NEMOCLAW_MXC_OPENCLAW_ENTRY: openClawEntry,
        NEMOCLAW_MXC_QUALIFICATION: qualification ? "1" : "0",
        NEMOCLAW_MXC_RELAY_ROOT: relayRoot,
        NEMOCLAW_MXC_RELAY_TOKEN: relayToken,
        NEMOCLAW_MXC_UI_PORT: String(uiPort),
        NEMOCLAW_NATIVE_SERVICES: configuredIdentity === null ? "0" : "1",
        NEMOCLAW_NATIVE_BRAVE_PLUGIN: path.join(openClawRoot, "extensions", "brave"),
        NODE_DISABLE_COMPILE_CACHE: "1",
        NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS ?? "1",
        OS: "Windows_NT",
        PATH: `${path.join(systemRoot, "System32")};${systemRoot}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        PROCESSOR_ARCHITECTURE: "ARM64",
        SYSTEMDRIVE: systemDrive,
        SYSTEMROOT: systemRoot,
        TEMP: temp,
        TMP: temp,
        USERPROFILE: home,
        WINDIR: systemRoot,
      };
      const createArgs = [
        "sandbox",
        "create",
        "--name",
        sandboxName,
        "--policy",
        policyPath,
        "--driver-config-json",
        JSON.stringify({
          mxc: {
            command: [node, gatewayScript],
            cwd: shareRoot,
            host_loopback: configuredIdentity !== null,
            personal_network: configuredIdentity !== null,
          },
        }),
        "--no-tty",
      ];
      for (const [name, value] of Object.entries(sandboxEnvironment))
        createArgs.push("--env", `${name}=${value}`);
      console.log("WEB UI> Creating the native MXC OpenClaw Control UI sandbox");
      create = spawn(openshell, createArgs, {
        env: cliEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      create.once("error", () => {});
      create.stdout.on("data", (chunk) => {
        createOutput = `${createOutput}${chunk.toString("utf8")}`.slice(-64 * 1024);
      });
      create.stderr.on("data", (chunk) => {
        createError = `${createError}${chunk.toString("utf8")}`.slice(-64 * 1024);
      });
      console.log("WEB UI> Waiting for the real OpenClaw Control UI");
      await withTimeout(
        Promise.race([
          uiRelay.ready,
          gatewayFailure,
          ...(webSession
            ? [
                webSession.stopped.then(() => {
                  throw new Error("The Web UI session was stopped during startup.");
                }),
              ]
            : []),
        ]),
        180_000,
        "MXC file UI relay",
      );
      monitor = watchNativeUiSandbox(
        openshell,
        cliEnvironment,
        sandboxName,
        gateway,
        stateSession,
        monitoring.signal,
      );
      void monitor.catch(() => {});
      const uiUrl = `http://127.0.0.1:${uiRelay.browserPort}`;
      let browserProof;
      let onboardingSelection = null;
      if (qualification && skipOnboarding) {
        browserProof = await driveBrowser(
          openClawRoot,
          null,
          uiUrl,
          evidenceRoot,
          true,
          targetAgent,
          true,
        );
      } else if (qualification) {
        onboarding = await startOnboardingServer(
          installRoot,
          uiUrl,
          evidenceRoot,
          true,
          launcherPath,
        );
        console.log(`WEB UI> Launching the NemoClaw graphical onboarder at ${onboarding.origin}`);
        browserProof = await driveBrowser(
          openClawRoot,
          onboarding.url,
          uiUrl,
          evidenceRoot,
          true,
          targetAgent,
        );
        onboardingSelection = onboarding.selection();
        await new Promise((resolve, reject) => {
          onboarding.server.close((error) => (error ? reject(error) : resolve()));
        });
        onboarding = null;
        if (onboardingSelection?.agent !== "openclaw")
          fail("graphical onboarding did not select OpenClaw");
      } else {
        browserProof = {
          browserVersion: "Windows default browser",
          demonstratedAgentChoices: [],
          disabledAgentChoices: [],
          turns: [],
        };
        if (!webSession) fail("the native Web UI control is unavailable");
        webSession.assertRunning();
        webSession.ready(uiUrl);
        await Promise.race([webSession.stopped, uiRelay.failure, gatewayFailure, monitor]);
      }
      const cleanupFailures = await cleanup();
      if (cleanupFailures.length)
        throw new Error(`Native OpenClaw cleanup failed: ${cleanupFailures.join(", ")}.`);
      const receipt = {
        schemaVersion: 1,
        classification: "installed-nemoclaw-native-windows-openclaw-control-ui",
        architecture: "arm64",
        backend: "process_container",
        browser: qualification ? "Microsoft Edge" : "Windows default browser",
        browserVersion: browserProof.browserVersion,
        openClawEntrypointSha256: sha256(installedOpenClawEntry),
        nodeSha256: sha256(installedNode),
        openShellSha256: sha256(openshell),
        openShellGatewaySha256: sha256(gatewayExecutable),
        deterministicLocalModel: qualification,
        onboardingSkipped: skipOnboarding,
        onboardingSelection,
        demonstratedAgentChoices: browserProof.demonstratedAgentChoices,
        disabledAgentChoices: browserProof.disabledAgentChoices,
        turnCount: browserProof.turns.length,
        turns: browserProof.turns,
        sandboxDeleted: true,
        sandboxRegistryAbsent: true,
        gatewayStopped: true,
        qualificationRootsRemoved: true,
        verdict: "pass",
      };
      fs.writeFileSync(
        path.join(evidenceRoot, `native-windows-web-ui-${runId}.json`),
        `${JSON.stringify(receipt, null, 2)}\n`,
        "utf8",
      );
      console.log(
        qualification
          ? "WEB UI> PASS three real OpenClaw Control UI agent turns"
          : "WEB UI> NemoClaw preview session closed cleanly",
      );
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanupFailures = await cleanup();
      if (cleanupFailures.length) {
        if (primaryError)
          console.error(`WEB UI> Cleanup also failed: ${cleanupFailures.join(", ")}.`);
        else throw new Error(`Native OpenClaw cleanup failed: ${cleanupFailures.join(", ")}.`);
      }
    }
    interfacePassed = true;
  } catch (error) {
    interfaceError = error;
    throw error;
  } finally {
    if (webSession) {
      try {
        await webSession.complete(interfacePassed);
      } catch (error) {
        if (!interfaceError) throw error;
        console.error("WEB UI> The native session control also failed to close cleanly.");
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "NemoClaw native Windows launch failed.",
    );
    process.exitCode = 1;
  });
