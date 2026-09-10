// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };
import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };
import {
  MAX_CANONICAL_ENDPOINT_LENGTH,
  unsafeEndpointUrlViolation,
} from "../core/endpoint-url-safety";
import { isValidName, NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../sandbox-name-contract";

const { Type } = require("typebox") as typeof TypeBoxModule;
const { Check } = require("typebox/value") as typeof TypeBoxValueModule;

export const NEMOCLAW_CONFIG_API_VERSION = "nemoclaw.nvidia.com/v1" as const;
export const NEMOCLAW_CONFIG_KIND = "NemoClawConfig" as const;
export const NEMOCLAW_CONFIG_SCHEMA_ID =
  "https://github.com/NVIDIA/NemoClaw/schemas/nemoclaw-config-v1.schema.json" as const;
export const NEMOCLAW_SANDBOX_POLICY_SCHEMA_ID =
  "https://github.com/NVIDIA/NemoClaw/schemas/sandbox-policy.schema.json" as const;

const DOCUMENT_NAME_MAX_LENGTH = 63;
const DOCUMENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const LOCAL_RESOURCE_NAME_MAX_LENGTH = 63;
const LOCAL_RESOURCE_NAME_PATTERN = "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$";
const RUNTIME_PROVIDER_PATTERN = "^[a-z][a-z0-9-]{0,62}$";
const BOUNDED_TEXT_MAX_LENGTH = 512;
const BOUNDED_TEXT_PATTERN = "^[^\\s\\p{Cc}\\p{Cf}]+$";
const IMMUTABLE_IMAGE_REFERENCE_MAX_LENGTH = 512;
export const NEMOCLAW_INFERENCE_ENDPOINT_MAX_LENGTH = MAX_CANONICAL_ENDPOINT_LENGTH;
export const NEMOCLAW_INFERENCE_ENDPOINT_PATTERN = "^https://[^\\s]+$";
const CREDENTIAL_ENVIRONMENT_REFERENCE_PATTERN = "^[A-Z][A-Z0-9_]{0,127}$";
const FORBIDDEN_CREDENTIAL_NAMES = new Set([
  "CI",
  "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
  "NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE",
  "NEMOCLAW_RECREATE_WITHOUT_BACKUP",
]);
const FORBIDDEN_CREDENTIAL_PREFIXES = ["DSH_", "NEMOCLAW_", "OPENSHELL_", "VITEST_"] as const;
export const NEMOCLAW_IMMUTABLE_IMAGE_REFERENCE_PATTERN =
  "^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$";

declare const IMMUTABLE_IMAGE_REFERENCE: unique symbol;
export type ImmutableImageReference = string & {
  readonly [IMMUTABLE_IMAGE_REFERENCE]: true;
};

declare const NEMOCLAW_CONFIG_DOCUMENT_NAME: unique symbol;
export type NemoClawConfigDocumentName = string & {
  readonly [NEMOCLAW_CONFIG_DOCUMENT_NAME]: true;
};

declare const NEMOCLAW_CONFIG_DOCUMENT_UID: unique symbol;
export type NemoClawConfigDocumentUid = string & {
  readonly [NEMOCLAW_CONFIG_DOCUMENT_UID]: true;
};

const DocumentNameSchema = Type.Unsafe<NemoClawConfigDocumentName>({
  type: "string",
  minLength: 1,
  maxLength: DOCUMENT_NAME_MAX_LENGTH,
  pattern: DOCUMENT_NAME_PATTERN.source,
});

// Local configuration resource names have an independent domain even though
// v1 starts with the same grammar as document names.
export const LocalResourceNameSchema = Type.String({
  minLength: 1,
  maxLength: LOCAL_RESOURCE_NAME_MAX_LENGTH,
  pattern: LOCAL_RESOURCE_NAME_PATTERN,
});

// OpenShell v0.0.99 limits sandbox names to 19 characters and reserves "--"
// as a routed-name delimiter.
export const SandboxNameSchema = Type.String({
  minLength: 1,
  maxLength: NAME_MAX_LENGTH,
  pattern: NAME_VALID_PATTERN.source,
});

export const BoundedTextSchema = Type.String({
  minLength: 1,
  maxLength: BOUNDED_TEXT_MAX_LENGTH,
  pattern: BOUNDED_TEXT_PATTERN,
});
const HostedInferenceProviderNameSchema = Type.Unsafe<string>({
  ...BoundedTextSchema,
  not: { const: "vllm-local" },
});
export const RuntimeProviderSchema = Type.String({ pattern: RUNTIME_PROVIDER_PATTERN });
export const ImmutableImageReferenceSchema = Type.Unsafe<ImmutableImageReference>({
  type: "string",
  maxLength: IMMUTABLE_IMAGE_REFERENCE_MAX_LENGTH,
  pattern: NEMOCLAW_IMMUTABLE_IMAGE_REFERENCE_PATTERN,
});
const UuidSchema = Type.Unsafe<NemoClawConfigDocumentUid>({
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export const TcpPortSchema = Type.Integer({ minimum: 1, maximum: 65_535 });
export const NemoClawManagedProxyConfigSchema = Type.Object(
  {
    host: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Za-z0-9._-]+$(?![\\s\\S])",
    }),
    port: TcpPortSchema,
  },
  { additionalProperties: false },
);
export const CredentialEnvironmentReferenceNameSchema = Type.String({
  pattern: CREDENTIAL_ENVIRONMENT_REFERENCE_PATTERN,
});
export const InferenceEndpointSchema = Type.String({
  maxLength: NEMOCLAW_INFERENCE_ENDPOINT_MAX_LENGTH,
  pattern: NEMOCLAW_INFERENCE_ENDPOINT_PATTERN,
});

