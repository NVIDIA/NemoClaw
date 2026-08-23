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

function createStatefulMessagingProviderRunner({
  commands,
  initialProviders = [],
  readySandboxName = null,
}) {
  const providers = new Map(
    initialProviders.map(([name, type, credential]) => [name, { type, credential }]),
  );
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
      const fileIndex = args.indexOf("--file");
      return profileAction === "import" && fileIndex >= 0 && args[fileIndex + 1]
        ? { status: 0 }
        : { status: 1, stderr: "unsupported provider profile command" };
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
  const run = runner.run;
  let lifecycleReleased = false;
  runner.run = (command, options) => {
    const normalized = normalizeCommand(command);
    if (normalized.startsWith("docker rm ")) lifecycleReleased = true;
    if (lifecycleReleased && normalized.includes("sandbox list")) {
      return {
        status: 0,
        stdout: Buffer.from("No sandboxes found\n"),
        stderr: Buffer.alloc(0),
      };
    }
    return run(command, options);
  };
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

  const dockerProvider = require(
    path.resolve(__dirname, "../../src/lib/onboard/runtime-provider/docker.ts"),
  );
  const createDockerRuntimeProviderBundle = dockerProvider.createDockerRuntimeProviderBundle;
  dockerProvider.createDockerRuntimeProviderBundle = (...args) => {
    const bundle = createDockerRuntimeProviderBundle(...args);
    return {
      ...bundle,
      workload: {
        ...bundle.workload,
        profile: {
          ...bundle.workload.profile,
          managedImageSelectionPolicy: "prefer-managed",
        },
      },
    };
  };
}

process.env.NEMOCLAW_TEST_MANAGED_IMAGE_FALLBACK === "1" && mockManagedImageFallback();

module.exports = {
  createStatefulMessagingProviderRunner,
  isOpenClawSecurityInventoryProbe,
  mockDockerSandboxLifecycleReleaseFromRunner,
  mockManagedImageFallback,
  mockOnboardRunCapture,
  mockSandboxExecCurl,
  mockStandaloneGatewayTeardownAuthority,
  normalizeCommand,
};
