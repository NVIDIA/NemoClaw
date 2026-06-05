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
  readonly enrollmentHelp?: string;
  readonly enrollmentNotes?: readonly string[];
  readonly supportedAgents: readonly MessagingAgentId[];
  readonly auth: ChannelAuthSpec;
  readonly inputs: readonly ChannelInputSpec[];
  readonly credentials: readonly ChannelCredentialSpec[];
  /** Policy presets needed when this channel is active. */
  readonly policyPresets?: readonly ChannelPolicyPresetReference[];
  readonly render: readonly ChannelRenderSpec[];
  readonly state: ChannelStateSpec;
  readonly hooks: readonly ChannelHookSpec[];
}

/** Manifest-owned network policy preset metadata. */
export type ChannelPolicyPresetReference = string | ChannelPolicyPresetSpec;

/** Concrete network policy keys may differ from the operator-facing preset name. */
export interface ChannelPolicyPresetSpec {
  readonly name: string;
  readonly policyKeys?: readonly string[];
  readonly agentPolicyKeys?: Partial<Record<MessagingAgentId, readonly string[]>>;
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
  readonly emptyValueMessage?: string;
}

/** Shared fields for secret and non-secret manifest inputs. */
interface ChannelInputBaseSpec {
  readonly id: string;
  readonly required: boolean;
  readonly envKey?: string;
  readonly prompt?: ChannelInputPromptSpec;
  readonly validValues?: readonly string[];
  readonly formatPattern?: string;
  readonly formatHint?: string;
}

/** Secret input metadata; values must be referenced, not stored in manifests or plans. */
export interface ChannelSecretInputSpec extends ChannelInputBaseSpec {
  readonly kind: "secret";
  readonly statePath?: never;
}