/** True when a value is an exact repository SHA-256 image reference. */
export function isImmutableImageReference(value: unknown): value is ImmutableImageReference {
  return Check(ImmutableImageReferenceSchema, value);
}

/** True when a value follows the runtime-provider identity contract. */
export function isValidNemoClawRuntimeProvider(value: unknown): value is string {
  return Check(RuntimeProviderSchema, value);
}

/** True when a value is a valid local reference name in a v1 document. */
export function isValidNemoClawLocalResourceName(value: unknown): value is string {
  return Check(LocalResourceNameSchema, value);
}

/** True when a value is a valid OpenShell sandbox name in a v1 document. */
export function isValidNemoClawSandboxName(value: unknown): value is string {
  return isValidName(value);
}

/** True when a value is an integer TCP port accepted by v1. */
export function isValidNemoClawPort(value: unknown): value is number {
  return Check(TcpPortSchema, value);
}

/** True when a value follows the bounded text contract used by v1 identities. */
export function isValidNemoClawBoundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    [...value].length <= BOUNDED_TEXT_MAX_LENGTH &&
    Check(BoundedTextSchema, value)
  );
}

/** True when a value is an allowed host credential environment reference. */
export function isCredentialEnvironmentReferenceName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Check(CredentialEnvironmentReferenceNameSchema, value) &&
    !FORBIDDEN_CREDENTIAL_NAMES.has(value) &&
    !FORBIDDEN_CREDENTIAL_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

/** True when a value satisfies the complete v1 inference endpoint contract. */
export function isValidNemoClawInferenceEndpoint(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Check(InferenceEndpointSchema, value) &&
    unsafeEndpointUrlViolation(value) === null
  );
}

/** True when a value follows the NemoClaw configuration document-name contract. */
export function isValidNemoClawConfigDocumentName(
  value: unknown,
): value is NemoClawConfigDocumentName {
  return Check(DocumentNameSchema, value);
}

/** Parse one configuration document name without including rejected input in diagnostics. */
export function parseNemoClawConfigDocumentName(value: unknown): NemoClawConfigDocumentName {
  if (isValidNemoClawConfigDocumentName(value)) return value;
  throw new Error(
    "The config name must contain 1-63 lowercase letters, numbers, dots, or hyphens and must start and end with a letter or number.",
  );
}

