// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { parseSingleNpmPackResult } from "../helpers/npm-pack-result";
import { createInstallerCheckout } from "../helpers/installer-run-fixture";
import { TEST_SYSTEM_PATH, writeExecutable } from "../helpers/installer-sourced-env";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "../..");
const INSTALLER = path.join(REPOSITORY_ROOT, "install.sh");
const SDK_NAME = "@nvidia/openshell-sdk";
const PUBLIC_DEPENDENCIES = [
  "@bufbuild/protobuf",
  "@connectrpc/connect",
  "@connectrpc/connect-node",
];

function packPublicDependency(
  name: string,
  root: string,
  npmEnvironment: NodeJS.ProcessEnv,
  sourceLock: { packages: Record<string, unknown> },
): [string, unknown] {
  const packed = spawnSync(
    "npm",
    [
      "pack",
      path.join(REPOSITORY_ROOT, "node_modules", name),
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      root,
    ],
    { encoding: "utf8", env: npmEnvironment },
  );
  expect(packed.status, packed.stderr).toBe(0);
  const result = parseSingleNpmPackResult(packed.stdout);
  expect(result.filename).toBeTruthy();
  expect(result.integrity).toBeTruthy();
  return [
    `node_modules/${name}`,
    {
      ...(sourceLock.packages[`node_modules/${name}`] as Record<string, unknown>),
      resolved: `file:${path.join(root, result.filename!)}`,
      integrity: result.integrity,
    },
  ];
}

