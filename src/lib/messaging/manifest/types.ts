// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** JSON-compatible primitive used by manifests and plans. */
export type MessagingSerializableScalar = string | number | boolean | null;

/** Recursive JSON-compatible value; functions and class instances stay out of contracts. */
export type MessagingSerializableValue =
  | MessagingSerializableScalar
  | MessagingSerializableObject
  | readonly MessagingSerializableValue[];

/** JSON-compatible object map used for render fragments and persisted state values. */
export type MessagingSerializableObject = {
  readonly [key: string]: MessagingSerializableValue;
};

/** Stable channel identifier, such as "telegram" or "wechat". */
export type MessagingChannelId = string;

/** Agent runtimes that messaging manifests can target today. */
export type MessagingAgentId = "openclaw" | "hermes";

/** Dot-separated path into NemoClaw's persisted sandbox or channel state. */
export type MessagingStatePath = string;

/** String value that may contain placeholders resolved by a later compiler/applier. */
export type MessagingTemplateString = string;

/** Static, serializable declaration for one messaging channel. */
export interface ChannelManifest {
  readonly schemaVersion: 1;
  readonly id: MessagingChannelId;
  readonly displayName: string;
  readonly description?: string;
  readonly supportedAgents: readonly MessagingAgentId[];
  readonly auth: ChannelAuthSpec;
  readonly inputs: readonly ChannelInputSpec[];
  readonly credentials: readonly ChannelCredentialSpec[];
  /** Built-in policy presets needed when this channel is active. */
  readonly policyPresets?: readonly string[];
  readonly render: readonly ChannelRenderSpec[];
  readonly state: ChannelStateSpec;
  readonly hooks: readonly ChannelHookSpec[];
}

/** How a channel obtains credential or session material. */
export type ChannelAuthMode = "none" | "token-paste" | "host-qr" | "in-sandbox-qr";

/** Authentication declaration for a channel, without any secret values. */
export interface ChannelAuthSpec {
  readonly mode: ChannelAuthMode;
}

/** Operator-facing prompt metadata for collecting a manifest input. */
export interface ChannelInputPromptSpec {
  readonly label: string;
  readonly help?: string;
  readonly placeholder?: string;
}

/** Shared fields for secret and non-secret manifest inputs. */
interface ChannelInputBaseSpec {
  readonly id: string;
  readonly required: boolean;
  readonly envKey?: string;
  readonly prompt?: ChannelInputPromptSpec;
  readonly validValues?: readonly string[];
}

/** Secret input metadata; values must be referenced, not stored in manifests or plans. */
export interface ChannelSecretInputSpec extends ChannelInputBaseSpec {
  readonly kind: "secret";
  readonly defaultValue?: never;
  readonly statePath?: never;
}

/** Non-secret input metadata that may default and/or persist into channel state. */
export interface ChannelConfigInputSpec extends ChannelInputBaseSpec {
  readonly kind: "config";
  readonly statePath?: MessagingStatePath;
  readonly defaultValue?: MessagingSerializableValue;
}

/** Manifest input declaration, split so secrets cannot declare defaults or state paths. */
export type ChannelInputSpec = ChannelSecretInputSpec | ChannelConfigInputSpec;

/** Provider binding declaration derived from a secret input. */
export interface ChannelCredentialSpec {
  readonly id: string;
  readonly sourceInput: string;
  readonly providerName: MessagingTemplateString;
  readonly providerEnvKey: string;
  readonly placeholder: MessagingTemplateString;
}

/** Manifest render declaration for supported output formats. */
export type ChannelRenderSpec = ChannelJsonRenderSpec | ChannelEnvLinesRenderSpec;

/** Shared render target metadata. */
interface ChannelRenderBaseSpec {
  readonly id?: string;
  readonly agent: MessagingAgentId;
  readonly target: string;
}

/** JSON fragment a compiler can merge into an agent config file. */
export interface ChannelJsonRenderSpec extends ChannelRenderBaseSpec {
  readonly kind: "json-fragment";
  readonly fragment: ChannelRenderFragmentSpec;
}

/** Env-file lines a compiler can append or rewrite for an agent. */
export interface ChannelEnvLinesRenderSpec extends ChannelRenderBaseSpec {
  readonly kind: "env-lines";
  readonly lines: readonly MessagingTemplateString[];
}

/** JSON path/value pair for one rendered config fragment. */
export interface ChannelRenderFragmentSpec {
  readonly path: MessagingStatePath;
  readonly value: MessagingSerializableValue;
}