/** Parse one generated document UID without including rejected input in diagnostics. */
export function parseNemoClawConfigDocumentUid(value: unknown): NemoClawConfigDocumentUid {
  if (Check(UuidSchema, value)) return value as NemoClawConfigDocumentUid;
  throw new Error("The config document UID is invalid.");
}

export const NEMOCLAW_INFERENCE_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;

export const NemoClawInferenceApiSchema = Type.Enum(NEMOCLAW_INFERENCE_APIS);

export const NEMOCLAW_CONFIG_AGENT_TYPES = ["openclaw", "hermes"] as const;
export const NemoClawAgentTypeSchema = Type.Enum(NEMOCLAW_CONFIG_AGENT_TYPES);

export function isSupportedInferenceApi(value: unknown): value is InferenceApi {
  return Check(NemoClawInferenceApiSchema, value);
}

const CredentialEnvironmentReferenceSchema = Type.Object(
  { env: CredentialEnvironmentReferenceNameSchema },
  { additionalProperties: false },
);

const NemoClawConfigMetadataSchema = Type.Object(
  {
    name: DocumentNameSchema,
    uid: UuidSchema,
  },
  { additionalProperties: false },
);

const NemoClawGatewayConfigSchema = Type.Object(
  {
    management: Type.Literal("nemoclaw"),
    name: LocalResourceNameSchema,
    port: TcpPortSchema,
  },
  { additionalProperties: false },
);

const NemoClawHostedInferenceProviderConfigSchema = Type.Object(
  {
    name: LocalResourceNameSchema,
    provider: HostedInferenceProviderNameSchema,
    api: NemoClawInferenceApiSchema,
    endpoint: InferenceEndpointSchema,
    credential: Type.Optional(CredentialEnvironmentReferenceSchema),
  },
  { additionalProperties: false },
);

export const NemoClawInferenceTuningSchema = Type.Object(
  {
    contextWindow: Type.Optional(Type.Integer({ minimum: 1, maximum: 4_194_304 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000_000 })),
    reasoning: Type.Optional(Type.Boolean()),
    reasoningEffort: Type.Optional(Type.Enum(["default", "low", "medium", "high"])),
  },
  { additionalProperties: false },
);

export const NemoClawAgentExecutionSchema = Type.Object(
  {
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000_000 })),
    heartbeatEvery: Type.Optional(
      Type.String({ maxLength: 256, pattern: "^[0-9]+[smh]$(?![\\s\\S])" }),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const EXPORTED_VLLM_PROFILE_ID =
  "vllm.linux-amd64-nvidia.single.nemotron-3.5-lightning-30b-a3b-nvfp4" as const;
export const EXPORTED_VLLM_CONTEXT_WINDOW = 65_536;
export const EXPORTED_VLLM_RECIPE_ID =
  "vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.linux-amd64-single.v1" as const;

const ServingDigestSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });

/** The first managed-serving branch describes one fixed, catalog-owned deployment. */
export const NemoClawManagedVllmServingSchema = Type.Object(
  {
    backend: Type.Literal("vllm"),
    catalogDigest: ServingDigestSchema,
    profile: Type.Object(
      { id: Type.Literal(EXPORTED_VLLM_PROFILE_ID), digest: ServingDigestSchema },
      { additionalProperties: false },
    ),
    recipe: Type.Object(
      { id: Type.Literal(EXPORTED_VLLM_RECIPE_ID), digest: ServingDigestSchema },
      { additionalProperties: false },
    ),
    model: Type.Object(
      {
        id: BoundedTextSchema,
        revision: Type.String({ pattern: "^[a-f0-9]{40}$" }),
        servedName: BoundedTextSchema,
      },
      { additionalProperties: false },
    ),
    runtime: Type.Object(
      {
        image: Type.Object({ ref: ImmutableImageReferenceSchema }, { additionalProperties: false }),
      },
      { additionalProperties: false },
    ),
    hostPort: Type.Integer({ minimum: 1024, maximum: 65_535 }),
  },
  { additionalProperties: false },
);
export type NemoClawManagedVllmServing = TypeBoxModule.Type.Static<
  typeof NemoClawManagedVllmServingSchema