it(
  "source installer prepares and loads the vendored OpenShell SDK before build (#11921)",
  { timeout: 120_000 },
  () => {
    const checkout = createInstallerCheckout("nemoclaw-install-sdk-handoff-");
    onTestFinished(() => checkout.remove());
    const { root, binDir, prefixDir } = checkout;
    const cache = path.join(root, "npm-cache");
    const userConfig = path.join(root, "empty.npmrc");
    const globalConfig = path.join(root, "empty-global.npmrc");
    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== "INIT_CWD" && !key.toLowerCase().startsWith("npm_config_"),
      ),
    );
    const npmEnvironment = {
      ...inheritedEnvironment,
      HOME: root,
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_OFFLINE: "true",
      NPM_CONFIG_PREFIX: prefixDir,
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      NPM_CONFIG_USERCONFIG: userConfig,
    };
    fs.writeFileSync(userConfig, "");
    fs.writeFileSync(globalConfig, "");

    const sourceManifest = JSON.parse(
      fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
    );
    const sourceLock = JSON.parse(
      fs.readFileSync(path.join(REPOSITORY_ROOT, "package-lock.json"), "utf8"),
    );
    const manifest = {
      name: "nemoclaw",
      version: "1.0.0",
      bin: { nemoclaw: "bin/nemoclaw.js", nemohermes: "bin/nemoclaw.js" },
      bundleDependencies: [SDK_NAME],
      optionalDependencies: Object.fromEntries(
        [SDK_NAME, ...PUBLIC_DEPENDENCIES].map((name) => [
          name,
          sourceManifest.optionalDependencies[name],
        ]),
      ),
      scripts: { "build:cli": "node scripts/assert-sdk-before-build.mjs" },
    };
    const packages: Record<string, unknown> = {
      "": manifest,
      [`node_modules/${SDK_NAME}`]: sourceLock.packages[`node_modules/${SDK_NAME}`],
    };
    Object.assign(
      packages,
      Object.fromEntries([
        packPublicDependency(PUBLIC_DEPENDENCIES[0], root, npmEnvironment, sourceLock),
        packPublicDependency(PUBLIC_DEPENDENCIES[1], root, npmEnvironment, sourceLock),
        packPublicDependency(PUBLIC_DEPENDENCIES[2], root, npmEnvironment, sourceLock),
      ]),
    );

    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "ci"));
    fs.mkdirSync(path.join(root, "agents", "hermes"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "agents", "hermes", "manifest.yaml"),
      "deferred_onboarding: true\n",
    );
    fs.copyFileSync(
      path.join(REPOSITORY_ROOT, "ci", "reviewed-npm-audit.json"),
      path.join(root, "ci", "reviewed-npm-audit.json"),
    );
    fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
    fs.cpSync(
      path.join(REPOSITORY_ROOT, "scripts", "vendor", "openshell-sdk"),
      path.join(root, "scripts", "vendor", "openshell-sdk"),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(REPOSITORY_ROOT, "scripts", "lib", "openshell-sdk-install.mts"),
      path.join(root, "scripts", "lib", "openshell-sdk-install.mts"),
    );
    fs.copyFileSync(
      path.join(REPOSITORY_ROOT, "scripts", "lib", "reviewed-npm-archive.mts"),
      path.join(root, "scripts", "lib", "reviewed-npm-archive.mts"),
    );
    fs.copyFileSync(
      path.join(REPOSITORY_ROOT, "scripts", "lib", "reviewed-npm-cache.mts"),
      path.join(root, "scripts", "lib", "reviewed-npm-cache.mts"),
    );
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
    fs.writeFileSync(
      path.join(root, "scripts", "assert-sdk-before-build.mjs"),
      `import fs from "node:fs";
const { OpenShellClient } = await import("@nvidia/openshell-sdk");
const { SandboxPolicySchema } = await import("@nvidia/openshell-sdk/raw");
if (typeof OpenShellClient.connect !== "function" || !SandboxPolicySchema) process.exit(1);
fs.writeFileSync("build-saw-sdk", "yes");
`,
    );
    writeExecutable(
      path.join(root, "bin", "nemoclaw.js"),
      `#!/usr/bin/env bash
name="$(basename "$0")"
case "\${1:-}:\${2:-}:\${3:-}" in
  internal:installer:plan) printf 'defer\\n'; exit 0 ;;
esac
if [ "\${1:-}" = "--version" ]; then echo "\${name} v1.0.0"; fi
exit 0
`,
    );
    const pluginManifest = {
      name: "nemoclaw-plugin",
      version: "1.0.0",
      scripts: { build: 'node -e "process.exit(0)"' },
    };
    fs.mkdirSync(path.join(root, "nemoclaw"));
    fs.writeFileSync(path.join(root, "nemoclaw", "package.json"), JSON.stringify(pluginManifest));
    fs.writeFileSync(
      path.join(root, "nemoclaw", "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": pluginManifest } }),
    );

    writeExecutable(path.join(binDir, "git"), "#!/usr/bin/env bash\nexit 90\n");
    writeExecutable(
      path.join(binDir, "docker"),
      `#!/usr/bin/env bash
if [ "\${1:-}" = "info" ]; then
  echo '{"ServerVersion":"29.3.1","Name":"Docker Desktop","OperatingSystem":"Ubuntu 24.04","CgroupVersion":"2"}'
fi
exit 0
`,
    );
    writeExecutable(
      path.join(binDir, "openshell"),
      `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ] || [ "\${1:-}" = "version" ]; then
  echo "openshell 0.0.116"
fi
exit 0
`,
    );
    writeExecutable(
      path.join(binDir, "curl"),
      "#!/usr/bin/env bash\necho 'unexpected network request' >&2\nexit 99\n",
    );

    const result = spawnSync("bash", [INSTALLER], {
      cwd: root,
      encoding: "utf8",
      timeout: 90_000,
      killSignal: "SIGKILL",
      env: {
        ...npmEnvironment,
        PATH: `${path.dirname(process.execPath)}:${binDir}:${TEST_SYSTEM_PATH}`,
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_AGENT: "hermes",
        NEMOCLAW_DEFER_ONBOARDING: "1",
        NEMOCLAW_DEFER_OPENSHELL_INSTALL: "1",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_REPO_ROOT: root,
        NPM_PREFIX: prefixDir,
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain("OpenShell SDK 0.0.116: verified archive prepared");
    expect(output).toContain("OpenShell SDK 0.0.116: import OK");
    expect(fs.readFileSync(path.join(root, "build-saw-sdk"), "utf8")).toBe("yes");
  },
);
