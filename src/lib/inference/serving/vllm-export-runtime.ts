// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };
import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };
import { dockerCapture } from "../../adapters/docker/local-model-runtime";
import {
  EXPORTED_VLLM_PROFILE_ID,
  EXPORTED_VLLM_CONTEXT_WINDOW,
  EXPORTED_VLLM_RECIPE_ID,
  isImmutableImageReference,
  type NemoClawManagedVllmServing,
} from "../../config/model";
import type { ObservedManagedVllmRuntime } from "../../domain/config/export-evidence";
import { buildVllmServeCommand } from "../vllm-models";
import { buildLocalManagedVllmDockerEnv } from "../vllm-docker-env";
import { isHostLocalInferenceServingRecipe } from "./adapter-registry";
import { loadManagedInferenceCatalog, loadServingCatalog } from "./catalog-loader";
import { materializeHostLocalVllmModel } from "./host-local-vllm-selection";
import { assertServingProfileProvenanceCurrent } from "./profile-provenance";
import type { ServingProfileProvenance } from "./types";
import {
  HOST_LOCAL_VLLM_AUTH_LABEL,
  HOST_LOCAL_VLLM_CATALOG_LABEL,
  HOST_LOCAL_VLLM_CONTAINER_NAME,
  HOST_LOCAL_VLLM_MANAGED_LABEL,
  HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL,
  HOST_LOCAL_VLLM_PRESET_LABEL,
  HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL,
  HOST_LOCAL_VLLM_RECIPE_LABEL,
  recoverHostLocalManagedVllmEndpoint,
  type RecoverHostLocalManagedVllmOptions,
} from "./vllm-host-local-lifecycle";
import { validateManagedVllmBridgeHost } from "./vllm-host-local-network";

const { Type } = require("typebox") as typeof TypeBoxModule;
const { Check } = require("typebox/value") as typeof TypeBoxValueModule;
const MAX_INSPECTION_BYTES = 64 * 1024;
const INSPECTION_TIMEOUT_MS = 5_000;
const Id = Type.String({ pattern: "^[a-f0-9]{64}$" });
const ImageId = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const Text = Type.String({ maxLength: 8192 });
const ImageSchema = Type.Object(
  {
    Id: ImageId,
    Os: Type.Literal("linux"),
    Architecture: Type.Literal("amd64"),
    Environment: Type.Array(Text, { maxItems: 128 }),
  },
  { additionalProperties: false },
);
const NetworkSchema = Type.Object(
  {
    Id,
    Name: Type.Literal("openshell-docker"),
    Driver: Type.Literal("bridge"),
    Config: Type.Array(Type.Object({ Gateway: Text, Subnet: Text }), { minItems: 1, maxItems: 1 }),
  },
  { additionalProperties: false },
);
const ContainerSchema = Type.Object(
  {
    Id,
    Name: Type.Literal("/nemoclaw-vllm"),
    Image: ImageId,
    StartedAt: Type.String({ minLength: 1, maxLength: 64 }),
    Matches: Type.Literal(true),
    State: Type.Object({ Running: Type.Literal(true) }),
    Config: Type.Object({
      Env: Type.Array(Type.String({ pattern: "^VLLM_API_KEY=[a-f0-9]{64}$" }), {
        minItems: 1,
        maxItems: 1,
      }),
      Labels: Type.Record(Type.String(), Type.String({ maxLength: 512 })),
    }),
    NetworkSettings: Type.Object({
      Ports: Type.Object(
        {
          "8000/tcp": Type.Array(Type.Object({ HostIp: Text, HostPort: Text }), {
            minItems: 2,
            maxItems: 2,
          }),
        },
        { additionalProperties: false },
      ),
    }),
  },
  { additionalProperties: false },
);

export interface VllmExportRuntimeOptions {
  readonly capture?: typeof dockerCapture;
  readonly platform?: string;
  readonly architecture?: string;
  readonly homeDirectory?: string;
  /** Test seam; production authentication remains inside the existing lifecycle owner. */
  readonly authentication?: Pick<RecoverHostLocalManagedVllmOptions, "stateDir" | "loadApiKey">;
}

function fail(): never {
  throw new Error("The fixed managed vLLM runtime could not be verified for export.");
}

function parse<T extends TypeBoxModule.Type.TSchema>(
  source: string,
  schema: T,
): TypeBoxModule.Type.Static<T> {
  if (!source || Buffer.byteLength(source) > MAX_INSPECTION_BYTES) fail();
  const value: unknown = JSON.parse(source);
  if (!Check(schema, value)) fail();
  return value;
}

function equalJson(expression: string, expected: unknown): string {
  // Go quoted strings contain only validated catalog/image data, never credentials.
  return `(eq (json ${expression}) ${JSON.stringify(JSON.stringify(expected))})`;
}

function emptyArray(expression: string): string {
  return `(or ${equalJson(expression, null)} ${equalJson(expression, [])})`;
}