/** State persistence and rebuild-hydration rules owned by the channel. */
export interface ChannelStateSpec {
  readonly persist?: Readonly<Record<string, readonly string[]>>;
  readonly rebuildHydration?: readonly ChannelRebuildHydrationSpec[];
}

/** Mapping from persisted state back to an env var during rebuild planning. */
export interface ChannelRebuildHydrationSpec {
  readonly statePath: MessagingStatePath;
  readonly env: string;
}

/** Lifecycle phase where a referenced hook may run. */
export type ChannelHookPhase =
  | "enroll"
  | "apply"
  | "post-agent-install"
  | "health-check";

/** How the planner/applier should treat a hook failure. */
export type ChannelHookFailureMode = "abort" | "skip-channel";

/** Declarative hook reference; handler names are resolved by a separate registry. */
export interface ChannelHookSpec {
  readonly id: string;
  readonly phase: ChannelHookPhase;
  readonly handler: string;
  readonly inputs?: readonly string[];
  readonly outputs?: readonly ChannelHookOutputSpec[];
  readonly onFailure?: ChannelHookFailureMode;
}

/** Output shape a hook promises, without embedding hook implementation details. */
export interface ChannelHookOutputSpec {
  readonly id: string;
  readonly kind: "secret" | "config" | "build-arg" | "build-file";
  readonly required?: boolean;
}

/** Serializable compiled plan for all selected messaging channels. */
export interface SandboxMessagingPlan {
  readonly schemaVersion: 1;
  readonly channels: readonly SandboxMessagingChannelPlan[];
}

/** Compiled plan for one selected channel. */
export interface SandboxMessagingChannelPlan {
  readonly channelId: MessagingChannelId;
  readonly displayName: string;
  readonly active: boolean;
  readonly inputs: readonly SandboxMessagingInputReference[];
  readonly credentialBindings: readonly SandboxMessagingCredentialBindingPlan[];
  readonly policyPresets: readonly string[];
  readonly render: readonly SandboxMessagingRenderFragmentPlan[];
  readonly buildInputs: readonly SandboxMessagingBuildInputPlan[];
  readonly hooks: readonly SandboxMessagingHookReferencePlan[];
}

/** Resolved input metadata carried into the plan without raw secret values. */
export interface SandboxMessagingInputReference {
  readonly inputId: string;
  readonly kind: "secret" | "config";
  readonly required: boolean;
  readonly sourceEnv?: string;
  readonly statePath?: MessagingStatePath;
}

/** Plan entry describing an OpenShell provider/env binding to create or attach. */
export interface SandboxMessagingCredentialBindingPlan {
  readonly credentialId: string;
  readonly sourceInput: string;
  readonly providerName: MessagingTemplateString;
  readonly providerEnvKey: string;
  readonly placeholder: MessagingTemplateString;
}

/** Compiled render output for supported target formats. */
export type SandboxMessagingRenderFragmentPlan =
  | SandboxMessagingJsonRenderFragmentPlan
  | SandboxMessagingEnvLinesRenderFragmentPlan;

/** Shared metadata for compiled render outputs. */
interface SandboxMessagingRenderFragmentBasePlan {
  readonly agent: MessagingAgentId;
  readonly target: string;
}

/** Compiled JSON fragment ready for an applier/render engine. */
export interface SandboxMessagingJsonRenderFragmentPlan
  extends SandboxMessagingRenderFragmentBasePlan {
  readonly kind: "json-fragment";
  readonly path: MessagingStatePath;
  readonly value: MessagingSerializableValue;
}

/** Compiled env-file lines ready for an applier/render engine. */
export interface SandboxMessagingEnvLinesRenderFragmentPlan
  extends SandboxMessagingRenderFragmentBasePlan {
  readonly kind: "env-lines";
  readonly lines: readonly MessagingTemplateString[];
}

/** Build-time input the applier may pass into sandbox create/rebuild. */
export type SandboxMessagingBuildInputPlan =
  | SandboxMessagingBuildArgPlan
  | SandboxMessagingBuildFilePlan;

/** Docker/build argument planned for sandbox create or rebuild. */
export interface SandboxMessagingBuildArgPlan {
  readonly kind: "build-arg";
  readonly name: string;
  readonly valueTemplate: MessagingTemplateString;
}

/** File planned for the sandbox build context, optionally sourced from a hook. */
export interface SandboxMessagingBuildFilePlan {
  readonly kind: "build-file";
  readonly path: string;
  readonly contentTemplate?: MessagingTemplateString;
  readonly sourceHookOutput?: string;
}

/** Hook reference carried into a compiled plan. */
export type SandboxMessagingHookReferencePlan = ChannelHookSpec;
