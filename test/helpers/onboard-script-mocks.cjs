// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Node's --require preload cannot execute TypeScript directly. Reuse this
// existing CommonJS test boundary as the minimal bootstrap for the typed
// source loader; the codebase growth guard prevents adding another JS file.
const path = require("node:path");

function registerSourceRequire() {
  const fs = require("node:fs");
  const Module = require("node:module");
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

// Vitest setup files and NODE_OPTIONS preloads both depend on this hook.
registerSourceRequire();

function normalizeCommand(command) {
  return (Array.isArray(command) ? command.join(" ") : String(command)).replace(/'/g, "");
}

function providerNameAfterAction(args, providerIndex) {
  const firstArgument = providerIndex + 2;
  return args[firstArgument] === "-g" ? args[firstArgument + 2] : args[firstArgument];
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

function createStatefulMessagingProviderRunner({
  commands,
  initialProviders = [],
  readySandboxName = null,
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

    const providerAction = providerIndex >= 0 ? args[providerIndex + 1] : null;
    if (providerAction === "profile") {
      const profileActionIndex = providerIndex + 2;
      const profileAction =
        args[profileActionIndex] === "-g"
          ? args[profileActionIndex + 2]
          : args[profileActionIndex];
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
    if (
      readySandboxName &&
      args.includes("sandbox") &&
      args.includes("get") &&
      args.includes(readySandboxName)
    ) {
      return {
        status: 0,
        stdout: Buffer.from(`Name: ${readySandboxName}\nId: sbx-4f2a91c0d7\n`),
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
  `printf '%s\\n' "architecture=$arch" "libexpat1=2.8.3-1" "libonig5=6.9.9-1+b1" "libjq1=1.8.2-1" "jq=1.8.2-1" "vim-common=2:9.2.0858-1" "vim-tiny=2:9.2.0858-1" "libssh2-1t64=1.11.1-1+deb13u1+nemoclaw2" "nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1" "perl-base=5.44.0-1nemoclaw1" "perl=5.44.0-1nemoclaw1" | cmp -s - "$security_inventory"`,
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
  const matches = (
    dockerArgs.length === 14 &&
    OPENCLAW_SECURITY_INVENTORY_PROBE_PREFIX.every(
      (expected, index) => dockerArgs[index] === expected,
    ) &&
    dockerArgs[11].length > 0 &&
    dockerArgs[12] === "-c" &&
    dockerArgs[13] === OPENCLAW_SECURITY_INVENTORY_PROBE
  );
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
  if (
    normalized ===
    `docker inspect --type container ${ONBOARD_SANDBOX_OLD_CONTAINER_ID}`
  ) {
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

function mockStructuredOpenShellCaptureFromRunner() {
  const runner = require(path.resolve(__dirname, "../../src/lib/runner.ts"));
  const client = require(
    path.resolve(__dirname, "../../src/lib/adapters/openshell/client.ts"),
  );
  client.captureOpenshellCommand = (binary, args, options = {}) => {
    const stdout = String(
      runner.runCapture([binary, ...args], {
        ...options,
        ignoreError: true,
        includeStderr: false,
      }) || "",
    );
    const isSandboxGet = args[0] === "sandbox" && args[1] === "get";
    if (isSandboxGet && stdout.trim().length === 0) {
      const sandboxName = String(args.at(-1) || "unknown");
      const stderr = `Error: sandbox ${sandboxName} not found\n`;
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
  if (runner.run.__nemoclawDockerLifecycleFixture === true) return;
  const run = runner.run;
  let finalCommitReleased = false;
  let lifecycleReleased = false;
  const wrappedRun = (command, options) => {
    const normalized = normalizeCommand(command);
    if (
      finalCommitReleased &&
      normalized.startsWith("docker ps -a --no-trunc ") &&
      normalized.includes("label=openshell.ai/sandbox-name=my-assistant") &&
      normalized.endsWith("--format {{.ID}}")
    ) {
      return {
        status: 0,
        stdout: Buffer.from(`${ONBOARD_SANDBOX_NEW_CONTAINER_ID}\n`),
        stderr: Buffer.alloc(0),
      };
    }
    if (
      finalCommitReleased &&
      normalized ===
        `docker inspect --type container --format {{json .State.Running}} ${ONBOARD_SANDBOX_NEW_CONTAINER_ID}`
    ) {
      return {
        status: 0,
        stdout: Buffer.from("true\n"),
        stderr: Buffer.alloc(0),
      };
    }
    if (lifecycleReleased && normalized.includes("sandbox list")) {
      return {
        status: 0,
        stdout: Buffer.from("No sandboxes found\n"),
        stderr: Buffer.alloc(0),
      };
    }
    const result = run(command, options);
    if (normalized.startsWith("docker rm ") && result?.status === 0) {
      lifecycleReleased = true;
      if (normalized === `docker rm ${ONBOARD_SANDBOX_OLD_CONTAINER_ID}`) {
        finalCommitReleased = true;
      }
    }
    return result;
  };
  wrappedRun.__nemoclawDockerLifecycleFixture = true;
  runner.run = wrappedRun;
}

function mockManagedImageFallback() {
  const catalog = require(
    path.resolve(__dirname, "../../src/lib/onboard/managed-image/catalog.ts"),
  );
  catalog.resolveManagedImageCatalogFromGhcr = async () => {
    throw new catalog.ManagedImageCatalogUnavailableError(
      "integration fixture intentionally exercises the trusted Dockerfile fallback",
    );
  };
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
              revision: "a".repeat(40),
              release,
              cohort: "ghrun-9068-1",
            },
            startupProfileContractVersion:
              contract.MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
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
    path.resolve(
      __dirname,
      "../../src/lib/onboard/managed-bootstrap/docker-authority-store.ts",
    ),
  );
  const sandboxIdentity = require(
    path.resolve(__dirname, "../../src/lib/adapters/openshell/sandbox-identity.ts"),
  );

  sandboxIdentity.resolveOpenShellSandboxId = () => "sbx-managed-fixture";
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

process.env.NEMOCLAW_TEST_MANAGED_IMAGE_FALLBACK === "1" && mockManagedImageFallback();
if (process.env.NEMOCLAW_TEST_MANAGED_IMAGE_CATALOG === "1") {
  mockManagedImageCatalog();
  mockManagedImageBootstrap();
}

module.exports = {
  mockEndpointlessProviderProfileRun,
  mockManagedEndpointlessProviderProfileRun,
  createStatefulMessagingProviderRunner,
  isOpenClawSecurityInventoryProbe,
  mockDockerSandboxLifecycleReleaseFromRunner,
  mockFreshOpenClawPluginDiscovery,
  mockOnboardRunCapture,
  mockStandaloneGatewayTeardownAuthority,
  normalizeCommand,
};