/** Non-secret input metadata that may persist into channel state. */
export interface ChannelConfigInputSpec extends ChannelInputBaseSpec {
  readonly kind: "config";
  readonly statePath?: MessagingStatePath;
  readonly promptWhenInput?: string;
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
  | "reachability-check"
  | "apply"
  | "post-agent-install"
  | "health-check"
  | "diagnostic"
  | "status";

/** How the planner/applier should treat a hook failure. */
export type ChannelHookFailureMode = "abort" | "skip-channel";

/** Declarative hook reference; handler names are resolved by a separate registry. */
export interface ChannelHookSpec {
  readonly id: string;
  readonly phase: ChannelHookPhase;
  readonly handler: string;
  readonly agents?: readonly MessagingAgentId[];
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
  readonly sandboxName: string;
  readonly agent: MessagingAgentId;
  readonly workflow: MessagingCompilerWorkflow;
  readonly channels: readonly SandboxMessagingChannelPlan[];
  readonly disabledChannels: readonly MessagingChannelId[];
  readonly credentialBindings: readonly SandboxMessagingCredentialBindingPlan[];
  readonly networkPolicy: SandboxMessagingNetworkPolicyPlan;
  readonly agentRender: readonly SandboxMessagingAgentRenderPlan[];
  readonly buildSteps: readonly SandboxMessagingBuildStepPlan[];
  readonly stateUpdates: readonly SandboxMessagingStateUpdatePlan[];
  readonly healthChecks: readonly SandboxMessagingHealthCheckPlan[];
}

/** Workflow that requested a compiled messaging plan. */
export type MessagingCompilerWorkflow =
  | "onboard"
  | "add-channel"
  | "remove-channel"
  | "start-channel"
  | "stop-channel"
  | "rebuild";

/** Compiled metadata for one requested channel. */
export interface SandboxMessagingChannelPlan {
  readonly channelId: MessagingChannelId;
  readonly displayName: string;
  readonly authMode: ChannelAuthMode;
  readonly active: boolean;
  readonly selected: boolean;
  readonly configured: boolean;
  readonly disabled: boolean;
  readonly inputs: readonly SandboxMessagingInputReference[];
  readonly hooks: readonly SandboxMessagingHookReferencePlan[];
}

/** Resolved input metadata carried into the plan without raw secret values. */
export interface SandboxMessagingInputReference {
  readonly channelId: MessagingChannelId;
  readonly inputId: string;
  readonly kind: "secret" | "config";
  readonly required: boolean;
  readonly sourceEnv?: string;
  readonly statePath?: MessagingStatePath;
  readonly credentialAvailable?: boolean;
  readonly value?: MessagingSerializableValue;
}

/** Plan entry describing an OpenShell provider/env binding to create or attach. */
export interface SandboxMessagingCredentialBindingPlan {
  readonly channelId: MessagingChannelId;
  readonly credentialId: string;
  readonly sourceInput: string;
  readonly providerName: MessagingTemplateString;
  readonly providerEnvKey: string;
  readonly placeholder: MessagingTemplateString;
  readonly credentialAvailable: boolean;
  readonly credentialHash?: string;
}

/** Network policy presets and concrete policy keys required by active channels. */
export interface SandboxMessagingNetworkPolicyPlan {
  readonly presets: readonly string[];
  readonly entries: readonly SandboxMessagingNetworkPolicyEntryPlan[];
}

/** One active channel's requested policy preset and resolved policy keys. */
export interface SandboxMessagingNetworkPolicyEntryPlan {
  readonly channelId: MessagingChannelId;
  readonly presetName: string;
  readonly policyKeys: readonly string[];
  readonly source: "agent-alias" | "manifest";
}

/** Compiled render output for supported target formats. */
export type SandboxMessagingAgentRenderPlan =
  | SandboxMessagingJsonRenderPlan
  | SandboxMessagingEnvLinesRenderPlan;

/** Compatibility alias for older phase-1 tests and callers. */
export type SandboxMessagingRenderFragmentPlan = SandboxMessagingAgentRenderPlan;

/** Shared metadata for compiled render outputs. */
interface SandboxMessagingAgentRenderBasePlan {
  readonly channelId: MessagingChannelId;
  readonly renderId?: string;
  readonly agent: MessagingAgentId;
  readonly target: string;
}

/** Compiled JSON fragment ready for an applier/render engine. */
export interface SandboxMessagingJsonRenderPlan
  extends SandboxMessagingAgentRenderBasePlan {
  readonly kind: "json-fragment";
  readonly path: MessagingStatePath;
  readonly value: MessagingSerializableValue;
  readonly templateRefs: readonly string[];
}

/** Compiled env-file lines ready for an applier/render engine. */
export interface SandboxMessagingEnvLinesRenderPlan
  extends SandboxMessagingAgentRenderBasePlan {
  readonly kind: "env-lines";
  readonly lines: readonly MessagingTemplateString[];
  readonly templateRefs: readonly string[];
}

/** Build-time input the applier may pass into sandbox create/rebuild. */
export type SandboxMessagingBuildStepPlan =
  | SandboxMessagingBuildArgStepPlan
  | SandboxMessagingBuildFileStepPlan;

/** Compatibility alias for older phase-1 tests and callers. */
export type SandboxMessagingBuildInputPlan = SandboxMessagingBuildStepPlan;

/** Docker/build argument planned for sandbox create or rebuild. */
export interface SandboxMessagingBuildArgStepPlan {
  readonly channelId: MessagingChannelId;
  readonly kind: "build-arg";
  readonly hookId: string;
  readonly handler: string;
  readonly outputId: string;
  readonly required: boolean;
}

/** File planned for the sandbox build context, optionally sourced from a hook. */
export interface SandboxMessagingBuildFileStepPlan {
  readonly channelId: MessagingChannelId;
  readonly kind: "build-file";
  readonly hookId: string;
  readonly handler: string;
  readonly outputId: string;
  readonly required: boolean;
}

/** Hook reference carried into a compiled plan. */
export interface SandboxMessagingHookReferencePlan extends ChannelHookSpec {
  readonly channelId: MessagingChannelId;
}

/** Planned state persistence or rebuild hydration produced from channel manifests. */
export type SandboxMessagingStateUpdatePlan =
  | SandboxMessagingPersistInputsStateUpdatePlan
  | SandboxMessagingRebuildHydrationStateUpdatePlan;

/** State input persistence planned for later workflow integration. */
export interface SandboxMessagingPersistInputsStateUpdatePlan {
  readonly channelId: MessagingChannelId;
  readonly kind: "persist-inputs";
  readonly stateKey: string;
  readonly inputIds: readonly string[];
}

/** Rebuild-time state hydration planned for later build integration. */
export interface SandboxMessagingRebuildHydrationStateUpdatePlan {
  readonly channelId: MessagingChannelId;
  readonly kind: "rebuild-hydration";
  readonly statePath: MessagingStatePath;
  readonly env: string;
}

/** Health gates that must run before a lifecycle can report success. */
export interface SandboxMessagingHealthCheckPlan {
  readonly channelId: MessagingChannelId;
  readonly phase: "health-check";
  readonly requiredBefore: "lifecycle-success";
  readonly hookIds: readonly string[];
}
