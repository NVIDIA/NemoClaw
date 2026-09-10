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
const OpaqueMapSchema = Type.Unsafe<Record<string, unknown>>(
  Type.Refine(Type.Unknown(), (value) => {
    if (typeof value !== "object" || value === null) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }),
);
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
const NoUnknownProfileFields = { $unknown: Type.Optional(Type.Tuple([])) };
const ManagedProfileIdentity = {
  ...NoUnknownProfileFields,
  source: Type.Union([Type.Literal("builtin"), Type.Literal("user")]),
  scope: Type.Union([Type.Literal(""), Type.Literal("platform"), Type.Literal("workspace")]),
  resourceVersion: VersionSchema,
  discovery: Type.Optional(Type.Undefined()),
};
// Match the current checked-in profiles, including credential rewriting and egress.
export const ManagedBraveProfileResponseSchema = Type.Object({
  profile: Type.Object({
    ...ManagedProfileIdentity,
    id: Type.Literal("brave"),
    inferenceCapable: Type.Literal(false),
    endpoints: Type.Tuple([
      Type.Object({
        ...NoUnknownProfileFields,
        host: Type.Literal("api.search.brave.com"),
        port: Type.Literal(443),
        ports: Type.Union([Type.Tuple([]), Type.Tuple([Type.Literal(443)])]),
        protocol: Type.Literal("rest"),
        tls: Type.Literal(""),
        enforcement: Type.Literal("enforce"),
        access: Type.Literal("read-write"),
        rules: Type.Tuple([]),
        allowedIps: Type.Tuple([]),
        denyRules: Type.Tuple([]),
        allowEncodedSlash: Type.Literal(false),
        persistedQueries: Type.Literal(""),
        graphqlPersistedQueries: Type.Object({}, { additionalProperties: false }),
        graphqlMaxBodyBytes: Type.Literal(0),
        path: Type.Literal(""),
        websocketCredentialRewrite: Type.Literal(false),
        requestBodyCredentialRewrite: Type.Literal(false),
        advisorProposed: Type.Literal(false),
        credentialSigning: Type.Literal(""),
        signingService: Type.Literal(""),
        signingRegion: Type.Literal(""),
        jsonRpcMaxBodyBytes: Type.Literal(0),
        mcp: Type.Optional(Type.Undefined()),
        credentialBinding: Type.Optional(Type.Undefined()),
      }),
    ]),
    credentials: Type.Tuple([
      Type.Object({
        ...NoUnknownProfileFields,
        name: Type.Literal("api_key"),
        envVars: Type.Tuple([Type.Literal("BRAVE_API_KEY")]),
        required: Type.Literal(true),
        authStyle: Type.Literal("header"),
        headerName: Type.Literal("x-subscription-token"),
        queryParam: Type.Literal(""),
        pathTemplate: Type.Literal(""),
        refresh: Type.Optional(Type.Undefined()),
        tokenGrant: Type.Optional(Type.Undefined()),
      }),
    ]),
    binaries: Type.Tuple([
      Type.Object({ ...NoUnknownProfileFields, path: Type.Literal("/usr/local/bin/node") }),
      Type.Object({ ...NoUnknownProfileFields, path: Type.Literal("/usr/bin/node") }),
      Type.Object({ ...NoUnknownProfileFields, path: Type.Literal("/usr/local/bin/curl") }),
      Type.Object({ ...NoUnknownProfileFields, path: Type.Literal("/usr/bin/curl") }),
    ]),
  }),
});
export const ManagedOpenAiProfileResponseSchema = Type.Object({
  profile: Type.Object({
    ...ManagedProfileIdentity,
    id: Type.Literal("openai"),
    inferenceCapable: Type.Literal(true),
    credentials: Type.Tuple([]),
    endpoints: Type.Tuple([]),
    binaries: Type.Tuple([]),
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
