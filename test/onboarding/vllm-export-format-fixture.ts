// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import {
  observeManagedVllmForExport,
  type VllmExportRuntimeOptions,
} from "../../src/lib/inference/serving/vllm-export-runtime";
import { EXPORTED_VLLM_PROFILE_ID, EXPORTED_VLLM_RECIPE_ID } from "../../src/lib/config/model";
import {
  loadManagedInferenceCatalog,
  loadServingCatalog,
} from "../../src/lib/inference/serving/catalog-loader";
import { isHostLocalInferenceServingRecipe } from "../../src/lib/inference/serving/adapter-registry";
import { servingProfileProvenance } from "../../src/lib/inference/serving/profile-provenance";
import { materializeHostLocalVllmModel } from "../../src/lib/inference/serving/host-local-vllm-selection";
import { buildVllmServeCommand } from "../../src/lib/inference/vllm-models";
import * as lifecycle from "../../src/lib/inference/serving/vllm-host-local-lifecycle";
import { runtimeAuthFingerprint } from "../../src/lib/inference/serving/runtime-auth-fingerprint";

export function vllmExportFormatFixture(directory: string) {
  const provenance = servingProfileProvenance(loadServingCatalog(), EXPORTED_VLLM_PROFILE_ID);
  const recipe = loadManagedInferenceCatalog().recipes.find(
    ({ metadata }) => metadata.id === EXPORTED_VLLM_RECIPE_ID,
  );
  if (!recipe || !isHostLocalInferenceServingRecipe(recipe) || !recipe.spec.serve.directInstall)
    throw new Error("Fixture requires the fixed host-local recipe");
  const model = materializeHostLocalVllmModel(recipe, recipe.spec.serve.directInstall, "linux");
  const { runtime } = recipe.spec;
  const key = "e".repeat(64);
  const fingerprint = runtimeAuthFingerprint(key);
  const containerId = "a".repeat(64);
  const imageId = `sha256:${"b".repeat(64)}`;
  const labels = {
    [lifecycle.HOST_LOCAL_VLLM_AUTH_LABEL]: fingerprint,
    [lifecycle.HOST_LOCAL_VLLM_MANAGED_LABEL]: "true",
    [lifecycle.HOST_LOCAL_VLLM_CATALOG_LABEL]: provenance.catalogDigest,
    [lifecycle.HOST_LOCAL_VLLM_PRESET_LABEL]: provenance.preset.id,
    [lifecycle.HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL]: provenance.preset.digest,
    [lifecycle.HOST_LOCAL_VLLM_RECIPE_LABEL]: provenance.recipe.id,
    [lifecycle.HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL]: provenance.recipe.digest,
  };
  lifecycle.persistHostLocalVllmRuntimeReceipt(
    {
      containerId,
      authFingerprint: fingerprint,
      serving: {
        catalogDigest: provenance.catalogDigest,
        presetId: provenance.preset.id,
        presetDigest: provenance.preset.digest,
        recipeId: provenance.recipe.id,
        recipeDigest: provenance.recipe.digest,
      },
    },
    directory,
  );
  return {
    provenance,
    key,
    fingerprint,
    objects: {
      image: {
        Id: imageId,
        Os: "linux",
        Architecture: "amd64",
        Config: { Env: ["PATH=/usr/bin"] },
      },
      network: {
        Id: "c".repeat(64),
        Name: "openshell-docker",
        Driver: "bridge",
        IPAM: { Config: [{ Gateway: "172.18.0.1", Subnet: "172.18.0.0/16" }] },
      },
      container: {
        Id: containerId,
        Name: "/nemoclaw-vllm",
        Image: imageId,
        State: { Running: true, StartedAt: "2026-09-10T10:00:00Z" },
        Config: {
          Image: provenance.runtimeImage,
          Cmd: ["-lc", buildVllmServeCommand(model, {})],
          Entrypoint: ["/bin/bash"],
          Env: ["PATH=/usr/bin", `VLLM_API_KEY=${key}`],
          Labels: labels,
        },
        HostConfig: {
          NetworkMode: "bridge",
          IpcMode: runtime.ipcMode,
          ShmSize: runtime.sharedMemoryBytes,
          RestartPolicy: { Name: "unless-stopped" },
          Init: true,
          Privileged: false,
          Devices: [],
          CapAdd: [],
          SecurityOpt: [],
          Memory: 0,
          NanoCpus: 0,
          Tmpfs: {},
          Ulimits: [
            { Name: "memlock", Hard: -1, Soft: -1 },
            { Name: "stack", Hard: runtime.ulimits.stackBytes, Soft: runtime.ulimits.stackBytes },
          ],
          DeviceRequests: [{ Count: -1, DeviceIDs: [], Capabilities: [["gpu"]] }],
        },
        Mounts: [
          {
            Type: "bind",
            Source: "/home/fixture/.cache/huggingface/hub",
            Destination: `${runtime.modelCache.target}/hub`,
            RW: false,
          },
        ],
        NetworkSettings: {
          Ports: {
            "8000/tcp": [
              { HostIp: "127.0.0.1", HostPort: "18000" },
              { HostIp: "172.18.0.1", HostPort: "18000" },
            ],
          },
        },
      },
    },
  };
}

