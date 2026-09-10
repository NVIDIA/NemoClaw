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
    profileWorkspace: Type.Optional(Type.String()),
  }),
});
// OpenShell's native NVIDIA inference profile uses /v1 on this builtin host
// when the provider has no configuration overrides.
export const BuiltinNvidiaProfileResponseSchema = Type.Object({
  profile: Type.Object({
    id: Type.Literal("nvidia"),
    source: Type.Literal("builtin"),
    scope: Type.Literal(""),
    resourceVersion: Type.Refine(VersionSchema, (value) => BigInt(value) === 0n),
    inferenceCapable: Type.Literal(true),
    endpoints: Type.Tuple([
      Type.Object({ host: Type.Literal("integrate.api.nvidia.com"), port: Type.Literal(443) }),
    ]),
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
  policy: Type.Unknown(),
  workspace: WorkspaceSchema,
  version: IntegerSchema,
  policyHash: ReadTextSchema,
  configRevision: VersionSchema,
  providerEnvRevision: VersionSchema,
  policySource: Type.Union([Type.Literal(1), Type.Literal(2)]),
  globalPolicyVersion: IntegerSchema,
});

// ProtoJSON omits implicit defaults. Validate the fields used by policy conversion;
// other released fields pass through to the existing complete policy validator.
const PolicyUint32Schema = Type.Integer({ minimum: 0, maximum: 4294967295 });
const PolicyStringMatcherJsonSchema = Type.Object({
  glob: Type.Optional(Type.String()),
  any: Type.Optional(Type.Array(Type.String())),
});
const PolicyMatcherMapJsonSchema = Type.Record(Type.String(), PolicyStringMatcherJsonSchema);
const PolicyMatcherJsonSchema = Type.Object({
  method: Type.Optional(Type.String()),
  query: Type.Optional(PolicyMatcherMapJsonSchema),
  params: Type.Optional(PolicyMatcherMapJsonSchema),
});
const PolicyEndpointJsonSchema = Type.Object({
  host: Type.Optional(Type.String()),
  port: Type.Optional(PolicyUint32Schema),
  ports: Type.Optional(Type.Array(PolicyUint32Schema)),
  protocol: Type.Optional(Type.String()),
  json_rpc_max_body_bytes: Type.Optional(PolicyUint32Schema),
  mcp: Type.Optional(
    Type.Object({
      strict_tool_names: Type.Optional(Type.Boolean()),
      allow_all_known_mcp_methods: Type.Optional(Type.Boolean()),
    }),
  ),
  rules: Type.Optional(Type.Array(Type.Object({ allow: Type.Optional(PolicyMatcherJsonSchema) }))),
  deny_rules: Type.Optional(Type.Array(PolicyMatcherJsonSchema)),
});
export const PolicyJsonSchema = Type.Object({
  version: Type.Optional(PolicyUint32Schema),
  filesystem: Type.Optional(
    Type.Object({
      include_workdir: Type.Optional(Type.Boolean()),
      read_only: Type.Optional(Type.Array(Type.String())),
      read_write: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  process: Type.Optional(
    Type.Object({
      run_as_user: Type.Optional(Type.String()),
      run_as_group: Type.Optional(Type.String()),
    }),
  ),
  network_policies: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        endpoints: Type.Optional(Type.Array(PolicyEndpointJsonSchema)),
        binaries: Type.Optional(Type.Array(Type.Object({ path: Type.Optional(Type.String()) }))),
      }),
    ),
  ),
});
export type PolicyMatcherJson = TypeBoxModule.Type.Static<typeof PolicyMatcherJsonSchema>;
export type PolicyEndpointJson = TypeBoxModule.Type.Static<typeof PolicyEndpointJsonSchema>;
