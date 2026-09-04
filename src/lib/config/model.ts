// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };
import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };
import { MAX_CANONICAL_ENDPOINT_LENGTH } from "../core/endpoint-contract";
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
const LocalResourceNameSchema = Type.String({
  minLength: 1,
  maxLength: LOCAL_RESOURCE_NAME_MAX_LENGTH,
  pattern: LOCAL_RESOURCE_NAME_PATTERN,
});

// OpenShell v0.0.99 limits sandbox names to 19 characters and reserves "--"
// as a routed-name delimiter.
const SandboxNameSchema = Type.String({
  minLength: 1,
  maxLength: NAME_MAX_LENGTH,
  pattern: NAME_VALID_PATTERN.source,
});

const BoundedTextSchema = Type.String({
  minLength: 1,
  maxLength: BOUNDED_TEXT_MAX_LENGTH,
  pattern: BOUNDED_TEXT_PATTERN,
});
const RuntimeProviderSchema = Type.String({ pattern: RUNTIME_PROVIDER_PATTERN });
const ImmutableImageReferenceSchema = Type.Unsafe<ImmutableImageReference>({
  type: "string",
  maxLength: IMMUTABLE_IMAGE_REFERENCE_MAX_LENGTH,
  pattern: NEMOCLAW_IMMUTABLE_IMAGE_REFERENCE_PATTERN,
});
const UuidSchema = Type.Unsafe<NemoClawConfigDocumentUid>({
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const TcpPortSchema = Type.Integer({ minimum: 1, maximum: 65_535 });

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

const CredentialEnvironmentReferenceSchema = Type.Object(
  { env: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}$" }) },
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

const NemoClawInferenceProviderConfigSchema = Type.Object(
  {
    name: LocalResourceNameSchema,
    provider: BoundedTextSchema,
    api: NemoClawInferenceApiSchema,
    endpoint: Type.String({
      maxLength: NEMOCLAW_INFERENCE_ENDPOINT_MAX_LENGTH,
      pattern: NEMOCLAW_INFERENCE_ENDPOINT_PATTERN,
    }),
    credential: Type.Optional(CredentialEnvironmentReferenceSchema),
  },
  { additionalProperties: false },
);

const NemoClawRouteOverridesSchema = Type.Object(
  { model: BoundedTextSchema },
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

const NemoClawAgentConfigSchema = Type.Object(
  {
    name: LocalResourceNameSchema,
    type: Type.Literal("openclaw"),
    inference: Type.Object(
      {
        routes: Type.Array(NemoClawInferenceRouteConfigSchema, { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

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

const NemoClawSandboxConfigSchema = Type.Object(
  {
    name: SandboxNameSchema,
    runtime: NemoClawSandboxRuntimeConfigSchema,
    network: Type.Object(
      {
        policy: Type.Object(
          { explicit: NemoClawExplicitPolicySchema },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    agents: Type.Array(NemoClawAgentConfigSchema, { minItems: 1 }),
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
export type NemoClawConfig = DeepReadonly<
  TypeBoxModule.Type.Static<typeof NemoClawConfigSchema>
>;

declare const VALIDATED_NEMOCLAW_CONFIG: unique symbol;

/** An owned, deeply frozen configuration returned only by the validation boundary. */
export type ValidatedNemoClawConfig = NemoClawConfig & {
  readonly [VALIDATED_NEMOCLAW_CONFIG]: true;
};