export const dockerClientAvailable =
  process.platform !== "win32" &&
  spawnSync("docker", ["--version"], { timeout: 5000, stdio: "ignore" }).status === 0;

// A private fake API exercises the installed Docker client's real Go template renderer.
// No host Docker daemon, container, GPU, image pull, or external network is involved.
const daemonSource = `
const { parentPort, workerData } = require("node:worker_threads");
const http = require("node:http");
const fs = require("node:fs");
const server = http.createServer((request, response) => {
  const route = decodeURIComponent(request.url).replace(/^\\/v[0-9.]+/, "");
  const objects = JSON.parse(fs.readFileSync(workerData.objects, "utf8"));
  const result = route.startsWith("/images/") ? objects.image : route.startsWith("/networks/") ? objects.network : route.startsWith("/containers/") ? objects.container : null;
  response.writeHead(result ? 200 : 404, { "Content-Type": "application/json" });
  response.end(JSON.stringify(result ?? { message: "Unexpected request" }));
});
server.listen(workerData.socket, () => parentPort.postMessage("ready"));
`;

export async function startVllmExportFormatFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nc-vllm-format-"));
  const socket = path.join(directory, "docker.sock");
  const objectsPath = path.join(directory, "objects.json");
  const fixture = vllmExportFormatFixture(directory);
  const daemon = new Worker(daemonSource, {
    eval: true,
    workerData: { socket, objects: objectsPath },
  });
  const close = async () => {
    await daemon.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture server deadline exceeded")), 5000);
      daemon.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      daemon.once("message", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (error) {
    await close();
    throw error;
  }
  const calls: string[][] = [];
  const capture: NonNullable<VllmExportRuntimeOptions["capture"]> = (args, options) => {
    calls.push([...args]);
    const env: NodeJS.ProcessEnv = { ...options?.env, DOCKER_API_VERSION: "1.52" };
    delete env.DOCKER_CONTEXT;
    const result = spawnSync("docker", ["--host", `unix://${socket}`, ...args], {
      ...options,
      env,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error("Docker format inspection failed");
    return result.stdout;
  };
  const run = () => {
    fs.writeFileSync(objectsPath, JSON.stringify(fixture.objects));
    return observeManagedVllmForExport(fixture.provenance, {
      capture,
      platform: "linux",
      architecture: "x64",
      homeDirectory: "/home/fixture",
      authentication: { stateDir: directory, loadApiKey: () => fixture.key },
    });
  };
  return { ...fixture, directory, run, calls, close };
}
