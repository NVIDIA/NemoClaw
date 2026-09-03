// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Node's --require preload cannot execute TypeScript directly. Reuse this
// existing CommonJS test boundary as the minimal bootstrap for the typed
// source loader; the codebase growth guard prevents adding another JS file.
const Module = require("node:module");
const path = require("node:path");

if (process.env.NEMOCLAW_TEST_FORWARD_SERVICE_FIXTURE === "1") {
  let detachedForwardReady = false;
  const childProcess = require("node:child_process");
  let fixtureSpawn = childProcess.spawn;
  const forwardAwareSpawn = (...args) => {
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const forwardIndex = argv.indexOf("forward");
    if (forwardIndex >= 0 && argv[forwardIndex + 1] === "service") detachedForwardReady = true;
    return fixtureSpawn(...args);
  };
  Object.defineProperty(childProcess, "spawn", {
    configurable: true,
    get: () => forwardAwareSpawn,
    set: (value) => {
      fixtureSpawn = value;
    },
  });

  const originalModuleLoad = Module._load;
  Module._load = function loadForwardFixture(request, parent, isMain) {
    const loaded = originalModuleLoad.call(this, request, parent, isMain);
    let resolved = "";
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      return loaded;
    }
    if (
      resolved.includes(`${path.sep}adapters${path.sep}openshell${path.sep}local-forward-listener.`) &&
      typeof loaded?.probeLocalForwardListener === "function"
    ) {
      loaded.probeLocalForwardListener = () => {
        const ready = detachedForwardReady;
        detachedForwardReady = false;
        return ready;
      };
    }
    return loaded;
  };
}

function registerSourceRequire() {
  const fs = require("node:fs");
  const ts = require("typescript");
  const sourceLoader = path.join(__dirname, "register-source-require.ts");
  const bootstrapTypeScriptFiles = new Set([
    path.resolve(sourceLoader),
    path.resolve(__dirname, "source-require-cache.ts"),
  ]);
  const previousTypeScriptLoader = Module._extensions[".ts"];

  Module._extensions[".ts"] = (targetModule, filename) => {
    if (!bootstrapTypeScriptFiles.has(path.resolve(filename))) {
      if (previousTypeScriptLoader) {
        previousTypeScriptLoader(targetModule, filename);
        return;
      }
      throw new Error(`Refusing to bootstrap unexpected TypeScript module: ${filename}`);
    }

    // Loading source-require-cache.ts is what lets the real hook read tsconfig.src.json,
    // so this first hop intentionally uses minimal emit options instead of that config.
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        esModuleInterop: true,
        inlineSourceMap: true,
        inlineSources: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: filename,
    });
    targetModule._compile(outputText, filename);
  };
  require(sourceLoader);
}

function installForwardServiceReachabilityFixture(initiallyReachable = false) {
  const listener = require(
    path.resolve(__dirname, "../../src/lib/adapters/openshell/local-forward-listener.ts"),
  );
  let reachable = initiallyReachable;
  listener.probeLocalForwardListener = () => reachable;
  return {
    recordSpawn(args) {
      const argv = Array.isArray(args[1]) ? args[1] : [];
      const forwardIndex = argv.indexOf("forward");
      if (forwardIndex < 0 || argv[forwardIndex + 1] !== "service") return false;
      reachable = true;
      return true;
    },
    release() {
      reachable = false;
    },
  };
}

// Most Vitest workers use native source imports and never need the CommonJS
// source loader. Defer its TypeScript bootstrap until a worker requires a
// TypeScript file through CommonJS.
const previousTypeScriptLoader = Module._extensions[".ts"];
const previousResolveFilename = Module._resolveFilename;
const repoSourceRoot = path.resolve(__dirname, "../../src") + path.sep;
const restoreSourceRequireHooks = () => {
  Module._resolveFilename = previousResolveFilename;
  Module._extensions[".ts"] = previousTypeScriptLoader;
};
const lazySourceRequire = (targetModule, filename) => {
  restoreSourceRequireHooks();
  registerSourceRequire();
  const sourceRequire = Module._extensions[".ts"];
  if (!sourceRequire || sourceRequire === lazySourceRequire) {
    throw new Error("Source require loader did not register a TypeScript handler");
  }
  sourceRequire(targetModule, filename);
};
Module._resolveFilename = function resolveLazySourceFilename(request, parent, isMain, options) {
  try {
    return previousResolveFilename.call(this, request, parent, isMain, options);
  } catch (error) {
    const parentFilename = parent?.filename ? path.resolve(parent.filename) : "";
    const sourceCandidate =
      request.startsWith(".") && request.endsWith(".js") && parentFilename
        ? path.resolve(path.dirname(parentFilename), `${request.slice(0, -3)}.ts`)
        : "";
    if (
      !sourceCandidate.startsWith(repoSourceRoot) ||
      !require("node:fs").existsSync(sourceCandidate)
    ) {
      throw error;
    }
    return previousResolveFilename.call(
      this,
      `${request.slice(0, -3)}.ts`,
      parent,
      isMain,
      options,
    );
  }
};
Module._extensions[".ts"] = lazySourceRequire;

const { createdSandboxId: ONBOARD_READY_SANDBOX_ID } = require("./onboard-fixture-contract.json");

