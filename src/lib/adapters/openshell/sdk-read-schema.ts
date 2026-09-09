// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };

const { Type } = require("typebox") as typeof TypeBoxModule;

// Preserve the SDK reader's UTF-16 limit; schema maxLength counts grapheme clusters.
export const ReadTextSchema = Type.Refine(
  Type.String({ minLength: 1, pattern: "^[^\\p{Cc}\\p{Cf}]+$(?![\\s\\S])" }),
  (value) => value.length <= 4096,
);
export const WorkspaceSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" });
const IntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const VersionSchema = Type.Refine(
  Type.Union([Type.BigInt(), Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$(?![\\s\\S])" })]),
  (value) => BigInt(value) >= 0n && BigInt(value) <= 18446744073709551615n,
);
export const MetadataSchema = Type.Object({
  id: ReadTextSchema,
  name: ReadTextSchema,
  workspace: WorkspaceSchema,
  resourceVersion: VersionSchema,
});

// Validate only consumed fields. Credential values and unrequested config remain opaque.
const OpaqueMapSchema = Type.Record(Type.String(), Type.Unknown());
export const ProviderResponseSchema = Type.Object({
  provider: Type.Object({
    metadata: MetadataSchema,
    type: ReadTextSchema,
    credentials: OpaqueMapSchema,
    credentialHandles: Type.Optional(Type.Union([OpaqueMapSchema, Type.Null()])),
    config: OpaqueMapSchema,
  }),
});
export const SandboxResponseSchema = Type.Object({
  sandbox: Type.Object({
    metadata: MetadataSchema,
    status: Type.Object({ currentPolicyVersion: IntegerSchema }),
    spec: Type.Object({
      template: Type.Object({ image: ReadTextSchema }),
      providers: Type.Array(ReadTextSchema),
    }),
  }),
});
export const SandboxConfigResponseSchema = Type.Object({
  workspace: WorkspaceSchema,
  version: IntegerSchema,
  policyHash: ReadTextSchema,
  configRevision: VersionSchema,
  providerEnvRevision: VersionSchema,
  policySource: Type.Union([Type.Literal(1), Type.Literal(2)]),
  globalPolicyVersion: IntegerSchema,
});
