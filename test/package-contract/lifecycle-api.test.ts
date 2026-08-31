// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createPackageFixture } from "./helpers/package-fixture";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");

function commandOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function assertCommandSucceeded(result: SpawnSyncReturns<string>, label: string): void {
  expect(result.status, `${label} failed:\n${commandOutput(result)}`).toBe(0);
}

function npmEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

function consumerEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    OPENSHELL_GATEWAY: "private-endpoint-sentinel",
    OPENSHELL_PROFILE: "private-profile-sentinel",
    OPENSHELL_TOKEN: "private-credential-sentinel",
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
  };
}

describe("packaged lifecycle API", () => {
  it(
    "installs the packed Hermes lifecycle export with declarations and no transport dependency (#10613)",
    { timeout: 120_000 },
    () => {
      const fixtureRoot = createPackageFixture({
        prefix: "nemoclaw-lifecycle-package-",
        entries: ["dist", "nemoclaw/dist"],
        omitRuntimeDependencies: true,
      });
      const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-archive-"));
      const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-consumer-"));
      const consumerHome = path.join(consumerRoot, "home");

      try {
        const pack = spawnSync(
          "npm",
          ["pack", "--ignore-scripts", "--silent", "--pack-destination", archiveRoot],
          { cwd: fixtureRoot, encoding: "utf8", env: npmEnvironment() },
        );
        assertCommandSucceeded(pack, "package archive creation");
        const archives = fs.readdirSync(archiveRoot).filter((entry) => entry.endsWith(".tgz"));
        expect(archives).toHaveLength(1);

        fs.mkdirSync(path.join(consumerHome, ".config", "openshell"), { recursive: true });
        fs.writeFileSync(
          path.join(consumerHome, ".config", "openshell", "profile.yaml"),
          "token: private-profile-file-sentinel\n",
        );
        fs.writeFileSync(
          path.join(consumerRoot, "package.json"),
          JSON.stringify({ name: "lifecycle-consumer", private: true }),
        );
        const install = spawnSync(
          "npm",
          [
            "install",
            "--ignore-scripts",
            "--no-package-lock",
            "--no-save",
            "--offline",
            path.join(archiveRoot, archives[0]!),
          ],
          { cwd: consumerRoot, encoding: "utf8", env: npmEnvironment() },
        );
        assertCommandSucceeded(install, "packed artifact installation");

        const installedPackage = path.join(consumerRoot, "node_modules", "nemoclaw");
        expect(fs.existsSync(path.join(installedPackage, "dist/lifecycle/index.js"))).toBe(true);
        expect(fs.existsSync(path.join(installedPackage, "dist/lifecycle/index.d.ts"))).toBe(true);
        expect(fs.existsSync(path.join(installedPackage, "dist/lifecycle/index.d.ts.map"))).toBe(
          true,
        );

        const probe = String.raw`
const Module = require("node:module");
const writeError = process.stderr.write.bind(process.stderr);
const writeOutput = process.stdout.write.bind(process.stdout);
const originalEnvironment = process.env;
const allowedEnvironmentReads = new Set(["NODE_V8_COVERAGE"]);
globalThis.fetch = () => {
  throw new Error("network access is forbidden");
};
globalThis.prompt = () => {
  throw new Error("prompt access is forbidden");
};
process.exit = () => {
  throw new Error("process exit is forbidden");
};
process.getBuiltinModule = () => {
  throw new Error("builtin module access is forbidden");
};
for (const stream of ["stdin", "stdout", "stderr"]) {
  Object.defineProperty(process, stream, {
    configurable: true,
    get() {
      throw new Error("terminal access is forbidden");
    },
  });
}
process.env = new Proxy(originalEnvironment, {
  get(target, property) {
    if (!allowedEnvironmentReads.has(String(property))) {
      throw new Error("environment access is forbidden");
    }
    return Reflect.get(target, property, target);
  },
  getOwnPropertyDescriptor() {
    throw new Error("environment access is forbidden");
  },
  has() {
    throw new Error("environment access is forbidden");
  },
  ownKeys() {
    throw new Error("environment access is forbidden");
  },
});
const allowedModuleRequests = new Set([
  "nemoclaw/lifecycle",
  "../lib/actions/lifecycle/observe-hermes",
  "../lib/domain/lifecycle/contract",
  "../lib/domain/lifecycle/hermes-definition",
  "../lib/domain/lifecycle/hermes-plan",
  "../../domain/lifecycle/contract",
  "../../domain/lifecycle/hermes-definition",
  "../../domain/lifecycle/hermes-plan",
  "../../sandbox-name-contract",
  "../../nemoclaw/dist/shared/sandbox-name.cjs",
  "./contract",
  "./hermes-definition",
  "./name-validation",
]);
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (!allowedModuleRequests.has(request)) {
    throw new Error("module access is forbidden");
  }
  return originalLoad.call(this, request, parent, isMain);
};
const lifecycle = require("nemoclaw/lifecycle");
const digest = (character) => "sha256:" + character.repeat(64);
const request = {
  apiVersion: lifecycle.NEMOCLAW_LIFECYCLE_API_VERSION,
  target: {
    gatewayIdentity: digest("1"),
    workspace: "hermes-workspace",
    openshellVersion: lifecycle.HERMES_LIFECYCLE_DEFINITION.openshellVersion,
  },
  sandbox: {
    name: "hermes-agent",
    resourceIdentity: digest("2"),
    imageDigest: digest("3"),
    configurationFingerprint: digest("4"),
  },
};
void (async () => {
  const plan = lifecycle.planHermesLifecycle(request);
  const observation = await lifecycle.observeHermesLifecycle(
    { plan: request },
    {
      async observeHermesAgent(observationRequest) {
        if (
          observationRequest.sandboxName !== "hermes-agent" ||
          observationRequest.resourceIdentity !== digest("2")
        ) {
          throw new Error("unexpected observation request");
        }
        return {
          ok: true,
          value: {
            state: "present",
            target: {
              gatewayIdentity: digest("1"),
              workspace: "hermes-workspace",
              openshellVersion: "0.0.106",
            },
            sandbox: {
              name: "hermes-agent",
              resourceIdentity: digest("2"),
              imageDigest: digest("3"),
              phase: "Ready",
            },
            agent: {
              name: "hermes",
              version: "0.19.0",
              configurationFingerprint: digest("4"),
              health: { state: "reachable", statusCode: 200 },
            },
          },
        };
      },
    },
  );
  writeOutput(
    JSON.stringify({ exportKeys: Object.keys(lifecycle).sort(), observation, plan }),
  );
})().catch((error) => {
  writeError(String(error));
  process.exitCode = 1;
});
`;
        const runtime = spawnSync(process.execPath, ["--eval", probe], {
          cwd: consumerRoot,
          encoding: "utf8",
          env: consumerEnvironment(consumerHome),
        });
        assertCommandSucceeded(runtime, "CommonJS consumer import");
        expect(runtime.stdout).not.toContain("private-");
        expect(runtime.stderr).not.toContain("private-");
        const runtimeEvidence = JSON.parse(runtime.stdout) as {
          exportKeys: string[];
          observation: { ok: boolean; value?: { readiness?: string } };
          plan: { ok: boolean; value?: { agent?: { name?: string } } };
        };
        expect(runtimeEvidence.exportKeys).toEqual([
          "HERMES_LIFECYCLE_DEFINITION",
          "NEMOCLAW_LIFECYCLE_API_VERSION",
          "observeHermesLifecycle",
          "planHermesLifecycle",
        ]);
        expect(runtimeEvidence.plan).toMatchObject({
          ok: true,
          value: { agent: { name: "hermes" } },
        });
        expect(runtimeEvidence.observation).toMatchObject({
          ok: true,
          value: { readiness: "ready" },
        });
        const moduleConsumer = String.raw`
const lifecycle = await import("nemoclaw/lifecycle");
process.stdout.write(lifecycle.HERMES_LIFECYCLE_DEFINITION.agent);
`;
        const moduleImport = spawnSync(
          process.execPath,
          ["--input-type=module", "--eval", moduleConsumer],
          {
            cwd: consumerRoot,
            encoding: "utf8",
            env: consumerEnvironment(consumerHome),
          },
        );
        assertCommandSucceeded(moduleImport, "ES module consumer import");
        expect(moduleImport.stdout).toBe("hermes");

        const typeConsumer = path.join(consumerRoot, "consumer.ts");
        fs.writeFileSync(
          typeConsumer,
          String.raw`
import {
  HERMES_LIFECYCLE_DEFINITION,
  NEMOCLAW_LIFECYCLE_API_VERSION,
  observeHermesLifecycle,
  planHermesLifecycle,
  type HermesLifecyclePlanRequest,
  type LifecycleDigest,
  type OpenShellHermesAgentObserver,
} from "nemoclaw/lifecycle";

const digest = (character: string): LifecycleDigest =>
  ("sha256:" + character.repeat(64)) as LifecycleDigest;
const request: HermesLifecyclePlanRequest = {
  apiVersion: NEMOCLAW_LIFECYCLE_API_VERSION,
  target: {
    gatewayIdentity: digest("1"),
    workspace: "hermes-workspace",
    openshellVersion: HERMES_LIFECYCLE_DEFINITION.openshellVersion,
  },
  sandbox: {
    name: "hermes-agent",
    resourceIdentity: digest("2"),
    imageDigest: digest("3"),
    configurationFingerprint: digest("4"),
  },
};
const observer: OpenShellHermesAgentObserver = {
  async observeHermesAgent() {
    return {
      ok: true,
      value: {
        state: "present",
        target: {
          gatewayIdentity: digest("1"),
          workspace: "hermes-workspace",
          openshellVersion: "0.0.106",
        },
        sandbox: {
          name: "hermes-agent",
          resourceIdentity: digest("2"),
          imageDigest: digest("3"),
          phase: "Ready",
        },
        agent: {
          name: "hermes",
          version: "0.19.0",
          configurationFingerprint: digest("4"),
          health: { state: "reachable", statusCode: 200 },
        },
      },
    };
  },
};
planHermesLifecycle(request);
void observeHermesLifecycle({ plan: request }, observer);
`,
        );
        const typecheck = spawnSync(
          path.join(REPOSITORY_ROOT, "node_modules", ".bin", "tsc"),
          [
            "--noEmit",
            "--strict",
            "--skipLibCheck",
            "--target",
            "ES2022",
            "--module",
            "Node16",
            "--moduleResolution",
            "Node16",
            typeConsumer,
          ],
          {
            cwd: consumerRoot,
            encoding: "utf8",
            env: consumerEnvironment(consumerHome),
          },
        );
        assertCommandSucceeded(typecheck, "TypeScript consumer declaration check");

        expect(
          execFileSync(process.execPath, ["--eval", "require.resolve('nemoclaw/package.json')"], {
            cwd: consumerRoot,
            encoding: "utf8",
            env: consumerEnvironment(consumerHome),
          }),
        ).toBe("");
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        fs.rmSync(archiveRoot, { recursive: true, force: true });
        fs.rmSync(consumerRoot, { recursive: true, force: true });
      }
    },
  );
});