function normalizeCommand(command) {
  return (Array.isArray(command) ? command.join(" ") : String(command)).replace(/'/g, "");
}

function providerNameAfterAction(args, providerIndex) {
  const firstArgument = providerIndex + 2;
  return args[firstArgument] === "-g" ? args[firstArgument + 2] : args[firstArgument];
}

function parseNamedProviderGet(command, gatewayName) {
  const args = normalizeCommand(command).split(/\s+/);
  const providerIndex = args.indexOf("provider");
  if (providerIndex < 0 || args[providerIndex + 1] !== "get") return null;
  const getArgs = args.slice(providerIndex + 2);
  if (getArgs.length !== 3 || getArgs[0] !== "-g" || getArgs[1] !== gatewayName) {
    return {
      error: { status: 1, stderr: `provider get must target named gateway '${gatewayName}'` },
    };
  }
  return { providerName: getArgs[2] };
}

function mockNvidiaProviderGetRun(command, gatewayName) {
  const request = parseNamedProviderGet(command, gatewayName);
  if (request === null) return null;
  if (request.error) return request.error;
  if (request.providerName !== "nvidia-prod") return null;
  return {
    status: 0,
    stdout:
      "Name: nvidia-prod\nType: nvidia\nCredential keys: NVIDIA_INFERENCE_API_KEY\nConfig keys: <none>\n",
  };
}

function mockNvidiaOrMissingProviderGetRun(command, gatewayName) {
  const request = parseNamedProviderGet(command, gatewayName);
  if (request === null) return null;
  if (request.error) return request.error;
  return (
    mockNvidiaProviderGetRun(command, gatewayName) ?? {
      status: 1,
      stderr: `provider '${request.providerName}' not found`,
    }
  );
}

function mockEndpointlessProviderProfileRun(command, profileId, inferenceCapable) {
  const args = normalizeCommand(command).split(/\s+/);
  const providerIndex = args.indexOf("provider");
  if (providerIndex < 0 || args[providerIndex + 1] !== "profile") return null;
  const profileActionIndex = providerIndex + 2;
  const profileAction =
    args[profileActionIndex] === "-g" ? args[profileActionIndex + 2] : args[profileActionIndex];
  if (profileAction === "export") {
    const requestedProfile = args[args.indexOf("export") + 1];
    if (requestedProfile !== profileId) return null;
    return {
      status: 0,
      stdout: JSON.stringify({
        id: profileId,
        credentials: [],
        endpoints: [],
        binaries: [],
        inference_capable: inferenceCapable,
      }),
      stderr: "",
    };
  }
  const fileIndex = args.indexOf("--file");
  if (
    profileAction === "import" &&
    (fileIndex < 0 || !String(args[fileIndex + 1] ?? "").endsWith(`/${profileId}.yaml`))
  ) {
    return null;
  }
  return profileAction === "import"
    ? { status: 0, stdout: "", stderr: "" }
    : { status: 1, stdout: "", stderr: "unsupported provider profile command" };
}

function mockManagedEndpointlessProviderProfileRun(command) {
  return (
    mockEndpointlessProviderProfileRun(command, "openai", true) ??
    mockEndpointlessProviderProfileRun(command, "nemoclaw-mcp-v1", false)
  );
}

function mockProviderPreparationRun(command, gatewayName, profileId, inferenceCapable) {
  return (
    mockEndpointlessProviderProfileRun(command, profileId, inferenceCapable) ??
    mockNvidiaOrMissingProviderGetRun(command, gatewayName)
  );
}

function mockManagedProviderPreparationRun(command, gatewayName) {
  return (
    mockManagedEndpointlessProviderProfileRun(command) ??
    mockNvidiaOrMissingProviderGetRun(command, gatewayName)
  );
}

function createStatefulMessagingProviderRunner({
  commands,
  initialProviders = [],
  createdSandbox = null,
}) {
  const providers = new Map(
    initialProviders.map(([name, type, credential]) => [name, { type, credential }]),
  );
  const messagingProfile = JSON.stringify({
    id: "nemoclaw-mcp-v1",
    credentials: [],
    endpoints: [],
    binaries: [],
    inference_capable: false,
  });
  let messagingProfileImported = false;
  let lifecycleReleased = false;
  return (command, options = {}) => {
    const normalized = normalizeCommand(command);
    const args = normalized.split(/\s+/);
    const providerIndex = args.indexOf("provider");
    commands.push({ command: normalized, env: options.env || null });
    const sandboxResult = createdSandbox?.run(command) ?? null;
    if (sandboxResult !== null) return sandboxResult;

    const providerAction = providerIndex >= 0 ? args[providerIndex + 1] : null;
    if (providerAction === "profile") {
      const profileActionIndex = providerIndex + 2;
      const profileAction =
        args[profileActionIndex] === "-g" ? args[profileActionIndex + 2] : args[profileActionIndex];
      if (profileAction === "export") {
        return messagingProfileImported
          ? { status: 0, stdout: messagingProfile, stderr: "" }
          : { status: 1, stdout: "", stderr: "provider profile not found" };
      }
      const fileIndex = args.indexOf("--file");
      if (profileAction === "import" && fileIndex >= 0 && args[fileIndex + 1]) {
        messagingProfileImported = true;
        return { status: 0 };
      }
      return { status: 1, stderr: "unsupported provider profile command" };
    }
    if (
      args[providerIndex - 1] === "sandbox" &&
      (providerAction === "attach" || providerAction === "detach")
    ) {
      return args.length >= providerIndex + 4
        ? { status: 0 }
        : { status: 1, stderr: `invalid provider ${providerAction} command` };
    }
    if (providerAction === "create") {
      const nameIndex = args.indexOf("--name");
      const typeIndex = args.indexOf("--type");
      const credentialIndex = args.indexOf("--credential");
      const name = nameIndex >= 0 ? args[nameIndex + 1] : null;
      const type = typeIndex >= 0 ? args[typeIndex + 1] : null;
      const credential = credentialIndex >= 0 ? args[credentialIndex + 1] : null;
      if (!name || !type || !credential) {
        return { status: 1, stderr: "invalid provider create command" };
      }
      providers.set(name, { type, credential });
      return { status: 0 };
    }
    if (providerAction === "get") {
      const name = args.at(-1);
      if (!name || name === "get") {
        return { status: 1, stderr: "invalid provider get command" };
      }
      const provider = providers.get(name);
      return provider
        ? {
            status: 0,
            stdout: [
              `Name: ${name}`,
              `Type: ${provider.type}`,
              `Credential keys: ${provider.credential}`,
              "Config keys: <none>",
            ].join("\n"),
          }
        : { status: 1, stderr: `provider '${name}' not found` };
    }
    if (providerAction === "update") {
      const name = providerNameAfterAction(args, providerIndex);
      const credentialIndex = args.indexOf("--credential");
      const credential = credentialIndex >= 0 ? args[credentialIndex + 1] : null;
      const provider = providers.get(name);
      if (!name || !provider || (credentialIndex >= 0 && !credential)) {
        return { status: 1, stderr: "invalid provider update command" };
      }
      if (credential) provider.credential = credential;
      return { status: 0 };
    }
    if (providerAction === "delete") {
      const name = providerNameAfterAction(args, providerIndex);
      if (!name || !providers.delete(name)) {
        return { status: 1, stderr: "invalid provider delete command" };
      }
      return { status: 0 };
    }
    if (providerIndex >= 0) {
      return { status: 1, stderr: "unsupported provider command" };
    }
    if (normalized.startsWith("docker rm ")) lifecycleReleased = true;
    if (lifecycleReleased && args.includes("sandbox") && args.includes("list")) {
      return {
        status: 0,
        stdout: Buffer.from("No sandboxes found\n"),
        stderr: Buffer.alloc(0),
      };
    }
    return { status: 0 };
  };
}

const OPENCLAW_SECURITY_INVENTORY_PROBE_PREFIX = Object.freeze([
  "run",
  "--rm",
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--entrypoint",
  "/bin/sh",
]);

const OPENCLAW_SECURITY_INVENTORY_PROBE = [
  "set -eu",
  "security_inventory=/usr/local/share/nemoclaw/security-packages.txt",
  'arch="$(dpkg --print-architecture)"',
  'test -f "$security_inventory"',
  'test ! -L "$security_inventory"',
  `test "$(stat -c '%u:%g:%a' "$security_inventory")" = "0:0:444"`,
  `printf '%s\\n' "architecture=$arch" "libexpat1=2.8.3-1" "libonig5=6.9.9-1+b1" "libjq1=1.8.2-1" "jq=1.8.2-1" "vim-common=2:9.2.0858-1" "vim-tiny=2:9.2.0858-1" "libssh2-1t64=1.11.1-1+deb13u1+nemoclaw2" "libssl3t64=3.5.7-1~deb13u2" "nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1" "perl-base=5.44.0-1nemoclaw1" "perl=5.44.0-1nemoclaw1" "libevent-core-2.1-7t64=2.1.13-stable-1" | cmp -s - "$security_inventory"`,
  `printf '%s\\n' "nemoclaw-security-inventory-ok"`,
].join("; ");

const ONBOARD_SANDBOX_OLD_CONTAINER_ID = "a".repeat(64);
const ONBOARD_SANDBOX_NEW_CONTAINER_ID = "b".repeat(64);
const ONBOARD_SANDBOX_INSPECT = {
  Id: ONBOARD_SANDBOX_OLD_CONTAINER_ID,
  Image: `sha256:${"c".repeat(64)}`,
  Name: "/openshell-my-assistant",
  Config: {
    Image: "openshell/sandbox:test",
    Env: ["OPENSHELL_SANDBOX_COMMAND=sleep infinity"],
    Labels: {
      "openshell.ai/managed-by": "openshell",
      "openshell.ai/sandbox-name": "my-assistant",
      "openshell.ai/sandbox-namespace": "test-gateway",
    },
    Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
    Cmd: [],
    User: "0",
    WorkingDir: "/sandbox",
  },
  HostConfig: {
    NetworkMode: "openshell-docker",
    RestartPolicy: { Name: "unless-stopped" },
  },
};

function isOpenClawSecurityInventoryProbe(command) {
  const commandArgs = Array.isArray(command) ? command.map(String) : [];
  const dockerArgs = commandArgs[0] === "docker" ? commandArgs.slice(1) : commandArgs;
  const matches =
    dockerArgs.length === 14 &&
    OPENCLAW_SECURITY_INVENTORY_PROBE_PREFIX.every(
      (expected, index) => dockerArgs[index] === expected,
    ) &&
    dockerArgs[11].length > 0 &&
    dockerArgs[12] === "-c" &&
    dockerArgs[13] === OPENCLAW_SECURITY_INVENTORY_PROBE;
  return matches;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function mockSandboxExecCurl(command, options = {}) {
  const normalized = normalizeCommand(command);
  if (!normalized.includes("sandbox exec") || !normalized.includes("curl")) {
    return null;
  }

  if (normalized.includes("/health") || normalized.includes("%{http_code}")) {
    return options.dashboardHealthCode || "200";
  }

  if (hasOwn(options, "defaultCurlOutput")) {
    return options.defaultCurlOutput;
  }

  return null;
}

function mockOnboardRunCapture(command, options = {}) {
  // The companion runner seam models the exact post-commit Docker proof. Install
  // it lazily after each scenario has replaced runner.run with its local recorder.
  mockDockerSandboxLifecycleReleaseFromRunner();
  const normalized = normalizeCommand(command);
  if (
    normalized.startsWith("docker ps -a --no-trunc ") &&
    normalized.includes("label=openshell.ai/sandbox-name=my-assistant") &&
    normalized.endsWith("--format {{.ID}}")
  ) {
    return `${ONBOARD_SANDBOX_OLD_CONTAINER_ID}\n${ONBOARD_SANDBOX_NEW_CONTAINER_ID}\n`;
  }
  if (normalized === `docker inspect --type container ${ONBOARD_SANDBOX_OLD_CONTAINER_ID}`) {
    return JSON.stringify([ONBOARD_SANDBOX_INSPECT]);
  }
  if (isOpenClawSecurityInventoryProbe(command)) {
    return "nemoclaw-security-inventory-ok";
  }
  if (
    normalized.startsWith("docker run ") &&
    normalized.includes(" --entrypoint /usr/bin/ldd ") &&
    normalized.endsWith(" --version")
  ) {
    return "ldd (GNU libc) 2.41";
  }
  return mockSandboxExecCurl(command, options);
}

function exactOpenShellArgs(command) {
  const args = Array.isArray(command) ? command.map(String) : [];
  const verbs = new Set(["gateway", "policy", "sandbox"]);
  if (verbs.has(args[0])) return args;
  if (args.length > 1 && verbs.has(args[1])) return args.slice(1);
  if (
    args.length > 4 &&
    args[0] === "/usr/bin/timeout" &&
    args[1] === "--signal=KILL" &&
    /^(?:0\.[0-9]+|[1-9][0-9]*(?:\.[0-9]+)?)s$/u.test(args[2]) &&
    args[3].length > 0 &&
    !args[3].startsWith("-") &&
    verbs.has(args[4])
  ) {
    return args.slice(4);
  }
  return null;
}

function createCreatedSandboxFixture(options = {}) {
  const sandboxIdentity = require(
    path.resolve(__dirname, "../../src/lib/adapters/openshell/sandbox-identity.ts"),
  );
  const initialSandboxId = hasOwn(options, "sandboxId")
    ? options.sandboxId
    : ONBOARD_READY_SANDBOX_ID;
  const initialLifecycleState = hasOwn(options, "lifecycleState")
    ? options.lifecycleState
    : "absent";
  const state = {
    sandboxName: hasOwn(options, "sandboxName") ? options.sandboxName : "my-assistant",
    sandboxId: initialSandboxId,
    gatewayName: hasOwn(options, "gatewayName") ? options.gatewayName : "nemoclaw",
    phase: hasOwn(options, "phase") ? options.phase : "Ready",
    lifecycleState: initialLifecycleState,
    generation: initialLifecycleState === "created" ? 1 : 0,
    createAttemptNonce: null,
    ownerScopedIdentityObserved: initialLifecycleState === "created",
  };
  const lifecycleStates = new Set(["absent", "created", "deleted"]);
  const createAttemptNoncePattern = new RegExp(
    `^[0-9a-f]{${sandboxIdentity.NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH}}$`,
    "u",
  );

  const assertState = () => {
    if (
      typeof state.sandboxName !== "string" ||
      state.sandboxName.length === 0 ||
      state.sandboxName.trim() !== state.sandboxName
    ) {
      throw new Error("Created sandbox fixture requires one sandbox name.");
    }
    if (!sandboxIdentity.isOpenShellSandboxId(state.sandboxId)) {
      throw new Error("Created sandbox fixture requires one durable sandbox ID.");
    }
    if (
      typeof state.gatewayName !== "string" ||
      state.gatewayName.length === 0 ||
      state.gatewayName.trim() !== state.gatewayName
    ) {
      throw new Error("Created sandbox fixture requires one gateway name.");
    }
    if (typeof state.phase !== "string" || state.phase.length === 0) {
      throw new Error("Created sandbox fixture requires one sandbox phase.");
    }
    if (!lifecycleStates.has(state.lifecycleState)) {
      throw new Error("Created sandbox fixture requires one known lifecycle state.");
    }
    if (
      state.createAttemptNonce !== null &&
      !createAttemptNoncePattern.test(state.createAttemptNonce)
    ) {
      throw new Error("Created sandbox fixture requires one valid create-attempt nonce.");
    }
  };

  const commandDetails = (command) => {
    const args = Array.isArray(command) ? command.map(String) : [];
    const sandboxIndex = args.indexOf("sandbox");
    if (sandboxIndex < 0) return null;
    const gatewayIndex = args.findIndex((arg) => arg === "-g" || arg === "--gateway");
    const gatewayName = gatewayIndex >= 0 ? args[gatewayIndex + 1] || null : null;
    return { args, action: args[sandboxIndex + 1] || null, gatewayName };
  };

  const nonceFromCreateCommand = (command) => {
    const details = commandDetails(command);
    if (!details || details.action !== "create") {
      throw new Error("Created sandbox fixture requires one sandbox create command.");
    }
    if (details.gatewayName !== null && details.gatewayName !== state.gatewayName) {
      throw new Error("Created sandbox fixture requires its configured gateway.");
    }
    const prefix = `${sandboxIdentity.NEMOCLAW_CREATE_ATTEMPT_LABEL}=`;
    const labels = details.args.flatMap((arg, index) => {
      if (arg === "--label") return [details.args[index + 1] || ""];
      return arg.startsWith("--label=") ? [arg.slice("--label=".length)] : [];
    });
    const nonces = labels
      .filter((label) => label.startsWith(prefix))
      .map((label) => label.slice(prefix.length));
    if (nonces.length !== 1 || !createAttemptNoncePattern.test(nonces[0])) {
      throw new Error("Created sandbox fixture requires one valid create-attempt label.");
    }
    return nonces[0];
  };

  const isCreated = () => state.lifecycleState === "created";
  const observe = (command, allowPublishedUnscopedGet) => {
    const details = commandDetails(command);
    if (!details) return null;
    const { args, action, gatewayName } = details;
    if (action === "get") {
      const wrongGateway = gatewayName !== null && gatewayName !== state.gatewayName;
      const unscopedBeforePublication =
        gatewayName === null && (!allowPublishedUnscopedGet || !state.ownerScopedIdentityObserved);
      if (wrongGateway || unscopedBeforePublication) {
        return null;
      }
      const sandboxName = args.at(-1);
      if (sandboxName !== state.sandboxName) return null;
      if (gatewayName === state.gatewayName && isCreated()) {
        state.ownerScopedIdentityObserved = true;
      }
      return isCreated()
        ? `Name: ${state.sandboxName}\nId: ${state.sandboxId}\nPhase: ${state.phase}\n`
        : "";
    }
    if (action !== "list") return null;

    const selectorIndex = args.indexOf("--selector");
    if (selectorIndex >= 0) {
      const prefix = `${sandboxIdentity.NEMOCLAW_CREATE_ATTEMPT_LABEL}=`;
      const exactArgs = exactOpenShellArgs(command);
      if (
        !exactArgs ||
        exactArgs.length !== 10 ||
        exactArgs[0] !== "sandbox" ||
        exactArgs[1] !== "list" ||
        exactArgs[2] !== "-g" ||
        exactArgs[3] !== state.gatewayName ||
        exactArgs[4] !== "--selector" ||
        !exactArgs[5].startsWith(prefix) ||
        exactArgs[6] !== "--output" ||
        exactArgs[7] !== "json" ||
        exactArgs[8] !== "--limit" ||
        exactArgs[9] !== "2"
      ) {
        return null;
      }
      const selector = exactArgs[5];
      if (!isCreated()) return "[]";
      const nonce = selector.slice(prefix.length);
      if (nonce !== state.createAttemptNonce) return "[]";
      return JSON.stringify([
        {
          id: state.sandboxId,
          name: state.sandboxName,
          labels: { [sandboxIdentity.NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce },
          resource_version: state.generation,
          created_at: "2026-08-25T00:00:00Z",
          phase: state.phase,
          current_policy_version: 1,
        },
      ]);
    }

    if (gatewayName !== null && gatewayName !== state.gatewayName) return null;
    return isCreated() ? `${state.sandboxName} ${state.phase}\n` : "No sandboxes found.\n";
  };

  const capture = (command) => observe(command, false);

  const run = (command) => {
    const output = observe(command, true);
    if (output === null) return null;
    if (output === "") {
      return {
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(`Error: sandbox ${state.sandboxName} not found\n`),
      };
    }
    return { status: 0, stdout: Buffer.from(output), stderr: Buffer.alloc(0) };
  };

  const create = (command) => {
    const details = commandDetails(command);
    if (!details || details.action !== "create") return;
    const createAttemptNonce = nonceFromCreateCommand(command);
    if (state.lifecycleState === "created") {
      if (createAttemptNonce !== state.createAttemptNonce) {
        throw new Error("Created sandbox fixture cannot change a live create attempt.");
      }
      return;
    }
    if (state.lifecycleState !== "absent") {
      throw new Error("Created sandbox fixture cannot create a deleted sandbox.");
    }
    state.createAttemptNonce = createAttemptNonce;
    state.ownerScopedIdentityObserved = false;
    assertState();
    state.lifecycleState = "created";
    state.generation += 1;
  };

  const deleteSandbox = () => {
    if (state.lifecycleState !== "created") {
      throw new Error("Created sandbox fixture can delete only a created sandbox.");
    }
    state.lifecycleState = "deleted";
    state.ownerScopedIdentityObserved = false;
  };

  const recreate = (command) => {
    if (state.lifecycleState !== "deleted") {
      throw new Error("Created sandbox fixture can recreate only a deleted sandbox.");
    }
    const createAttemptNonce = nonceFromCreateCommand(command);
    state.generation += 1;
    const replacementFingerprint = sandboxIdentity.fingerprintOpenShellSandboxId(initialSandboxId);
    state.sandboxId = `sbx-recreated-${state.generation}-${replacementFingerprint}`;
    state.createAttemptNonce = createAttemptNonce;
    state.ownerScopedIdentityObserved = false;
    assertState();
    state.lifecycleState = "created";
  };

  const setPhase = (phase) => {
    state.phase = phase;
    assertState();
  };

  const installRuntimeObservation = () => {
    const openshellRuntime = require(
      path.resolve(__dirname, "../../src/lib/adapters/openshell/runtime.ts"),
    );
    const previousCapture = openshellRuntime.captureResolvedOpenshell;
    const fixtureCapture = (args, options = {}) => {
      const result = run(["openshell", ...args]);
      if (result === null) return previousCapture(args, options);
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      return {
        status: result.status,
        output: options.includeStderr ? `${stdout}${stderr}` : stdout,
        stdout,
        stderr,
      };
    };
    openshellRuntime.captureResolvedOpenshell = fixtureCapture;
    return () => {
      if (openshellRuntime.captureResolvedOpenshell === fixtureCapture) {
        openshellRuntime.captureResolvedOpenshell = previousCapture;
      }
    };
  };

  assertState();
  return Object.freeze({
    capture,
    create,
    delete: deleteSandbox,
    installRuntimeObservation,
    recreate,
    run,
    setPhase,
    get state() {
      return Object.freeze({ ...state });
    },
  });
}

function installVerifiedSandboxCreateFixture(registry, options) {
  const sandboxName = options.sandboxName;
  const gatewayName = options.gatewayName || "nemoclaw";
  const gatewayPort = options.gatewayPort || 8080;
  mockStructuredOpenShellCaptureFromRunner({ gatewayName, gatewayPort, sandboxName });
  const sessionId = options.sessionId || "integration-fixture-session";
  const selection = {
    provider: options.provider,
    model: options.model,
    endpointUrl: options.endpointUrl || null,
    endpointSource: options.endpointSource || null,
    credentialEnv: options.credentialEnv || null,
    preferredInferenceApi: options.preferredInferenceApi || null,
    compatibleEndpointReasoning: options.compatibleEndpointReasoning || null,
    compatibleEndpointReasoningEffort: options.compatibleEndpointReasoningEffort || null,
    nimContainer: options.nimContainer || null,
  };
  const reservationEntry = {
    name: sandboxName,
    gatewayName,
    pendingRouteReservation: true,
    reservationSessionId: sessionId,
    ...selection,
  };
  let pendingCheckpoint = null;
  let pendingEntry = null;
  let publishedEntry = null;
  let sourceEntry = options.getSandbox ? options.getSandbox(sandboxName) : null;
  const qualifyPendingSandboxCreateReservation = (authority) => {
    const selectionMatches = [
      "provider",
      "model",
      "endpointUrl",
      "endpointSource",
      "credentialEnv",
      "preferredInferenceApi",
    ].every((key) => (authority.selection[key] ?? null) === (selection[key] ?? null));
    if (
      authority.sandboxName !== sandboxName ||
      authority.gatewayName !== gatewayName ||
      authority.sessionId !== sessionId ||
      !selectionMatches
    ) {
      throw new Error("integration fixture received unexpected create reservation authority");
    }
    return {
      authority: structuredClone(authority),
      entry: structuredClone(reservationEntry),
    };
  };
  const recordPendingSandboxCreateIdentity = (reservation, checkpoint) => {
    pendingCheckpoint = structuredClone(checkpoint);
    pendingEntry = {
      ...structuredClone(reservation.entry),
      lifecycleGeneration: checkpoint.lifecycleGeneration,
      lifecycleLiveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
      pendingCreateIdentity: structuredClone(checkpoint),
    };
    return structuredClone(pendingEntry);
  };
  const requireCurrentPendingSandboxCreateIdentity = (reservation, checkpoint) => {
    if (
      reservation.authority.sessionId !== sessionId ||
      pendingCheckpoint === null ||
      JSON.stringify(checkpoint) !== JSON.stringify(pendingCheckpoint)
    ) {
      throw new Error("integration fixture verified create checkpoint changed");
    }
    return structuredClone(pendingEntry);
  };

  const registryPath = require.resolve(path.resolve(__dirname, "../../src/lib/state/registry.ts"));
  const registryFixture = {
    ...registry,
    qualifyPendingSandboxCreateReservation,
    recordPendingSandboxCreateIdentity,
    requireCurrentPendingSandboxCreateIdentity,
    getSandbox: (name) =>
      name === sandboxName
        ? structuredClone(publishedEntry || pendingEntry || sourceEntry)
        : registry.getSandbox(name),
    registerSandbox: (entry) => {
      publishedEntry = structuredClone(entry);
      pendingEntry = null;
      pendingCheckpoint = null;
      options.registerSandbox?.(structuredClone(entry));
      return structuredClone(entry);
    },
    updateSandbox: (name, updates) => {
      if (name === sandboxName && publishedEntry) {
        publishedEntry = { ...publishedEntry, ...structuredClone(updates) };
      }
      options.updateSandbox?.(name, updates);
      return true;
    },
    setDefault: (name) => {
      options.setDefault?.(name);
      return true;
    },
    removeSandbox: (name) => {
      if (name === sandboxName) {
        pendingEntry = null;
        publishedEntry = null;
        sourceEntry = null;
      }
      options.removeSandbox?.(name);
      return true;
    },
  };
  if (options.durableRegistry !== true) {
    for (const [name, value] of Object.entries(registryFixture)) {
      Object.defineProperty(registry, name, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    require.cache[registryPath].exports = registry;
  }

  const prepareCreateIntent = () => {
    const onboardSession = require(
      path.resolve(__dirname, "../../src/lib/state/onboard-session.ts"),
    );
    const recreate = require(
      path.resolve(__dirname, "../../src/lib/onboard/sandbox-recreate-transaction.ts"),
    );
    const current = onboardSession.loadSession();
    const currentTransaction = current?.checkpoint?.sandboxRecreate || null;
    const currentEntry =
      options.durableRegistry === true
        ? registry.getSandbox(sandboxName)
        : registryFixture.getSandbox(sandboxName);
    const recoverPendingCreate =
      currentEntry?.pendingRouteReservation === true &&
      currentEntry.pendingCreateIdentity !== undefined;
    let transaction =
      currentTransaction && (currentTransaction.phase !== "created" || recoverPendingCreate)
        ? currentTransaction
        : null;
    if (!transaction) {
      const session = onboardSession.createSession({
        sessionId,
        sandboxName,
        agent: options.agentName || "openclaw",
      });
      const sourceIdentity =
        currentEntry?.lifecycleLiveIdentityFingerprint ||
        (options.sourceSandboxId
          ? recreate.fingerprintSandboxRecreateValue(options.sourceSandboxId)
          : null);
      transaction = recreate.beginSandboxRecreateTransaction(session, {
        sandboxName,
        gatewayName,
        gatewayPort: options.gatewayPort || 8080,
        sourceEntry: currentEntry,
        observation: sourceIdentity
          ? { state: "ready", liveIdentityFingerprint: sourceIdentity }
          : { state: "missing", liveIdentityFingerprint: null },
        targetIntentFingerprint: recreate.fingerprintSandboxRecreateValue({
          fixture: "verified-sandbox-create",
          gatewayName,
          sandboxName,
          selection,
        }),
      });
      session.checkpoint = {
        ...session.checkpoint,
        sandboxIdentity: {
          kind: "selected",
          value: { name: sandboxName, agent: options.agentName || "openclaw" },
        },
        gatewayAuthority: {
          kind: "selected",
          value: {
            gatewayName,
            gatewayPort: options.gatewayPort || 8080,
            mode: "nemoclaw-managed",
            source: "standalone",
            endpoint: null,
            stateDir: null,
            supervisor: null,
            requiredCapabilities: [],
          },
        },
      };
      onboardSession.saveSession(session);
    }
    return {
      recreate: false,
      toolDisclosure: "progressive",
      observabilityEnabled: false,
      recreateTransaction: {
        id: transaction.id,
        targetGeneration: transaction.targetGeneration,
        targetIntentFingerprint: transaction.targetIntentFingerprint,
      },
    };
  };
  return { sessionId, selection, prepareCreateIntent };
}

function sandboxCreateArgsWithVerifiedReservation(args, fixture) {
  const createArgs = [...args];
  while (createArgs.length < 16) createArgs.push(null);
  createArgs[14] = { sessionId: fixture.sessionId, selection: fixture.selection };
  const fixtureIntent = fixture.prepareCreateIntent();
  const requestedIntent = createArgs[15];
  createArgs[15] =
    requestedIntent && typeof requestedIntent === "object"
      ? {
          ...fixtureIntent,
          ...requestedIntent,
          recreateTransaction:
            requestedIntent.recreateTransaction || fixtureIntent.recreateTransaction,
        }
      : fixtureIntent;
  return createArgs;
}

function sandboxLifecycleFixture(entry, options = {}) {
  const gatewayName = options.gatewayName || "nemoclaw";
  const gatewayPort = options.gatewayPort || 8080;
  const lifecycleGeneration = options.lifecycleGeneration || "123e4567-e89b-42d3-a456-426614174983";
  const sandboxId = options.sandboxId || ONBOARD_READY_SANDBOX_ID;
  const sandboxIdentityFingerprint = require("node:crypto")
    .createHash("sha256")
    .update(sandboxId)
    .digest("hex");
  return {
    ...entry,
    gatewayName,
    gatewayPort,
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: sandboxIdentityFingerprint,
  };
}

function mockStructuredOpenShellCaptureFromRunner(options = {}) {
  const runner = require(path.resolve(__dirname, "../../src/lib/runner.ts"));
  const client = require(path.resolve(__dirname, "../../src/lib/adapters/openshell/client.ts"));
  const originalCaptureOpenshellCommand = client.captureOpenshellCommand;
  const gatewayName = options.gatewayName || "nemoclaw";
  const gatewayPort = options.gatewayPort || 8080;
  const sandboxName = options.sandboxName || null;
  client.captureOpenshellCommand = (binary, args, options = {}) => {
    const exactGatewayInfo =
      args.length === 4 &&
      args[0] === "gateway" &&
      args[1] === "info" &&
      args[2] === "-g" &&
      args[3] === gatewayName;
    if (exactGatewayInfo) {
      const stdout = `Gateway endpoint: http://127.0.0.1:${gatewayPort}\n`;
      return {
        status: 0,
        output: stdout.trim(),
        ...(options.includeStreams === true ? { stdout, stderr: "" } : {}),
      };
    }
    const isCreatedSandboxPolicyRead =
      args.length === 8 &&
      args[0] === "policy" &&
      args[1] === "get" &&
      args[2] === "-g" &&
      args[3] === gatewayName &&
      args[4] === "--full" &&
      args[5] === "--output" &&
      args[6] === "json" &&
      sandboxName === args[7];
    const isFreshGlobalPolicyHistoryRead =
      args.length === 7 &&
      args[0] === "policy" &&
      args[1] === "list" &&
      args[2] === "-g" &&
      args[3] === gatewayName &&
      args[4] === "--global" &&
      args[5] === "--limit" &&
      args[6] === "1";
    if (isFreshGlobalPolicyHistoryRead) {
      const stderr = "No global policy history found\n";
      return {
        status: 0,
        output: options.includeStderr === true ? stderr.trim() : "",
        ...(options.includeStreams === true ? { stdout: "", stderr } : {}),
      };
    }
    const stdout = String(
      runner.runCapture([binary, ...args], {
        ...options,
        ignoreError: true,
        includeStderr: false,
      }) || "",
    );
    if (isCreatedSandboxPolicyRead && stdout.trim().length === 0) {
      const fallback = JSON.stringify({
        scope: "sandbox",
        sandbox: sandboxName,
        status: "effective",
        policy_source: "sandbox",
        hash: "fixture-policy",
        active_version: 1,
        policy: { version: 1, network_policies: {} },
      });
      return {
        status: 0,
        output: fallback,
        ...(options.includeStreams === true ? { stdout: fallback, stderr: "" } : {}),
      };
    }
    const isSandboxGet =
      args.length === 5 &&
      args[0] === "sandbox" &&
      args[1] === "get" &&
      args[2] === "-g" &&
      args[3] === gatewayName;
    if (isSandboxGet && stdout.trim().length === 0) {
      const requestedSandboxName = String(args.at(-1) || "unknown");
      const stderr = `Error: sandbox ${requestedSandboxName} not found\n`;
      return {
        status: 1,
        output: options.includeStderr === true ? stderr.trim() : "",
        ...(options.includeStreams === true ? { stdout: "", stderr } : {}),
      };
    }
    return {
      status: 0,
      output: stdout.trim(),
      ...(options.includeStreams === true ? { stdout, stderr: "" } : {}),
    };
  };
  return () => {
    client.captureOpenshellCommand = originalCaptureOpenshellCommand;
  };
}

function mockStandaloneGatewayTeardownAuthority() {
  // Recreate integration fixtures historically mock runner.runCapture. Keep
  // the structured OpenShell probe on that same seam while preserving clean
  // nonzero NotFound metadata after the fixture records deletion.
  mockStructuredOpenShellCaptureFromRunner();
  const authority = require(
    path.resolve(__dirname, "../../src/lib/onboard/gateway-teardown-authority.ts"),
  );
  authority.resolveGatewayTeardownAuthority = ({ gatewayName, gatewayPort }) => ({
    gatewayName,
    gatewayPort,
    mode: "nemoclaw-managed",
    source: "standalone",
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  });
}

function mockDockerSandboxLifecycleReleaseFromRunner() {
  const runner = require(path.resolve(__dirname, "../../src/lib/runner.ts"));
  const state = runner.run.__nemoclawDockerLifecycleState ?? {
    finalCommitReleased: false,
    lifecycleStopped: false,
    replacementRestarted: false,
  };
  const captureOutput = (normalized) => {
    if (
      state.finalCommitReleased &&
      normalized.startsWith("docker ps -a --no-trunc ") &&
      normalized.includes("label=openshell.ai/sandbox-name=my-assistant") &&
      normalized.endsWith("--format {{.ID}}")
    ) {
      return `${ONBOARD_SANDBOX_NEW_CONTAINER_ID}\n`;
    }
    if (
      state.finalCommitReleased &&
      normalized ===
        `docker inspect --type container --format {{ index .Config.Labels "openshell.ai/sandbox-namespace" }} ${ONBOARD_SANDBOX_NEW_CONTAINER_ID}`
    ) {
      return "test-gateway\n";
    }
    if (
      state.finalCommitReleased &&
      normalized ===
        `docker inspect --type container --format {{json .State.Running}} ${ONBOARD_SANDBOX_NEW_CONTAINER_ID}`
    ) {
      return "true\n";
    }
    if (state.replacementRestarted && normalized.includes("sandbox list")) {
      return "my-assistant  2026-08-27  Ready\n";
    }
    if (state.lifecycleStopped && normalized.includes("sandbox list")) {
      return "my-assistant  2026-08-27  Stopped\n";
    }
    return null;
  };
  if (runner.run.__nemoclawDockerLifecycleFixture !== true) {
    const run = runner.run;
    const wrappedRun = (command, options) => {
      const normalized = normalizeCommand(command);
      const captured = captureOutput(normalized);
      if (captured !== null) {
        return {
          status: 0,
          stdout: Buffer.from(captured),
          stderr: Buffer.alloc(0),
        };
      }
      const result = run(command, options);
      if (normalized.startsWith("docker rm ") && result?.status === 0) {
        if (normalized === `docker rm ${ONBOARD_SANDBOX_OLD_CONTAINER_ID}`) {
          state.finalCommitReleased = true;
        }
      }
      if (normalized.includes("sandbox stop my-assistant") && result?.status === 0) {
        state.lifecycleStopped = true;
        state.replacementRestarted = false;
      }
      if (
        state.finalCommitReleased &&
        normalized.includes("sandbox start my-assistant") &&
        result?.status === 0
      ) {
        state.replacementRestarted = true;
      }
      return result;
    };
    wrappedRun.__nemoclawDockerLifecycleFixture = true;
    wrappedRun.__nemoclawDockerLifecycleState = state;
    runner.run = wrappedRun;
  }
  if (runner.runCapture.__nemoclawDockerLifecycleFixture !== true) {
    const runCapture = runner.runCapture;
    const wrappedRunCapture = (command, options) => {
      return captureOutput(normalizeCommand(command)) ?? runCapture(command, options);
    };
    wrappedRunCapture.__nemoclawDockerLifecycleFixture = true;
    runner.runCapture = wrappedRunCapture;
  }
}

function mockFreshOpenClawPluginDiscovery() {
  const pluginRestore = require(
    path.resolve(__dirname, "../../src/lib/state/openclaw-plugin-restore.ts"),
  );
  pluginRestore.discoverFreshOpenClawImagePluginInstalls = () => ({
    ok: true,
    extensionDirs: [],
    pluginInstalls: [],
  });
}

function mockManagedImageCatalog() {
  const catalog = require(
    path.resolve(__dirname, "../../src/lib/onboard/managed-image/catalog.ts"),
  );
  const contract = require(
    path.resolve(__dirname, "../../src/lib/onboard/managed-image/contract.ts"),
  );
  const { getBuildIdentity } = require(path.resolve(__dirname, "../../src/lib/core/version.ts"));
  const sourceRevision = getBuildIdentity({
    rootDir: path.resolve(__dirname, "../.."),
  }).sourceRevision;
  catalog.resolveManagedImageCatalogFromGhcr = async ({ release, platform }) =>
    Object.fromEntries(
      contract.SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
        const image = contract.MANAGED_IMAGE_REPOSITORIES[agent];
        const digest = `sha256:${String(index + 1).repeat(64)}`;
        return [
          agent,
          {
            contractVersion: contract.MANAGED_IMAGE_CONTRACT_VERSION,
            agent,
            platform,
            image,
            digest,
            reference: `${image}@${digest}`,
            source: {
              repository: contract.MANAGED_IMAGE_SOURCE_REPOSITORY,
              revision: sourceRevision,
              release,
              cohort: "ghrun-9068-1",
            },
            startupProfileContractVersion: contract.MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
            capabilityContractVersion: contract.MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
          },
        ];
      }),
    );
}

function mockManagedImageBootstrap() {
  const crypto = require("node:crypto");
  const adapter = require(
    path.resolve(__dirname, "../../src/lib/onboard/managed-bootstrap/adapter.ts"),
  );
  const bootstrap = require(
    path.resolve(__dirname, "../../src/lib/onboard/managed-bootstrap/docker.ts"),
  );
  const authorityStore = require(
    path.resolve(__dirname, "../../src/lib/onboard/managed-bootstrap/docker-authority-store.ts"),
  );

  authorityStore.createDockerManagedBootstrapAuthorityStore = () => ({
    async recordPreparedAuthority(authority) {
      return {
        schemaVersion: authority.schemaVersion,
        sandbox: authority.sandbox,
        bootstrapIdentity: authority.bootstrapIdentity,
        authorityFingerprint: authority.authorityFingerprint,
        recordId: "test-managed-onboard-authority",
        recordedAt: "2026-08-04T12:00:00.000Z",
      };
    },
  });
  bootstrap.createDockerManagedBootstrapAdapter = () => {
    const runtimeId = "a".repeat(64);
    const replacementRuntimeId = "c".repeat(64);
    const runtimeImageContentId = `sha256:${"b".repeat(64)}`;
    const originalSpecCanonicalJson = '{"runtime":"original"}\n';
    const preparedSpecCanonicalJson = '{"runtime":"prepared"}\n';
    const replacementSpecCanonicalJson = '{"runtime":"replacement"}\n';
    const digest = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
    const originalSpecHash = digest(originalSpecCanonicalJson);
    const preparedSpecHash = digest(preparedSpecCanonicalJson);
    const replacementSpecHash = digest(replacementSpecCanonicalJson);
    return {
      async recoverUnfinishedTransactions() {
        return { receipts: [], failures: [] };
      },
      async createHeldWorkload(input) {
        const bootstrapIdentity = input.bootstrapIdentity;
        const heldWorkloadArgv = adapter.renderManagedBootstrapHeldCommand(
          input.request,
          bootstrapIdentity,
          input.plan.intendedWorkloadArgv,
        );
        const createReceipt = await input.launch({ heldWorkloadArgv, bootstrapIdentity });
        return {
          schemaVersion: 1,
          sandbox: createReceipt.sandbox,
          bootstrapIdentity,
          heldWorkloadArgv,
          intendedWorkloadArgv: input.plan.intendedWorkloadArgv,
          plan: input.plan,
          createReceipt,
        };
      },
      async cleanupIncompleteCreate({ createReceipt, bootstrapIdentity }) {
        return {
          schemaVersion: 1,
          sandbox: createReceipt.sandbox,
          bootstrapIdentity,
          outcome: "rolled-back",
          restoredRuntimeId: null,
          restoredSpecHash: null,
          heldWorkloadRemoved: true,
          alreadyRolledBack: false,
          finalizedAt: "2026-08-04T12:00:00.000Z",
        };
      },
      async discoverHeldWorkload(input) {
        return { sandbox: input.sandbox, runtimeId, bootstrapIdentity: input.bootstrapIdentity };
      },
      async inspectHeldWorkload({ handle, discovered }) {
        return {
          schemaVersion: 1,
          sandbox: handle.sandbox,
          runtimeId: discovered.runtimeId,
          bootstrapIdentity: handle.bootstrapIdentity,
          image: handle.plan.image,
          runtimeImageContentId,
          specHash: originalSpecHash,
          specCanonicalJson: originalSpecCanonicalJson,
          agentIdentity: handle.plan.agentIdentity,
          supervisorArgv: handle.plan.expectedSupervisorArgv,
          heldWorkloadArgv: handle.heldWorkloadArgv,
          metadata: handle.plan.metadata,
        };
      },
      async prepareBootstrapReplacement({ handle, snapshot, request }) {
        return {
          schemaVersion: 1,
          sandbox: handle.sandbox,
          bootstrapIdentity: handle.bootstrapIdentity,
          originalRuntimeId: snapshot.runtimeId,
          preparedRuntimeId: replacementRuntimeId,
          image: handle.plan.image,
          runtimeImageContentId,
          originalSpecHash,
          preparedSpecHash,
          preparedSpecCanonicalJson,
          expectedActivatedSpecHash: replacementSpecHash,
          expectedActivatedSpecCanonicalJson: replacementSpecCanonicalJson,
          profileFingerprint: request.profileFingerprint,
          rollbackAuthority: "test-managed-onboard-rollback-authority",
        };
      },
      async activateBootstrapReplacement({ handle, prepared }) {
        return {
          schemaVersion: 1,
          sandbox: handle.sandbox,
          bootstrapIdentity: handle.bootstrapIdentity,
          originalRuntimeId: prepared.originalRuntimeId,
          replacementRuntimeId: prepared.preparedRuntimeId,
          image: prepared.image,
          runtimeImageContentId: prepared.runtimeImageContentId,
          originalSpecHash: prepared.originalSpecHash,
          replacementSpecHash,
          replacementSpecCanonicalJson,
          profileFingerprint: prepared.profileFingerprint,
        };
      },
      async awaitBootstrap({ handle, replacement }) {
        return {
          schemaVersion: 1,
          sandbox: handle.sandbox,
          runtimeId: replacement.replacementRuntimeId,
          image: handle.plan.image,
          runtimeImageContentId,
          originalSpecHash,
          replacementSpecHash,
          profileFingerprint: handle.plan.profile.fingerprint,
          bootstrapIdentity: handle.bootstrapIdentity,
          transactionPending: true,
          completedAt: "2026-07-29T12:01:00.000Z",
        };
      },
      async finalizeBootstrap({ outcome, handle, snapshot }) {
        return {
          schemaVersion: 1,
          sandbox: handle.sandbox,
          bootstrapIdentity: handle.bootstrapIdentity,
          outcome: outcome === "commit" ? "committed" : "rolled-back",
          restoredRuntimeId: outcome === "rollback" ? (snapshot?.runtimeId ?? null) : null,
          restoredSpecHash: outcome === "rollback" ? (snapshot?.specHash ?? null) : null,
          heldWorkloadRemoved: false,
          alreadyRolledBack: false,
          finalizedAt: "2026-07-29T12:02:00.000Z",
        };
      },
    };
  };
}

if (process.env.NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG === "1") {
  mockManagedImageCatalog();
  mockManagedImageBootstrap();
}

module.exports = {
  installForwardServiceReachabilityFixture,
  mockEndpointlessProviderProfileRun,
  mockManagedEndpointlessProviderProfileRun,
  mockManagedProviderPreparationRun,
  mockNvidiaProviderGetRun,
  mockNvidiaOrMissingProviderGetRun,
  mockProviderPreparationRun,
  createStatefulMessagingProviderRunner,
  isOpenClawSecurityInventoryProbe,
  mockDockerSandboxLifecycleReleaseFromRunner,
  mockFreshOpenClawPluginDiscovery,
  createCreatedSandboxFixture,
  mockStructuredOpenShellCaptureFromRunner,
  installVerifiedSandboxCreateFixture,
  sandboxLifecycleFixture,
  mockOnboardRunCapture,
  mockStandaloneGatewayTeardownAuthority,
  normalizeCommand,
  sandboxCreateArgsWithVerifiedReservation,
};