function expectedRuntime(recorded: ServingProfileProvenance) {
  const catalog = loadServingCatalog();
  const current = assertServingProfileProvenanceCurrent(recorded, catalog);
  const recipe = loadManagedInferenceCatalog().recipes.find(
    ({ metadata }) => metadata.id === EXPORTED_VLLM_RECIPE_ID,
  );
  const imageRef = current.runtimeImage;
  if (
    current.preset.id !== EXPORTED_VLLM_PROFILE_ID ||
    current.recipe.id !== EXPORTED_VLLM_RECIPE_ID ||
    !recipe ||
    !isHostLocalInferenceServingRecipe(recipe) ||
    recipe.spec.runtime.architecture !== "amd64" ||
    !recipe.spec.serve.directInstall ||
    recipe.spec.serve.directInstall.authentication !== "bearer" ||
    !recipe.spec.serve.directInstall.fixedArguments ||
    !recipe.spec.serve.directInstall.catalogReceipt ||
    recipe.spec.runtime.temporaryFilesystems.length !== 0 ||
    recipe.spec.runtime.devices.length !== 0 ||
    recipe.spec.runtime.gpuRequest !== "all" ||
    !isImmutableImageReference(imageRef)
  )
    fail();
  const model = materializeHostLocalVllmModel(recipe, recipe.spec.serve.directInstall, "linux");
  if (model.maxModelLen !== EXPORTED_VLLM_CONTEXT_WINDOW) fail();
  return { current, recipe, imageRef, command: buildVllmServeCommand(model, {}) };
}

function containerFormat(
  expected: ReturnType<typeof expectedRuntime>,
  image: TypeBoxModule.Type.Static<typeof ImageSchema>,
  homeDirectory: string,
): string {
  const { runtime } = expected.recipe.spec;
  // Compare image defaults in Docker. A modified container environment never leaves the daemon,
  // except for the single managed key consumed by the existing private authentication verifier.
  const environmentCheck = image.Environment.map(
    (value) =>
      `{{$found := false}}{{range .Config.Env}}{{if eq . ${JSON.stringify(value)}}}{{$found = true}}{{end}}{{end}}{{if not $found}}{{$environment = false}}{{end}}`,
  ).join("");
  const labels = [
    HOST_LOCAL_VLLM_AUTH_LABEL,
    HOST_LOCAL_VLLM_CATALOG_LABEL,
    HOST_LOCAL_VLLM_MANAGED_LABEL,
    HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL,
    HOST_LOCAL_VLLM_PRESET_LABEL,
    HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL,
    HOST_LOCAL_VLLM_RECIPE_LABEL,
    "com.nvidia.nemoclaw.vllm-role",
  ]
    .map(
      (key) =>
        `${JSON.stringify(key)}:{{json (or (index .Config.Labels ${JSON.stringify(key)}) "")}}`,
    )
    .join(",");
  const ulimitCheck = [
    ["memlock", runtime.ulimits.memlock === "unlimited" ? -1 : runtime.ulimits.memlock],
    ["stack", runtime.ulimits.stackBytes],
  ]
    .map(
      ([name, value]) =>
        `{{$found := false}}{{range .HostConfig.Ulimits}}{{if and (eq .Name ${JSON.stringify(name)}) ${equalJson(".Hard", value)} ${equalJson(".Soft", value)}}}{{$found = true}}{{end}}{{end}}{{if not $found}}{{$ulimits = false}}{{end}}`,
    )
    .join("");
  const conditions = [
    equalJson(".Config.Cmd", ["-lc", expected.command]),
    equalJson(".Config.Entrypoint", ["/bin/bash"]),
    `(eq .Config.Image ${JSON.stringify(expected.current.runtimeImage)})`,
    `(eq .Image ${JSON.stringify(image.Id)})`,
    `(eq .HostConfig.NetworkMode "bridge")`,
    `(eq .HostConfig.IpcMode ${JSON.stringify(runtime.ipcMode)})`,
    equalJson(".HostConfig.ShmSize", runtime.sharedMemoryBytes),
    `(eq .HostConfig.RestartPolicy.Name "unless-stopped")`,
    `.HostConfig.Init`,
    `(not .HostConfig.Privileged)`,
    emptyArray(".HostConfig.Devices"),
    emptyArray(".HostConfig.CapAdd"),
    emptyArray(".HostConfig.SecurityOpt"),
    `(eq (len .HostConfig.Ulimits) 2)`,
    "$ulimits",
    `(or ${equalJson(".HostConfig.Tmpfs", null)} ${equalJson(".HostConfig.Tmpfs", {})})`,
    equalJson(".HostConfig.Memory", 0),
    equalJson(".HostConfig.NanoCpus", 0),
    `(eq (len .HostConfig.DeviceRequests) 1)`,
    equalJson("(index .HostConfig.DeviceRequests 0).Count", -1),
    emptyArray("(index .HostConfig.DeviceRequests 0).DeviceIDs"),
    equalJson("(index .HostConfig.DeviceRequests 0).Capabilities", [["gpu"]]),
    `(eq (len .Mounts) 1)`,
    `(eq (index .Mounts 0).Type "bind")`,
    `(eq (index .Mounts 0).Source ${JSON.stringify(path.join(homeDirectory, ".cache/huggingface/hub"))})`,
    `(eq (index .Mounts 0).Destination ${JSON.stringify(`${runtime.modelCache.target}/hub`)})`,
    `(not (index .Mounts 0).RW)`,
    `(eq (len .Config.Env) ${String(image.Environment.length + 1)})`,
    "$environment",
  ];
  return `{{$environment := true}}{{$ulimits := true}}${environmentCheck}${ulimitCheck}{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"StartedAt":{{json .State.StartedAt}},"Matches":{{and ${conditions.join(" ")}}},"State":{"Running":{{json .State.Running}}},"Config":{"Labels":{${labels}},"Env":[{{range .Config.Env}}{{if eq (index (split . "=") 0) "VLLM_API_KEY"}}{{json .}}{{end}}{{end}}]},"NetworkSettings":{"Ports":{{json .NetworkSettings.Ports}}}}`;
}

