// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";

import type { CuaRuntimeReadiness } from "../../src/lib/cua/contract";
import { parseCuaProviderAuthorityDigest } from "../../src/lib/cua/lifecycle-readiness";
import {
  type CuaTargetArtifactBindings,
  getCuaTargetArtifactBindings,
} from "../../src/lib/cua/runtime-manifest";
import {
  buildCurrentCuaRuntimeReadiness,
  getCuaInferenceRouteIdentity,
} from "../../src/lib/cua/runtime-readiness";
import { createCuaRuntimeTestFixture } from "../../src/lib/cua/runtime-test-fixture";

const PROVIDER = "nvidia";
const MODEL = "nvidia/nemotron-3-super-120b-a12b";

const providerOutput = [
  "Provider:",
  "  Id: cua-cli-fixture-provider",
  `  Name: ${PROVIDER}`,
  "  Type: openai",
  "  Resource version: 1",
  "  Credential keys: NVIDIA_API_KEY",
  "  Config keys: OPENAI_BASE_URL",
].join("\n");

export interface CuaCliRuntimeFixture {
  root: string;
  env: NodeJS.ProcessEnv;
  readiness: CuaRuntimeReadiness;
  route: { provider: string; model: string };
  targetBindings: CuaTargetArtifactBindings;
  adapterPaths: { target: string; task: string; security: string };
}

/** Build one qualified public-CLI fixture bound to the checkout's exact current revision. */
export function createCuaCliRuntimeFixture(
  repositoryRoot: string,
  input: {
    targetAdapterContents?: string;
    taskAdapterContents?: string;
    securityAdapterContents?: string;
  } = {},
): CuaCliRuntimeFixture {
  const sourceRevision = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const route = { provider: PROVIDER, model: MODEL };
  const routeDigest = getCuaInferenceRouteIdentity(route).routeDigest;
  const openshellContents = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "inference" && args[1] === "get") {
  process.stdout.write(${JSON.stringify(`Gateway inference:\n  Provider: ${PROVIDER}\n  Model: ${MODEL}\n`)});
  process.exit(0);
}
if (args[0] === "provider" && args[1] === "get") {
  process.stdout.write(${JSON.stringify(`${providerOutput}\n`)});
  process.exit(0);
}
if (args[0] === "policy" && args[1] === "get" && args[2]) {
  process.stdout.write(JSON.stringify({
    active_version: 17,
    config_revision: 23,
    hash: "sha256:${"a".repeat(64)}",
    policy_source: "sandbox",
    sandbox: args[2],
    status: "effective",
    version: 17,
  }));
  process.exit(0);
}
process.stderr.write("unsupported OpenShell fixture command\\n");
process.exit(1);
`;
  const runtime = createCuaRuntimeTestFixture({
    qualified: true,
    routeDigest,
    openshellContents,
    ...input,
  });
  runtime.rewriteManifest((manifest) => {
    const compatibility = manifest.compatibility as Record<string, unknown>;
    compatibility.finalSourceRevision = sourceRevision;
  });

  const openshellPath = runtime.openshellPath;
  const providerAuthorityDigest = parseCuaProviderAuthorityDigest({
    gatewayName: "nemoclaw",
    providerName: PROVIDER,
    model: MODEL,
    output: providerOutput,
  });
  const env = {
    ...runtime.env,
    NEMOCLAW_OPENSHELL_BIN: openshellPath,
  };
  const readiness = buildCurrentCuaRuntimeReadiness({
    agentName: "nemocua",
    recordedInference: route,
    liveInference: route,
    liveProviderAuthorityDigest: providerAuthorityDigest,
    env,
    buildIdentity: { schemaVersion: 1, sourceRevision, sourceClean: true },
  });
  return {
    root: runtime.root,
    env,
    readiness,
    route,
    targetBindings: getCuaTargetArtifactBindings(env),
    adapterPaths: {
      target: path.join(runtime.root, runtime.manifest.artifacts.adapters.target.filename),
      task: path.join(runtime.root, runtime.manifest.artifacts.adapters.task.filename),
      security: path.join(runtime.root, runtime.manifest.artifacts.adapters.security.filename),
    },
  };
}