>;

const NemoClawManagedInferenceProviderConfigSchema = Type.Object(
  {
    name: LocalResourceNameSchema,
    provider: Type.Literal("vllm-local"),
    api: Type.Literal("openai-completions"),
    serving: NemoClawManagedVllmServingSchema,
  },
  { additionalProperties: false },
);

const NemoClawInferenceProviderConfigSchema = Type.Union([
  NemoClawHostedInferenceProviderConfigSchema,
  NemoClawManagedInferenceProviderConfigSchema,
]);

const NemoClawRouteOverridesSchema = Type.Object(
  { model: BoundedTextSchema, ...NemoClawInferenceTuningSchema.properties },
  { additionalProperties: false },
);

const NemoClawInferenceRouteConfigSchema = Type.Object(
  {
    name: LocalResourceNameSchema,
    providerRef: LocalResourceNameSchema,
    overrides: NemoClawRouteOverridesSchema,
  },
  { additionalProperties: false },
);

/** First supported OTLP profile: local HTTP collector, without credentials or headers. */
export const NemoClawOpenClawObservabilitySchema = Type.Object(
  {
    otlp: Type.Object(
      {
        enabled: Type.Literal(true),
        endpoint: Type.Literal("http://host.openshell.internal:4318"),
        // ASCII keeps the public character bound equal to the receipt's UTF-8 byte bound.
        serviceName: Type.String({
          minLength: 1,
          maxLength: 256,
          pattern: "^[!-~](?:[ -~]*[!-~])?$(?![\\s\\S])",
        }),
        sampleRate: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const nemoClawAgentFields = {
  name: LocalResourceNameSchema,
  inference: Type.Object(
    { routes: Type.Array(NemoClawInferenceRouteConfigSchema, { minItems: 1 }) },
    { additionalProperties: false },
  ),
};

const NemoClawAgentConfigSchema = Type.Union([
  Type.Object(
    {
      ...nemoClawAgentFields,
      type: Type.Literal("openclaw"),
      execution: Type.Optional(NemoClawAgentExecutionSchema),
      observability: Type.Optional(NemoClawOpenClawObservabilitySchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...nemoClawAgentFields, type: Type.Literal("hermes") },
    { additionalProperties: false },
  ),
]);

const NemoClawManagedImageConfigSchema = Type.Object(
  { ref: ImmutableImageReferenceSchema },
  { additionalProperties: false },
);

const NemoClawSandboxRuntimeConfigSchema = Type.Object(
  {
    provider: RuntimeProviderSchema,
    image: NemoClawManagedImageConfigSchema,
  },
  { additionalProperties: false },
);

const NemoClawExplicitPolicySchema = Type.Unsafe<Record<string, unknown>>({
  $ref: NEMOCLAW_SANDBOX_POLICY_SCHEMA_ID,
});

export const NemoClawBraveSearchConfigSchema = Type.Object(
  {
    provider: Type.Literal("brave"),
    agentRefs: Type.Array(Type.Literal("primary"), { minItems: 1, maxItems: 1 }),
    credential: CredentialEnvironmentReferenceSchema,
  },
  { additionalProperties: false },
);

const NemoClawSandboxConfigSchema = Type.Object(
  {
    name: SandboxNameSchema,
    runtime: NemoClawSandboxRuntimeConfigSchema,
    network: Type.Object(
      {
        proxy: Type.Optional(NemoClawManagedProxyConfigSchema),
        policy: Type.Object(
          { explicit: NemoClawExplicitPolicySchema },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    agents: Type.Array(NemoClawAgentConfigSchema, { minItems: 1 }),
    integrations: Type.Optional(
      Type.Object({ webSearch: NemoClawBraveSearchConfigSchema }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);

const NemoClawConfigSpecSchema = Type.Object(
  {
    gateway: NemoClawGatewayConfigSchema,
    inferenceProviders: Type.Array(NemoClawInferenceProviderConfigSchema, { minItems: 1 }),
    sandboxes: Type.Array(NemoClawSandboxConfigSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

function deepFreezeSchema<Schema>(schema: Schema): Schema {
  if (typeof schema !== "object" || schema === null || Object.isFrozen(schema)) return schema;
  for (const key of Reflect.ownKeys(schema)) {
    const descriptor = Object.getOwnPropertyDescriptor(schema, key);
    if (descriptor && "value" in descriptor) deepFreezeSchema(descriptor.value);
  }
  return Object.freeze(schema);
}

/** The authoritative, immutable structural contract for a NemoClawConfig v1 wire document. */
export const NemoClawConfigSchema = deepFreezeSchema(
  Type.Object(
    {
      apiVersion: Type.Literal(NEMOCLAW_CONFIG_API_VERSION),
      kind: Type.Literal(NEMOCLAW_CONFIG_KIND),
      metadata: NemoClawConfigMetadataSchema,
      spec: NemoClawConfigSpecSchema,
    },
    {
      additionalProperties: false,
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: NEMOCLAW_CONFIG_SCHEMA_ID,
      title: "NemoClawConfig v1",
    },
  ),
);

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type DeepReadonly<Value> = Value extends Primitive
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type InferenceApi = TypeBoxModule.Type.Static<typeof NemoClawInferenceApiSchema>;
export type CredentialEnvironmentReference = DeepReadonly<
  TypeBoxModule.Type.Static<typeof CredentialEnvironmentReferenceSchema>
>;
export type NemoClawConfigMetadata = DeepReadonly<
  TypeBoxModule.Type.Static<typeof NemoClawConfigMetadataSchema>
>;
export type NemoClawGatewayConfig = DeepReadonly<
  TypeBoxModule.Type.Static<typeof NemoClawGatewayConfigSchema>
>;
export type NemoClawInferenceProviderConfig = DeepReadonly<
  TypeBoxModule.Type.Static<typeof NemoClawInferenceProviderConfigSchema>
>;
export type NemoClawRouteOverrides = DeepReadonly<
  TypeBoxModule.Type.Static<typeof NemoClawRouteOverridesSchema>
>;
export type NemoClawInferenceRouteConfig = DeepReadonly<
  TypeBoxModule.Type.Static<typeof NemoClawInferenceRouteConfigSchema>
>;
export type NemoClawAgentConfig = DeepReadonly<
  TypeBoxModule.Type.Static<typeof NemoClawAgentConfigSchema>
>;
export type NemoClawManagedImageConfig = DeepReadonly<
  TypeBoxModule.Type.Static<typeof NemoClawManagedImageConfigSchema>
>;
export type NemoClawSandboxRuntimeConfig = DeepReadonly<
  TypeBoxModule.Type.Static<typeof NemoClawSandboxRuntimeConfigSchema>
>;
export type NemoClawExplicitPolicy = DeepReadonly<
  TypeBoxModule.Type.Static<typeof NemoClawExplicitPolicySchema>
>;
export type NemoClawSandboxConfig = DeepReadonly<
  TypeBoxModule.Type.Static<typeof NemoClawSandboxConfigSchema>
>;
export type NemoClawConfigSpec = DeepReadonly<
  TypeBoxModule.Type.Static<typeof NemoClawConfigSpecSchema>
>;
export type NemoClawConfig = DeepReadonly<TypeBoxModule.Type.Static<typeof NemoClawConfigSchema>>;

declare const VALIDATED_NEMOCLAW_CONFIG: unique symbol;

/** An owned, deeply frozen configuration returned only by the validation boundary. */
export type ValidatedNemoClawConfig = NemoClawConfig & {
  readonly [VALIDATED_NEMOCLAW_CONFIG]: true;
};