/** Read the fixed runtime; authentication stays inside existing private lifecycle verification. */
export function observeManagedVllmForExport(
  recorded: ServingProfileProvenance,
  options: VllmExportRuntimeOptions = {},
): ObservedManagedVllmRuntime {
  try {
    if (
      (options.platform ?? process.platform) !== "linux" ||
      (options.architecture ?? process.arch) !== "x64"
    )
      fail();
    const expected = expectedRuntime(recorded);
    const capture = options.capture ?? dockerCapture;
    const env = buildLocalManagedVllmDockerEnv();
    const inspect = (kind: string, name: string, format: string) =>
      capture([kind, "inspect", "--format", format, name], {
        env,
        timeout: INSPECTION_TIMEOUT_MS,
        maxBuffer: MAX_INSPECTION_BYTES,
      });
    const image = parse(
      inspect(
        "image",
        expected.imageRef,
        '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"Environment":{{json .Config.Env}}}',
      ),
      ImageSchema,
    );
    if (
      new Set(image.Environment).size !== image.Environment.length ||
      image.Environment.some((value) => value.startsWith("VLLM_API_KEY="))
    )
      fail();
    const network = parse(
      inspect(
        "network",
        "openshell-docker",
        '{"Id":{{json .Id}},"Name":{{json .Name}},"Driver":{{json .Driver}},"Config":{{json .IPAM.Config}}}',
      ),
      NetworkSchema,
    );
    const bridge = validateManagedVllmBridgeHost(network.Config[0]!.Gateway);
    const row = parse(
      inspect(
        "container",
        HOST_LOCAL_VLLM_CONTAINER_NAME,
        containerFormat(expected, image, options.homeDirectory ?? os.homedir()),
      ),
      ContainerSchema,
    );
    const identity = {
      [HOST_LOCAL_VLLM_CATALOG_LABEL]: expected.current.catalogDigest,
      [HOST_LOCAL_VLLM_PRESET_LABEL]: expected.current.preset.id,
      [HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL]: expected.current.preset.digest,
      [HOST_LOCAL_VLLM_RECIPE_LABEL]: expected.current.recipe.id,
      [HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL]: expected.current.recipe.digest,
    };
    if (Object.entries(identity).some(([key, value]) => row.Config.Labels[key] !== value)) fail();
    const recovered = recoverHostLocalManagedVllmEndpoint({
      ...options.authentication,
      dockerInspect: () => JSON.stringify([row]),
      resolveBridgeHost: () => bridge,
    });
    if (!recovered || recovered.containerId !== row.Id || row.Image !== image.Id) fail();
    const hostPort = Number(new URL(recovered.baseUrl).port);
    const serving: NemoClawManagedVllmServing = {
      backend: "vllm",
      catalogDigest: expected.current.catalogDigest,
      profile: { id: EXPORTED_VLLM_PROFILE_ID, digest: expected.current.preset.digest },
      recipe: { id: EXPORTED_VLLM_RECIPE_ID, digest: expected.current.recipe.digest },
      model: { ...expected.current.model, servedName: expected.recipe.spec.model.servedName },
      runtime: { image: { ref: expected.imageRef } },
      hostPort,
    };
    if (
      !isDeepStrictEqual(expected.current.model, {
        id: expected.recipe.spec.model.id,
        revision: expected.recipe.spec.model.revision,
      })
    )
      fail();
    return {
      serving,
      containerId: row.Id,
      imageId: row.Image,
      networkId: network.Id,
      startedAt: row.StartedAt,
    };
  } catch {
    fail();
  }
}
