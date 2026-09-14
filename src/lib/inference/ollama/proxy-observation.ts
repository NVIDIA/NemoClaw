// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };
import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };
import { isWsl } from "../../platform";
import {
  BoundedTextSchema,
  EXPORTED_OLLAMA_MODEL,
  TcpPortSchema,
  type NemoClawOllamaServing,
} from "../../config/model";

const { Type } = require("typebox") as typeof TypeBoxModule;
const { Check } = require("typebox/value") as typeof TypeBoxValueModule;
const ProcessId = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
const ActiveConfig = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    pid: ProcessId,
    listener: Type.Object(
      { address: Type.Literal("0.0.0.0"), port: TcpPortSchema },
      { additionalProperties: false },
    ),
    backendOrigin: Type.String({ maxLength: 64 }),
  },
  { additionalProperties: false },
);
const Models = Type.Object({
  models: Type.Array(
    Type.Object({
      name: BoundedTextSchema,
      digest: Type.String({ pattern: "^(?:sha256:)?[a-f0-9]{64}$(?![\\s\\S])" }),
    }),
    { maxItems: 512 },
  ),
});

export interface ObservedOllamaProxy {
  readonly serving: NemoClawOllamaServing;
  readonly pid: number;
  readonly listenerAddress: "0.0.0.0";
}

export interface OllamaProxyObservationInput {
  readonly model: string;
  readonly backend: { readonly kind: string; readonly url: string | null };
  readonly proxyPort: string | null;
  readonly pid: string | null;
  readonly processMatches: (pid: number) => boolean;
  readonly readActiveConfig: (port: number) => string;
  readonly readProxyModels: (port: number) => string;
  readonly readDaemonModels: (port: number) => string;
}

function fail(): never {
  throw new Error(
    "The live Ollama daemon, proxy mapping, or model could not be verified for export.",
  );
}

function parse<Schema extends TypeBoxModule.Type.TSchema>(
  schema: Schema,
  body: string,
): TypeBoxModule.Type.Static<Schema> {
  if (Buffer.byteLength(body) > 64 * 1024) fail();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    fail();
  }
  if (!Check(schema, value)) fail();
  return value;
}

function selectedDigest(body: string, model: string): string {
  const matches = parse(Models, body).models.filter((entry) => entry.name === model);
  if (matches.length !== 1) fail();
  const digest = matches[0].digest;
  return digest.startsWith("sha256:") ? digest : `sha256:${digest}`;
}

/** Validate retained intent against current proxy and model reads; receives no credentials. */
export function observeOllamaProxy(input: OllamaProxyObservationInput): ObservedOllamaProxy {
  if (os.platform() !== "linux" || isWsl()) {
    throw new Error("Ollama export requires a native Linux host.");
  }
  const proxyPort = Number(input.proxyPort);
  const pid = Number(input.pid);
  const backend = input.backend.url?.match(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u);
  const daemonPort = Number(backend?.[1]);
  if (
    input.backend.kind !== "ollama" ||
    input.model !== EXPORTED_OLLAMA_MODEL ||
    !Check(TcpPortSchema, daemonPort) ||
    !Check(TcpPortSchema, proxyPort) ||
    input.proxyPort !== String(proxyPort) ||
    !Check(ProcessId, pid) ||
    input.pid !== String(pid) ||
    daemonPort === proxyPort ||
    !input.processMatches(pid)
  )
    fail();

  const active = parse(ActiveConfig, input.readActiveConfig(proxyPort));
  if (
    !isDeepStrictEqual(
      [active.pid, active.listener.port, active.backendOrigin],
      [pid, proxyPort, input.backend.url],
    )
  )
    fail();
  const digest = selectedDigest(input.readProxyModels(proxyPort), input.model);
  if (selectedDigest(input.readDaemonModels(daemonPort), input.model) !== digest) fail();
  return {
    serving: {
      backend: "ollama",
      daemon: { management: "external", hostPort: daemonPort },
      proxy: { management: "nemoclaw", hostPort: proxyPort },
      model: { servedName: EXPORTED_OLLAMA_MODEL, digest },
    },
    pid,
    listenerAddress: active.listener.address,
  };
}
