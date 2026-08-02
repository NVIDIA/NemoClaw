// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

/**
 * Required Hermes ownership after each lifecycle phase.
 *
 * This is the target contract for the #8006 delivery stack. Characterization
 * tests keep the current Docker, startup, Shields, backup, and restore
 * implementations visible until later PRs migrate those consumers.
 */

export type HermesIdentity = "root" | "sandbox" | "gateway";
export type HermesOwner = HermesIdentity | "producer";
export type HermesContentOwner = HermesOwner | "preserve";
export type HermesGroup = "root" | "sandbox";
export type HermesRuntimeTopology = "root-separated" | "same-uid";
export type HermesHomeKind = "default" | "named-profile" | "dashboard";
export type HermesArtifactScope = "agent-home" | "default-home" | "named-profile" | "dashboard";
export type HermesArtifactKind = "file" | "directory" | "symlink";
export type HermesArtifactPresence = "required" | "optional";
export type HermesArtifactClass =
  | "protected-configuration"
  | "credential-reference"
  | "mutable-runtime-state"
  | "durable-state"
  | "derived-disposable-state";
export type HermesPathMatch = "exact" | "subtree" | "pattern";
export type HermesMode =
  | "03770"
  | "02770"
  | "0770"
  | "0755"
  | "0700"
  | "0660"
  | "0644"
  | "0640"
  | "0600"
  | "0555"
  | "0444"
  | "0400"
  | "0777";
export type HermesShieldsBehavior = "seal" | "keep-writable" | "unchanged";
export type HermesBackupAction = "directory" | "file" | "sqlite" | "exclude";
export type HermesBackupBehavior = HermesBackupAction | HermesSelectiveBackup;
export type HermesRestoreBehavior = "restore" | "regenerate" | "discard";
export type HermesMigrationRule = "preserve" | "regenerate" | "discard";
export type HermesTreeFileMode = HermesMode | "g+rwX,o-rwx" | "go-w" | "u-only" | "preserve";

export interface HermesBackupSelector {
  readonly relativePattern: string;
  readonly action: Exclude<HermesBackupAction, "directory">;
}

export interface HermesSelectiveBackup {
  readonly kind: "selective";
  readonly fallback: "exclude";
  readonly selectors: readonly HermesBackupSelector[];
}

export type HermesMigrationSource =
  | {
      readonly relativePath: string;
      readonly match: HermesPathMatch;
      readonly action: "migrate";
      readonly onFailure: "leave-source";
    }
  | {
      readonly relativePath: string;
      readonly match: HermesPathMatch;
      readonly action: "discard";
    };

export interface HermesPathPosture {
  readonly kind: "path";
  readonly owner: HermesOwner;
  readonly group: HermesGroup;
  readonly mode: HermesMode;
}

export interface HermesTreePosture {
  readonly kind: "tree";
  /** Owner of the managed subtree root itself. */
  readonly owner: HermesIdentity;
  /** Owner required for descendants created by a lifecycle producer. */
  readonly descendantOwner: HermesContentOwner;
  readonly group: HermesGroup;
  readonly directoryMode: HermesMode;
  readonly fileMode: HermesTreeFileMode;
  readonly symlinks: "ownership-only";
}

export type HermesPosture = HermesPathPosture | HermesTreePosture;
export type HermesConcretePosture =
  | (Omit<HermesPathPosture, "owner"> & { readonly owner: HermesIdentity })
  | (Omit<HermesTreePosture, "descendantOwner"> & {
      readonly descendantOwner: HermesIdentity | "preserve";
    });

export interface HermesTopologyPostures {
  readonly rootSeparated: HermesPosture;
  readonly sameUid: HermesPosture;
}

export interface HermesTopologyIdentities {
  readonly rootSeparated: readonly HermesIdentity[];
  readonly sameUid: readonly HermesIdentity[];
}

export type HermesIdentityRule = readonly HermesIdentity[] | HermesTopologyIdentities;

export type HermesPostureRequirement = HermesPosture | HermesTopologyPostures;

export interface HermesRequiredPostures {
  /** Postcondition after an artifact producer finishes its create or repair action. */
  readonly create: HermesPostureRequirement;
  /** Postcondition after restore filtering and contract-required regeneration, before startup. */
  readonly restore: HermesPostureRequirement | "absent";
  /** Postconditions after a completed Shields transition. */
  readonly shields?: {
    readonly up: HermesPostureRequirement;
    readonly down: HermesPostureRequirement;
  };
}

export interface HermesHomeRelativePaths {
  readonly default: string;
  readonly namedProfile: string;
}

export interface HermesManagedArtifact {
  readonly id: string;
  readonly scope: HermesArtifactScope;
  readonly relativePath: string | HermesHomeRelativePaths;
  readonly match: HermesPathMatch;
  readonly kind: HermesArtifactKind;
  /** Whether the artifact must exist after create, or only has a contract when present. */
  readonly presence: HermesArtifactPresence;
  readonly artifactClass: HermesArtifactClass;
  /** Identities that may create or replace the artifact across all supported topologies. */
  readonly producers: HermesIdentityRule;
  /** Identities that consume the artifact when its lifecycle posture grants access. */
  readonly readers: HermesIdentityRule;
  readonly required: HermesRequiredPostures;
  readonly shields: HermesShieldsBehavior;
  readonly backup: HermesHomeRule<HermesBackupBehavior>;
  readonly restore: HermesHomeRule<HermesRestoreBehavior>;
  readonly migration: HermesMigrationRule;
  /** Older in-home paths consumed only by the artifact's migration step. */
  readonly migrationSources?: readonly HermesMigrationSource[];
}

export type HermesHomeRule<T> =
  | T
  | {
      readonly default: T;
      readonly namedProfile: T;
    };

export type HermesHome =
  | { readonly kind: "default" }
  | { readonly kind: "named-profile"; readonly name: string }
  | { readonly kind: "dashboard" };

export interface ResolvedHermesArtifact {
  readonly artifact: HermesManagedArtifact;
  readonly home: HermesHome;
  readonly pathRole: "target" | "migration-source";
}

export interface HermesUnsupportedResidualPath {
  readonly id: string;
  readonly scope: "agent-home" | "default-home" | "named-profile";
  readonly relativePath: string;
  readonly match: "exact" | "pattern";
  readonly disposition: "discard";
}

export interface HermesContractGap {
  readonly id: string;
  readonly currentPaths: readonly string[];
  readonly targetArtifactIds: readonly string[];
  readonly consumer: string;
  readonly migration: "record-level" | "path-relocation" | "privileged-transition";
  readonly failure: "retain-source";
  readonly limitation?: string;
}

type HermesArtifactTemplate = Omit<HermesManagedArtifact, "id" | "scope" | "relativePath">;

export const HERMES_DEFAULT_HOME = "/sandbox/.hermes";
export const HERMES_NAMED_PROFILES_DIRECTORY = "profiles";
export const HERMES_DASHBOARD_DIRECTORY = "dashboard-home";
export const HERMES_LEGACY_HOME = "/sandbox/.hermes-data";

export const HERMES_LEGACY_MIGRATION = {
  source: HERMES_LEGACY_HOME,
  destination: HERMES_DEFAULT_HOME,
  failure: {
    required: "retain-source",
    knownGap: "source-removal-precedes-final-validation",
  },
} as const;

export const HERMES_CONTRACT_GAPS = [
  {
    id: "cron-jobs-schema-split",
    currentPaths: ["cron/jobs.json"],
    targetArtifactIds: ["cron-job-definitions", "cron-job-runtime-state"],
    consumer: "pinned Hermes cron.jobs and cron.scheduler",
    migration: "record-level",
    failure: "retain-source",
  },
  {
    id: "curator-runtime-relocation",
    currentPaths: ["skills/.curator_state", "skills/.curator_backups"],
    targetArtifactIds: ["curator-state", "curator-recovery"],
    consumer: "pinned Hermes agent.curator and agent.curator_backup",
    migration: "path-relocation",
    failure: "retain-source",
  },
  {
    id: "skills-protected-transition",
    currentPaths: ["skills", "skills/.archive", "skills/.curator_suppressed"],
    targetArtifactIds: ["skills", "curator-archive", "curator-suppression"],
    consumer:
      "pinned Hermes Curator, tools.skill_manager_tool, tools.skills_sync, and gateway startup",
    migration: "privileged-transition",
    failure: "retain-source",
  },
  {
    id: "lsp-install-privileged-transition",
    currentPaths: ["lsp", "lsp/bin", "lsp/node_modules", "lsp/python-packages"],
    targetArtifactIds: ["lsp-cache"],
    consumer: "pinned Hermes agent.lsp.install and agent.lsp.servers",
    migration: "privileged-transition",
    failure: "retain-source",
  },
  {
    id: "pairing-runtime-relocation",
    currentPaths: [
      "pairing/{platform}-pending.json",
      "pairing/_rate_limits.json",
      "platforms/pairing/{platform}-pending.json",
      "platforms/pairing/_rate_limits.json",
    ],
    targetArtifactIds: ["pairing-runtime-state", "pairing-pending", "pairing-rate-limits"],
    consumer: "pinned Hermes PairingStore pending request and rate-limit writers",
    migration: "path-relocation",
    failure: "retain-source",
  },
  {
    id: "pairing-approval-privileged-transition",
    currentPaths: [
      "pairing/{platform}-approved.json",
      "platforms/pairing/{platform}-approved.json",
      "feishu_comment_pairing.json",
    ],
    targetArtifactIds: [
      "pairing-approved",
      "pairing-approved-write-staging",
      "feishu-comment-pairing",
      "feishu-comment-pairing-write-staging",
    ],
    consumer: "pinned Hermes pairing approval, dashboard, and Feishu comment pairing writers",
    migration: "privileged-transition",
    failure: "retain-source",
  },
  {
    id: "whatsapp-session-secure-handoff",
    currentPaths: ["platforms/whatsapp/session", "whatsapp/session"],
    targetArtifactIds: ["whatsapp-session", "legacy-whatsapp-session"],
    consumer:
      "pinned Hermes WhatsApp bridge Baileys multi-file authentication state and NemoClaw snapshot/rebuild restore",
    migration: "privileged-transition",
    failure: "retain-source",
    limitation: "same-uid topology cannot isolate gateway session credentials from sandbox code",
  },
] as const satisfies readonly HermesContractGap[];

/** Upstream direct-lifecycle leftovers that NemoClaw cleans up but does not support. */
export const HERMES_UNSUPPORTED_RESIDUAL_PATHS = [
  {
    id: "legacy-gateway-pid",
    scope: "default-home",
    relativePath: "gateway.pid",
    match: "exact",
    disposition: "discard",
  },
  {
    id: "legacy-cron-pid",
    scope: "default-home",
    relativePath: "cron.pid",
    match: "exact",
    disposition: "discard",
  },
  {
    id: "named-gateway-pid",
    scope: "named-profile",
    relativePath: "gateway.pid",
    match: "exact",
    disposition: "discard",
  },
  {
    id: "named-cron-pid",
    scope: "named-profile",
    relativePath: "cron.pid",
    match: "exact",
    disposition: "discard",
  },
  {
    id: "named-gateway-lock",
    scope: "named-profile",
    relativePath: "gateway.lock",
    match: "exact",
    disposition: "discard",
  },
  {
    id: "named-gateway-status",
    scope: "named-profile",
    relativePath: "gateway_state.json",
    match: "exact",
    disposition: "discard",
  },
  {
    id: "upstream-weixin-account-credential",
    scope: "agent-home",
    relativePath: "weixin/accounts/{account}.json",
    match: "pattern",
    disposition: "discard",
  },
  {
    id: "legacy-skill-usage-lock",
    scope: "agent-home",
    relativePath: "skills/.usage.json.lock",
    match: "exact",
    disposition: "discard",
  },
] as const satisfies readonly HermesUnsupportedResidualPath[];

const ROOT_HOME = {
  kind: "path",
  owner: "root",
  group: "sandbox",
  mode: "03770",
} as const satisfies HermesPathPosture;
const SANDBOX_DIRECTORY = {
  kind: "tree",
  owner: "sandbox",
  descendantOwner: "sandbox",
  group: "sandbox",
  directoryMode: "0770",
  fileMode: "g+rwX,o-rwx",
  symlinks: "ownership-only",
} as const satisfies HermesTreePosture;
const SANDBOX_WRITABLE_DIRECTORY = {
  ...SANDBOX_DIRECTORY,
  descendantOwner: "producer",
} as const satisfies HermesTreePosture;
const SANDBOX_SETGID_DIRECTORY = {
  kind: "tree",
  owner: "sandbox",
  descendantOwner: "sandbox",
  group: "sandbox",
  directoryMode: "02770",
  fileMode: "g+rwX,o-rwx",
  symlinks: "ownership-only",
} as const satisfies HermesTreePosture;
const SANDBOX_WRITABLE_SETGID_DIRECTORY = {
  ...SANDBOX_SETGID_DIRECTORY,
  descendantOwner: "producer",
} as const satisfies HermesTreePosture;
const SANDBOX_STICKY_DIRECTORY = {
  ...SANDBOX_WRITABLE_SETGID_DIRECTORY,
  directoryMode: "03770",
} as const satisfies HermesTreePosture;
const SANDBOX_PRESERVED_SETGID_DIRECTORY = {
  ...SANDBOX_SETGID_DIRECTORY,
  descendantOwner: "preserve",
  fileMode: "preserve",
} as const satisfies HermesTreePosture;
const ROOT_HIGH_RISK_DIRECTORY = {
  kind: "tree",
  owner: "root",
  descendantOwner: "root",
  group: "sandbox",
  directoryMode: "0755",
  fileMode: "go-w",
  symlinks: "ownership-only",
} as const satisfies HermesTreePosture;
const ROOT_STICKY_DIRECTORY = {
  kind: "tree",
  owner: "root",
  descendantOwner: "producer",
  group: "sandbox",
  directoryMode: "03770",
  fileMode: "g+rwX,o-rwx",
  symlinks: "ownership-only",
} as const satisfies HermesTreePosture;
const GATEWAY_DIRECTORY = {
  kind: "tree",
  owner: "gateway",
  descendantOwner: "producer",
  group: "sandbox",
  directoryMode: "02770",
  fileMode: "g+rwX,o-rwx",
  symlinks: "ownership-only",
} as const satisfies HermesTreePosture;
const GATEWAY_STICKY_DIRECTORY = {
  ...GATEWAY_DIRECTORY,
  directoryMode: "03770",
} as const satisfies HermesTreePosture;
const GATEWAY_PRIVATE_DIRECTORY = {
  kind: "tree",
  owner: "gateway",
  descendantOwner: "gateway",
  group: "sandbox",
  directoryMode: "0700",
  fileMode: "u-only",
  symlinks: "ownership-only",
} as const satisfies HermesTreePosture;
const DASHBOARD_DIRECTORY = {
  kind: "tree",
  owner: "sandbox",
  descendantOwner: "sandbox",
  group: "sandbox",
  directoryMode: "0700",
  fileMode: "0600",
  symlinks: "ownership-only",
} as const satisfies HermesTreePosture;
const SANDBOX_FILE = {
  kind: "path",
  owner: "sandbox",
  group: "sandbox",
  mode: "0640",
} as const satisfies HermesPathPosture;
const SANDBOX_SHARED_FILE = {
  kind: "path",
  owner: "sandbox",
  group: "sandbox",
  mode: "0660",
} as const satisfies HermesPathPosture;
const SANDBOX_PRIVATE_FILE = {
  kind: "path",
  owner: "sandbox",
  group: "sandbox",
  mode: "0600",
} as const satisfies HermesPathPosture;
const PRODUCER_SHARED_FILE = {
  kind: "path",
  owner: "producer",
  group: "sandbox",
  mode: "0660",
} as const satisfies HermesPathPosture;
const PRODUCER_PRIVATE_FILE = {
  kind: "path",
  owner: "producer",
  group: "sandbox",
  mode: "0600",
} as const satisfies HermesPathPosture;
const PRODUCER_FILE = {
  kind: "path",
  owner: "producer",
  group: "sandbox",
  mode: "0640",
} as const satisfies HermesPathPosture;
const SANDBOX_IMAGE_DOCUMENT = {
  kind: "path",
  owner: "sandbox",
  group: "sandbox",
  mode: "0644",
} as const satisfies HermesPathPosture;
const ROOT_PROTECTED_FILE = {
  kind: "path",
  owner: "root",
  group: "root",
  mode: "0444",
} as const satisfies HermesPathPosture;
const ROOT_MIGRATION_MARKER = {
  kind: "path",
  owner: "root",
  group: "root",
  mode: "0444",
} as const satisfies HermesPathPosture;
const ROOT_RESTART_MARKER = {
  kind: "path",
  owner: "root",
  group: "root",
  mode: "0400",
} as const satisfies HermesPathPosture;
const ROOT_PRIVATE_FILE = {
  kind: "path",
  owner: "root",
  group: "root",
  mode: "0600",
} as const satisfies HermesPathPosture;
const GATEWAY_FILE = {
  kind: "path",
  owner: "gateway",
  group: "sandbox",
  mode: "0640",
} as const satisfies HermesPathPosture;
const GATEWAY_SHARED_FILE = {
  kind: "path",
  owner: "gateway",
  group: "sandbox",
  mode: "0660",
} as const satisfies HermesPathPosture;
const GATEWAY_PRIVATE_FILE = {
  kind: "path",
  owner: "gateway",
  group: "sandbox",
  mode: "0600",
} as const satisfies HermesPathPosture;
const SANDBOX_EXECUTABLE = {
  kind: "path",
  owner: "sandbox",
  group: "sandbox",
  mode: "0755",
} as const satisfies HermesPathPosture;
const GATEWAY_EXECUTABLE = {
  kind: "path",
  owner: "gateway",
  group: "sandbox",
  mode: "0755",
} as const satisfies HermesPathPosture;
const ROOT_EXECUTABLE = {
  kind: "path",
  owner: "root",
  group: "root",
  mode: "0555",
} as const satisfies HermesPathPosture;
const ROOT_COMPATIBILITY_LINK = {
  kind: "path",
  owner: "root",
  group: "sandbox",
  mode: "0777",
} as const satisfies HermesPathPosture;

const GATEWAY_DIRECTORY_BY_TOPOLOGY = {
  rootSeparated: GATEWAY_DIRECTORY,
  sameUid: SANDBOX_WRITABLE_SETGID_DIRECTORY,
} as const satisfies HermesTopologyPostures;
const GATEWAY_STICKY_DIRECTORY_BY_TOPOLOGY = {
  rootSeparated: GATEWAY_STICKY_DIRECTORY,
  sameUid: SANDBOX_STICKY_DIRECTORY,
} as const satisfies HermesTopologyPostures;
const GATEWAY_PRIVATE_DIRECTORY_BY_TOPOLOGY = {
  rootSeparated: GATEWAY_PRIVATE_DIRECTORY,
  sameUid: DASHBOARD_DIRECTORY,
} as const satisfies HermesTopologyPostures;
const GATEWAY_FILE_BY_TOPOLOGY = {
  rootSeparated: GATEWAY_FILE,
  sameUid: SANDBOX_FILE,
} as const satisfies HermesTopologyPostures;
const GATEWAY_SHARED_FILE_BY_TOPOLOGY = {
  rootSeparated: GATEWAY_SHARED_FILE,
  sameUid: SANDBOX_SHARED_FILE,
} as const satisfies HermesTopologyPostures;
const GATEWAY_PRIVATE_FILE_BY_TOPOLOGY = {
  rootSeparated: GATEWAY_PRIVATE_FILE,
  sameUid: SANDBOX_PRIVATE_FILE,
} as const satisfies HermesTopologyPostures;
const GATEWAY_EXECUTABLE_BY_TOPOLOGY = {
  rootSeparated: GATEWAY_EXECUTABLE,
  sameUid: SANDBOX_EXECUTABLE,
} as const satisfies HermesTopologyPostures;
const CREDENTIAL_FILE_BY_TOPOLOGY = {
  rootSeparated: SANDBOX_FILE,
  sameUid: SANDBOX_PRIVATE_FILE,
} as const satisfies HermesTopologyPostures;

const GATEWAY_ROLE = {
  rootSeparated: ["gateway"],
  sameUid: ["sandbox"],
} as const satisfies HermesTopologyIdentities;
const SANDBOX_AND_GATEWAY_ROLE = {
  rootSeparated: ["sandbox", "gateway"],
  sameUid: ["sandbox"],
} as const satisfies HermesTopologyIdentities;
const ROOT_AND_GATEWAY_ROLE = {
  rootSeparated: ["root", "gateway"],
  sameUid: ["root", "sandbox"],
} as const satisfies HermesTopologyIdentities;
const ALL_ROLES = {
  rootSeparated: ["root", "sandbox", "gateway"],
  sameUid: ["root", "sandbox"],
} as const satisfies HermesTopologyIdentities;

const HOME_REQUIREMENTS = {
  create: ROOT_HOME,
  restore: ROOT_HOME,
  shields: { up: ROOT_HOME, down: ROOT_HOME },
} as const satisfies HermesRequiredPostures;
const WRITABLE_DIRECTORY_REQUIREMENTS = {
  create: SANDBOX_WRITABLE_DIRECTORY,
  restore: SANDBOX_DIRECTORY,
} as const satisfies HermesRequiredPostures;
const SETGID_DIRECTORY_REQUIREMENTS = {
  create: SANDBOX_WRITABLE_SETGID_DIRECTORY,
  restore: SANDBOX_SETGID_DIRECTORY,
} as const satisfies HermesRequiredPostures;
const PRESERVED_SETGID_DIRECTORY_REQUIREMENTS = {
  create: SANDBOX_PRESERVED_SETGID_DIRECTORY,
  restore: SANDBOX_PRESERVED_SETGID_DIRECTORY,
} as const satisfies HermesRequiredPostures;
const HIGH_RISK_DIRECTORY_REQUIREMENTS = {
  create: SANDBOX_WRITABLE_DIRECTORY,
  restore: SANDBOX_SETGID_DIRECTORY,
  shields: { up: ROOT_HIGH_RISK_DIRECTORY, down: SANDBOX_SETGID_DIRECTORY },
} as const satisfies HermesRequiredPostures;
const GATEWAY_DIRECTORY_REQUIREMENTS = {
  create: GATEWAY_DIRECTORY_BY_TOPOLOGY,
  restore: GATEWAY_DIRECTORY_BY_TOPOLOGY,
} as const satisfies HermesRequiredPostures;
const GATEWAY_STICKY_DIRECTORY_REQUIREMENTS = {
  create: GATEWAY_STICKY_DIRECTORY_BY_TOPOLOGY,
  restore: GATEWAY_STICKY_DIRECTORY_BY_TOPOLOGY,
} as const satisfies HermesRequiredPostures;
const GATEWAY_PRIVATE_DIRECTORY_DISCARD_REQUIREMENTS = {
  create: GATEWAY_PRIVATE_DIRECTORY_BY_TOPOLOGY,
  restore: "absent",
} as const satisfies HermesRequiredPostures;
const ROOT_STICKY_DIRECTORY_REQUIREMENTS = {
  create: ROOT_STICKY_DIRECTORY,
  restore: ROOT_STICKY_DIRECTORY,
} as const satisfies HermesRequiredPostures;
const ROOT_PROTECTED_DIRECTORY_REQUIREMENTS = {
  create: ROOT_HIGH_RISK_DIRECTORY,
  restore: ROOT_HIGH_RISK_DIRECTORY,
  shields: { up: ROOT_HIGH_RISK_DIRECTORY, down: ROOT_HIGH_RISK_DIRECTORY },
} as const satisfies HermesRequiredPostures;
const GATEWAY_DIRECTORY_DISCARD_REQUIREMENTS = {
  create: GATEWAY_DIRECTORY_BY_TOPOLOGY,
  restore: "absent",
} as const satisfies HermesRequiredPostures;
const DASHBOARD_DIRECTORY_REQUIREMENTS = {
  create: DASHBOARD_DIRECTORY,
  restore: DASHBOARD_DIRECTORY,
} as const satisfies HermesRequiredPostures;
const CONFIG_FILE_REQUIREMENTS = {
  create: SANDBOX_FILE,
  restore: SANDBOX_FILE,
  shields: { up: ROOT_PROTECTED_FILE, down: SANDBOX_FILE },
} as const satisfies HermesRequiredPostures;
const ROOT_PROTECTED_FILE_REQUIREMENTS = {
  create: ROOT_PROTECTED_FILE,
  restore: ROOT_PROTECTED_FILE,
  shields: { up: ROOT_PROTECTED_FILE, down: ROOT_PROTECTED_FILE },
} as const satisfies HermesRequiredPostures;
const ROOT_PRIVATE_DISCARD_REQUIREMENTS = {
  create: ROOT_PRIVATE_FILE,
  restore: "absent",
  shields: { up: ROOT_PRIVATE_FILE, down: ROOT_PRIVATE_FILE },
} as const satisfies HermesRequiredPostures;
const SHARED_CONFIG_FILE_REQUIREMENTS = {
  create: PRODUCER_SHARED_FILE,
  restore: SANDBOX_SHARED_FILE,
  shields: { up: ROOT_PROTECTED_FILE, down: SANDBOX_SHARED_FILE },
} as const satisfies HermesRequiredPostures;
const CREDENTIAL_FILE_REQUIREMENTS = {
  create: CREDENTIAL_FILE_BY_TOPOLOGY,
  restore: CREDENTIAL_FILE_BY_TOPOLOGY,
  shields: { up: ROOT_PROTECTED_FILE, down: CREDENTIAL_FILE_BY_TOPOLOGY },
} as const satisfies HermesRequiredPostures;
const PROTECTED_DOCUMENT_REQUIREMENTS = {
  create: SANDBOX_IMAGE_DOCUMENT,
  restore: SANDBOX_FILE,
  shields: { up: ROOT_PROTECTED_FILE, down: SANDBOX_FILE },
} as const satisfies HermesRequiredPostures;
const SANDBOX_SHARED_FILE_REQUIREMENTS = {
  create: SANDBOX_SHARED_FILE,
  restore: SANDBOX_SHARED_FILE,
} as const satisfies HermesRequiredPostures;
const PRODUCER_SHARED_FILE_REQUIREMENTS = {
  create: PRODUCER_SHARED_FILE,
  restore: SANDBOX_SHARED_FILE,
} as const satisfies HermesRequiredPostures;
const SANDBOX_PRIVATE_FILE_REQUIREMENTS = {
  create: SANDBOX_PRIVATE_FILE,
  restore: SANDBOX_PRIVATE_FILE,
} as const satisfies HermesRequiredPostures;
const SANDBOX_PRIVATE_DISCARD_REQUIREMENTS = {
  create: SANDBOX_PRIVATE_FILE,
  restore: "absent",
} as const satisfies HermesRequiredPostures;
const PRODUCER_SHARED_DISCARD_REQUIREMENTS = {
  create: PRODUCER_SHARED_FILE,
  restore: "absent",
} as const satisfies HermesRequiredPostures;
const PRODUCER_PRIVATE_DISCARD_REQUIREMENTS = {
  create: PRODUCER_PRIVATE_FILE,
  restore: "absent",
} as const satisfies HermesRequiredPostures;
const SEALED_STAGING_FILE_REQUIREMENTS = {
  create: PRODUCER_PRIVATE_FILE,
  restore: "absent",
  shields: { up: ROOT_RESTART_MARKER, down: SANDBOX_PRIVATE_FILE },
} as const satisfies HermesRequiredPostures;
const PRODUCER_FILE_DISCARD_REQUIREMENTS = {
  create: PRODUCER_FILE,
  restore: "absent",
} as const satisfies HermesRequiredPostures;
const GATEWAY_FILE_REQUIREMENTS = {
  create: GATEWAY_FILE_BY_TOPOLOGY,
  restore: "absent",
} as const satisfies HermesRequiredPostures;
const GATEWAY_SHARED_DISCARD_REQUIREMENTS = {
  create: GATEWAY_SHARED_FILE_BY_TOPOLOGY,
  restore: "absent",
} as const satisfies HermesRequiredPostures;
const GATEWAY_SHARED_FILE_REQUIREMENTS = {
  create: GATEWAY_SHARED_FILE_BY_TOPOLOGY,
  restore: SANDBOX_SHARED_FILE,
} as const satisfies HermesRequiredPostures;
const GATEWAY_PRIVATE_DISCARD_REQUIREMENTS = {
  create: GATEWAY_PRIVATE_FILE_BY_TOPOLOGY,
  restore: "absent",
} as const satisfies HermesRequiredPostures;
const GATEWAY_PRIVATE_FILE_REQUIREMENTS = {
  create: GATEWAY_PRIVATE_FILE_BY_TOPOLOGY,
  restore: GATEWAY_PRIVATE_FILE_BY_TOPOLOGY,
} as const satisfies HermesRequiredPostures;
const GATEWAY_EXECUTABLE_REQUIREMENTS = {
  create: GATEWAY_EXECUTABLE_BY_TOPOLOGY,
  restore: GATEWAY_EXECUTABLE_BY_TOPOLOGY,
  shields: { up: ROOT_EXECUTABLE, down: GATEWAY_EXECUTABLE_BY_TOPOLOGY },
} as const satisfies HermesRequiredPostures;
const SQLITE_FILE_REQUIREMENTS = {
  create: PRODUCER_SHARED_FILE,
  restore: SANDBOX_SHARED_FILE,
} as const satisfies HermesRequiredPostures;
const PRIVATE_SQLITE_FILE_REQUIREMENTS = {
  create: GATEWAY_PRIVATE_FILE_BY_TOPOLOGY,
  restore: GATEWAY_PRIVATE_FILE_BY_TOPOLOGY,
} as const satisfies HermesRequiredPostures;
const SQLITE_SIDECAR_REQUIREMENTS = {
  create: PRODUCER_SHARED_FILE,
  restore: "absent",
} as const satisfies HermesRequiredPostures;
const PRIVATE_SQLITE_SIDECAR_REQUIREMENTS = {
  create: GATEWAY_PRIVATE_FILE_BY_TOPOLOGY,
  restore: "absent",
} as const satisfies HermesRequiredPostures;
const COMPATIBILITY_LINK_REQUIREMENTS = {
  create: ROOT_COMPATIBILITY_LINK,
  restore: ROOT_COMPATIBILITY_LINK,
} as const satisfies HermesRequiredPostures;
const MIGRATION_MARKER_REQUIREMENTS = {
  create: ROOT_MIGRATION_MARKER,
  restore: "absent",
} as const satisfies HermesRequiredPostures;
const RESTART_MARKER_REQUIREMENTS = {
  create: ROOT_RESTART_MARKER,
  restore: "absent",
} as const satisfies HermesRequiredPostures;

const KANBAN_BACKUP = {
  kind: "selective",
  fallback: "exclude",
  selectors: [
    { relativePattern: "current", action: "file" },
    { relativePattern: ".dispatcher.lock", action: "exclude" },
    { relativePattern: "attachments/**", action: "file" },
    { relativePattern: "boards/{board}/workspaces/**", action: "exclude" },
    { relativePattern: "boards/{board}/attachments/**", action: "file" },
    { relativePattern: "boards/{board}/logs/**", action: "exclude" },
    { relativePattern: "boards/{board}/kanban.db.{lock}.lock", action: "exclude" },
    { relativePattern: "boards/{board}/kanban.db.corrupt.{backup}", action: "file" },
    { relativePattern: "boards/{board}/kanban.db-wal", action: "exclude" },
    { relativePattern: "boards/{board}/kanban.db-shm", action: "exclude" },
    { relativePattern: "boards/{board}/kanban.db-journal", action: "exclude" },
    { relativePattern: "boards/{board}/kanban.db", action: "sqlite" },
    { relativePattern: "boards/_archived/{board}/workspaces/**", action: "exclude" },
    { relativePattern: "boards/_archived/{board}/attachments/**", action: "file" },
    { relativePattern: "boards/_archived/{board}/logs/**", action: "exclude" },
    {
      relativePattern: "boards/_archived/{board}/kanban.db.{lock}.lock",
      action: "exclude",
    },
    {
      relativePattern: "boards/_archived/{board}/kanban.db.corrupt.{backup}",
      action: "file",
    },
    { relativePattern: "boards/_archived/{board}/kanban.db-wal", action: "exclude" },
    { relativePattern: "boards/_archived/{board}/kanban.db-shm", action: "exclude" },
    { relativePattern: "boards/_archived/{board}/kanban.db-journal", action: "exclude" },
    { relativePattern: "boards/_archived/{board}/kanban.db", action: "sqlite" },
    { relativePattern: "boards/_archived/{board}/**", action: "file" },
    { relativePattern: "boards/{board}/**", action: "file" },
  ],
} as const satisfies HermesSelectiveBackup;
const MEMORIES_BACKUP = {
  kind: "selective",
  fallback: "exclude",
  selectors: [
    { relativePattern: ".mem_{temp}.tmp", action: "exclude" },
    { relativePattern: "MEMORY.md.lock", action: "exclude" },
    { relativePattern: "USER.md.lock", action: "exclude" },
    { relativePattern: "**", action: "file" },
  ],
} as const satisfies HermesSelectiveBackup;
const SESSIONS_BACKUP = {
  kind: "selective",
  fallback: "exclude",
  selectors: [
    { relativePattern: ".sessions_{temp}.tmp", action: "exclude" },
    { relativePattern: "**", action: "file" },
  ],
} as const satisfies HermesSelectiveBackup;
const SKILLS_BACKUP = {
  kind: "selective",
  fallback: "exclude",
  selectors: [
    { relativePattern: ".{temp}.tmp", action: "exclude" },
    { relativePattern: "**/.{filename}.tmp.{temp}", action: "exclude" },
    { relativePattern: ".hub/.lock_{temp}.tmp", action: "exclude" },
    { relativePattern: ".usage.json.lock", action: "exclude" },
    { relativePattern: "**", action: "file" },
  ],
} as const satisfies HermesSelectiveBackup;
const PAIRING_BACKUP = {
  kind: "selective",
  fallback: "exclude",
  selectors: [
    { relativePattern: "{platform}-approved.json", action: "file" },
    { relativePattern: "{platform}-pending.json", action: "exclude" },
    { relativePattern: "_rate_limits.json", action: "exclude" },
    { relativePattern: "tmp{temp}.tmp", action: "exclude" },
  ],
} as const satisfies HermesSelectiveBackup;
const CRON_BACKUP = {
  kind: "selective",
  fallback: "exclude",
  selectors: [
    { relativePattern: ".{temp}.tmp", action: "exclude" },
    { relativePattern: "output/{job}/.output_{temp}.tmp", action: "exclude" },
    { relativePattern: ".tick.lock", action: "exclude" },
    { relativePattern: ".jobs.lock", action: "exclude" },
    { relativePattern: "ticker_heartbeat", action: "exclude" },
    { relativePattern: "ticker_last_success", action: "exclude" },
    { relativePattern: "**", action: "file" },
  ],
} as const satisfies HermesSelectiveBackup;
const WEIXIN_BACKUP = {
  kind: "selective",
  fallback: "exclude",
  selectors: [
    { relativePattern: "accounts/{account}.context-tokens.json", action: "file" },
    { relativePattern: "accounts/{account}.sync.json", action: "exclude" },
    { relativePattern: "accounts/{account}.json", action: "exclude" },
  ],
} as const satisfies HermesSelectiveBackup;
const WEIXIN_ACCOUNTS_BACKUP = {
  kind: "selective",
  fallback: "exclude",
  selectors: [
    { relativePattern: "{account}.context-tokens.json", action: "file" },
    { relativePattern: "{account}.sync.json", action: "exclude" },
    { relativePattern: "{account}.json", action: "exclude" },
  ],
} as const satisfies HermesSelectiveBackup;
const WHATSAPP_BACKUP = {
  kind: "selective",
  fallback: "exclude",
  selectors: [
    { relativePattern: "bridge.log", action: "exclude" },
    { relativePattern: "session/**", action: "exclude" },
  ],
} as const satisfies HermesSelectiveBackup;
const PLATFORMS_BACKUP = {
  kind: "selective",
  fallback: "exclude",
  selectors: [
    { relativePattern: "pairing/**", action: "exclude" },
    { relativePattern: "whatsapp/bridge.log", action: "exclude" },
    { relativePattern: "whatsapp/session/**", action: "exclude" },
  ],
} as const satisfies HermesSelectiveBackup;

const DURABLE_WRITABLE_DIRECTORY = {
  match: "subtree",
  kind: "directory",
  presence: "optional",
  artifactClass: "durable-state",
  producers: ALL_ROLES,
  readers: SANDBOX_AND_GATEWAY_ROLE,
  required: WRITABLE_DIRECTORY_REQUIREMENTS,
  shields: "keep-writable",
  backup: "directory",
  restore: "restore",
  migration: "preserve",
} as const satisfies HermesArtifactTemplate;
const DURABLE_WRITABLE_SETGID_DIRECTORY = {
  ...DURABLE_WRITABLE_DIRECTORY,
  required: SETGID_DIRECTORY_REQUIREMENTS,
} as const satisfies HermesArtifactTemplate;
const DURABLE_HIGH_RISK_DIRECTORY = {
  ...DURABLE_WRITABLE_DIRECTORY,
  required: HIGH_RISK_DIRECTORY_REQUIREMENTS,
  shields: "seal",
} as const satisfies HermesArtifactTemplate;
const MEMORIES_DIRECTORY = {
  ...DURABLE_WRITABLE_DIRECTORY,
  backup: MEMORIES_BACKUP,
} as const satisfies HermesArtifactTemplate;
const SESSIONS_DIRECTORY = {
  ...DURABLE_WRITABLE_DIRECTORY,
  backup: SESSIONS_BACKUP,
} as const satisfies HermesArtifactTemplate;
const SKILLS_DIRECTORY = {
  ...DURABLE_HIGH_RISK_DIRECTORY,
  artifactClass: "protected-configuration",
  backup: SKILLS_BACKUP,
} as const satisfies HermesArtifactTemplate;
const PAIRING_DIRECTORY = {
  match: "subtree",
  kind: "directory",
  presence: "required",
  artifactClass: "protected-configuration",
  producers: ["root"],
  readers: SANDBOX_AND_GATEWAY_ROLE,
  required: ROOT_PROTECTED_DIRECTORY_REQUIREMENTS,
  shields: "seal",
  backup: PAIRING_BACKUP,
  restore: "restore",
  migration: "preserve",
} as const satisfies HermesArtifactTemplate;
const CRON_DEFINITIONS_DIRECTORY = {
  ...DURABLE_HIGH_RISK_DIRECTORY,
  artifactClass: "protected-configuration",
  backup: CRON_BACKUP,
} as const satisfies HermesArtifactTemplate;
const DURABLE_SELECTIVE_DIRECTORY = {
  ...DURABLE_WRITABLE_DIRECTORY,
  backup: KANBAN_BACKUP,
} as const satisfies HermesArtifactTemplate;
const WEIXIN_STATE_DIRECTORY = {
  ...DURABLE_WRITABLE_SETGID_DIRECTORY,
  required: PRESERVED_SETGID_DIRECTORY_REQUIREMENTS,
  artifactClass: "derived-disposable-state",
  backup: WEIXIN_BACKUP,
  restore: "regenerate",
  migration: "regenerate",
} as const satisfies HermesArtifactTemplate;
const WEIXIN_ACCOUNTS_DIRECTORY = {
  ...WEIXIN_STATE_DIRECTORY,
  backup: WEIXIN_ACCOUNTS_BACKUP,
} as const satisfies HermesArtifactTemplate;
const PLATFORM_ROOT_DIRECTORY = {
  ...DURABLE_WRITABLE_SETGID_DIRECTORY,
  artifactClass: "derived-disposable-state",
  required: ROOT_STICKY_DIRECTORY_REQUIREMENTS,
  backup: PLATFORMS_BACKUP,
  restore: "regenerate",
  migration: "regenerate",
} as const satisfies HermesArtifactTemplate;
const WHATSAPP_ROOT_DIRECTORY = {
  ...PLATFORM_ROOT_DIRECTORY,
  backup: WHATSAPP_BACKUP,
} as const satisfies HermesArtifactTemplate;
const WHATSAPP_SESSION_DIRECTORY = {
  match: "subtree",
  kind: "directory",
  presence: "optional",
  artifactClass: "credential-reference",
  producers: GATEWAY_ROLE,
  readers: GATEWAY_ROLE,
  required: GATEWAY_PRIVATE_DIRECTORY_DISCARD_REQUIREMENTS,
  shields: "keep-writable",
  backup: "exclude",
  restore: "discard",
  migration: "preserve",
} as const satisfies HermesArtifactTemplate;
const DERIVED_WRITABLE_DIRECTORY = {
  match: "subtree",
  kind: "directory",
  presence: "optional",
  artifactClass: "derived-disposable-state",
  producers: ALL_ROLES,
  readers: SANDBOX_AND_GATEWAY_ROLE,
  required: WRITABLE_DIRECTORY_REQUIREMENTS,
  shields: "keep-writable",
  backup: "exclude",
  restore: "regenerate",
  migration: "regenerate",
} as const satisfies HermesArtifactTemplate;
const DERIVED_HIGH_RISK_DIRECTORY = {
  ...DERIVED_WRITABLE_DIRECTORY,
  required: HIGH_RISK_DIRECTORY_REQUIREMENTS,
  shields: "seal",
} as const satisfies HermesArtifactTemplate;
const SQLITE_SIDECAR = {
  match: "exact",
  kind: "file",
  presence: "optional",
  artifactClass: "derived-disposable-state",
  producers: SANDBOX_AND_GATEWAY_ROLE,
  readers: SANDBOX_AND_GATEWAY_ROLE,
  required: SQLITE_SIDECAR_REQUIREMENTS,
  shields: "keep-writable",
  backup: "exclude",
  restore: "discard",
  migration: "preserve",
} as const satisfies HermesArtifactTemplate;
const PRIVATE_SQLITE_SIDECAR = {
  ...SQLITE_SIDECAR,
  producers: GATEWAY_ROLE,
  readers: GATEWAY_ROLE,
  required: PRIVATE_SQLITE_SIDECAR_REQUIREMENTS,
} as const satisfies HermesArtifactTemplate;
const DURABLE_SQLITE_DATABASE = {
  match: "exact",
  kind: "file",
  presence: "optional",
  artifactClass: "durable-state",
  producers: ALL_ROLES,
  readers: SANDBOX_AND_GATEWAY_ROLE,
  required: SQLITE_FILE_REQUIREMENTS,
  shields: "keep-writable",
  backup: "sqlite",
  restore: "restore",
  migration: "preserve",
} as const satisfies HermesArtifactTemplate;
const DURABLE_PRIVATE_SQLITE_DATABASE = {
  ...DURABLE_SQLITE_DATABASE,
  producers: GATEWAY_ROLE,
  readers: GATEWAY_ROLE,
  required: PRIVATE_SQLITE_FILE_REQUIREMENTS,
} as const satisfies HermesArtifactTemplate;
const DASHBOARD_SQLITE_DATABASE = {
  ...DURABLE_SQLITE_DATABASE,
  producers: ["sandbox"],
  readers: ["sandbox"],
  required: SANDBOX_PRIVATE_FILE_REQUIREMENTS,
} as const satisfies HermesArtifactTemplate;
const DASHBOARD_SQLITE_SIDECAR = {
  ...SQLITE_SIDECAR,
  producers: ["sandbox"],
  readers: ["sandbox"],
  required: SANDBOX_PRIVATE_DISCARD_REQUIREMENTS,
} as const satisfies HermesArtifactTemplate;
const DASHBOARD_DERIVED_DIRECTORY = {
  match: "subtree",
  kind: "directory",
  presence: "optional",
  artifactClass: "derived-disposable-state",
  producers: ["sandbox"],
  readers: ["sandbox"],
  required: DASHBOARD_DIRECTORY_REQUIREMENTS,
  shields: "keep-writable",
  backup: "exclude",
  restore: "regenerate",
  migration: "regenerate",
} as const satisfies HermesArtifactTemplate;
const DASHBOARD_DURABLE_FILE = {
  match: "exact",
  kind: "file",
  presence: "optional",
  artifactClass: "durable-state",
  producers: ["sandbox"],
  readers: ["sandbox"],
  required: SANDBOX_PRIVATE_FILE_REQUIREMENTS,
  shields: "keep-writable",
  backup: "file",
  restore: "restore",
  migration: "preserve",
} as const satisfies HermesArtifactTemplate;
const KANBAN_DATABASE = {
  ...DURABLE_SQLITE_DATABASE,
  match: "pattern",
} as const satisfies HermesArtifactTemplate;
const KANBAN_SIDECAR = {
  ...SQLITE_SIDECAR,
  match: "pattern",
} as const satisfies HermesArtifactTemplate;
const KANBAN_DERIVED_DIRECTORY = {
  ...DERIVED_WRITABLE_DIRECTORY,
  match: "pattern",
} as const satisfies HermesArtifactTemplate;
const KANBAN_DURABLE_DIRECTORY = {
  ...DURABLE_WRITABLE_SETGID_DIRECTORY,
  match: "pattern",
} as const satisfies HermesArtifactTemplate;
const KANBAN_HIGH_RISK_DIRECTORY = {
  ...DERIVED_HIGH_RISK_DIRECTORY,
  match: "pattern",
} as const satisfies HermesArtifactTemplate;
const DASHBOARD_KANBAN_DATABASE = {
  ...DASHBOARD_SQLITE_DATABASE,
  match: "pattern",
} as const satisfies HermesArtifactTemplate;
const DASHBOARD_KANBAN_SIDECAR = {
  ...DASHBOARD_SQLITE_SIDECAR,
  match: "pattern",
} as const satisfies HermesArtifactTemplate;
const DASHBOARD_KANBAN_DERIVED_DIRECTORY = {
  ...DASHBOARD_DERIVED_DIRECTORY,
  match: "pattern",
} as const satisfies HermesArtifactTemplate;
const DASHBOARD_KANBAN_DURABLE_DIRECTORY = {
  match: "pattern",
  kind: "directory",
  presence: "optional",
  artifactClass: "durable-state",
  producers: ["sandbox"],
  readers: ["sandbox"],
  required: DASHBOARD_DIRECTORY_REQUIREMENTS,
  shields: "keep-writable",
  backup: "directory",
  restore: "restore",
  migration: "preserve",
} as const satisfies HermesArtifactTemplate;
const KANBAN_RUNTIME_FILE = {
  match: "pattern",
  kind: "file",
  presence: "optional",
  artifactClass: "mutable-runtime-state",
  producers: SANDBOX_AND_GATEWAY_ROLE,
  readers: SANDBOX_AND_GATEWAY_ROLE,
  required: PRODUCER_FILE_DISCARD_REQUIREMENTS,
  shields: "keep-writable",
  backup: "exclude",
  restore: "discard",
  migration: "discard",
} as const satisfies HermesArtifactTemplate;
const DASHBOARD_KANBAN_RUNTIME_FILE = {
  ...KANBAN_RUNTIME_FILE,
  producers: ["sandbox"],
  readers: ["sandbox"],
  required: SANDBOX_PRIVATE_DISCARD_REQUIREMENTS,
} as const satisfies HermesArtifactTemplate;
const DURABLE_SHARED_FILE = {
  match: "exact",
  kind: "file",
  presence: "optional",
  artifactClass: "durable-state",
  producers: ALL_ROLES,
  readers: SANDBOX_AND_GATEWAY_ROLE,
  required: PRODUCER_SHARED_FILE_REQUIREMENTS,
  shields: "keep-writable",
  backup: "file",
  restore: "restore",
  migration: "preserve",
} as const satisfies HermesArtifactTemplate;
const KANBAN_RECOVERY_FILE = {
  ...DURABLE_SHARED_FILE,
  match: "pattern",
} as const satisfies HermesArtifactTemplate;
const DASHBOARD_KANBAN_RECOVERY_FILE = {
  ...DASHBOARD_DURABLE_FILE,
  match: "pattern",
} as const satisfies HermesArtifactTemplate;
const PROTECTED_OPTIONAL_DOCUMENT = {
  match: "exact",
  kind: "file",
  presence: "optional",
  artifactClass: "protected-configuration",
  producers: ["root", "sandbox"],
  readers: SANDBOX_AND_GATEWAY_ROLE,
  required: PROTECTED_DOCUMENT_REQUIREMENTS,
  shields: "seal",
  backup: "file",
  restore: "restore",
  migration: "preserve",
} as const satisfies HermesArtifactTemplate;
const PAIRING_APPROVED_FILE = {
  match: "pattern",
  kind: "file",
  presence: "optional",
  artifactClass: "protected-configuration",
  producers: ["root"],
  readers: SANDBOX_AND_GATEWAY_ROLE,
  required: ROOT_PROTECTED_FILE_REQUIREMENTS,
  shields: "seal",
  backup: "file",
  restore: "restore",
  migration: "preserve",
} as const satisfies HermesArtifactTemplate;
const PAIRING_RUNTIME_FILE = {
  match: "pattern",
  kind: "file",
  presence: "optional",
  artifactClass: "mutable-runtime-state",
  producers: GATEWAY_ROLE,
  readers: GATEWAY_ROLE,
  required: GATEWAY_PRIVATE_DISCARD_REQUIREMENTS,
  shields: "keep-writable",
  backup: "exclude",
  restore: "discard",
  migration: "discard",
} as const satisfies HermesArtifactTemplate;
const WRITABLE_STAGING_FILE = {
  match: "pattern",
  kind: "file",
  presence: "optional",
  artifactClass: "derived-disposable-state",
  producers: ALL_ROLES,
  readers: ALL_ROLES,
  required: PRODUCER_PRIVATE_DISCARD_REQUIREMENTS,
  shields: "keep-writable",
  backup: "exclude",
  restore: "discard",
  migration: "discard",
} as const satisfies HermesArtifactTemplate;
const ROOT_PRIVATE_STAGING_FILE = {
  match: "pattern",
  kind: "file",
  presence: "optional",
  artifactClass: "derived-disposable-state",
  producers: ["root"],
  readers: ["root"],
  required: ROOT_PRIVATE_DISCARD_REQUIREMENTS,
  shields: "unchanged",
  backup: "exclude",
  restore: "discard",
  migration: "discard",
} as const satisfies HermesArtifactTemplate;
const SEALED_STAGING_FILE = {
  ...WRITABLE_STAGING_FILE,
  required: SEALED_STAGING_FILE_REQUIREMENTS,
  shields: "seal",
} as const satisfies HermesArtifactTemplate;
const GATEWAY_DERIVED_FILE = {
  match: "exact",
  kind: "file",
  presence: "optional",
  artifactClass: "derived-disposable-state",
  producers: GATEWAY_ROLE,
  readers: GATEWAY_ROLE,
  required: GATEWAY_FILE_REQUIREMENTS,
  shields: "keep-writable",
  backup: "exclude",
  restore: "discard",
  migration: "discard",
} as const satisfies HermesArtifactTemplate;
const DASHBOARD_DERIVED_FILE = {
  ...GATEWAY_DERIVED_FILE,
  producers: ["sandbox"],
  readers: ["sandbox"],
  required: SANDBOX_PRIVATE_DISCARD_REQUIREMENTS,
} as const satisfies HermesArtifactTemplate;
const COMPATIBILITY_LINK = {
  match: "exact",
  kind: "symlink",
  presence: "required",
  artifactClass: "derived-disposable-state",
  producers: ["root"],
  readers: SANDBOX_AND_GATEWAY_ROLE,
  required: COMPATIBILITY_LINK_REQUIREMENTS,
  shields: "unchanged",
  backup: "exclude",
  restore: "regenerate",
  migration: "regenerate",
} as const satisfies HermesArtifactTemplate;

const SQLITE_SIDECAR_SUFFIXES = ["wal", "shm", "journal"] as const;

function createSqliteSidecars(
  idPrefix: string,
  scope: HermesArtifactScope,
  relativePath: string | HermesHomeRelativePaths,
  template: HermesArtifactTemplate,
  migrationSourcePath?: string,
): HermesManagedArtifact[] {
  const expand = (value: string, suffix: (typeof SQLITE_SIDECAR_SUFFIXES)[number]): string => {
    const expanded = value.replace("{sidecar}", suffix);
    if (expanded === value) throw new Error("SQLite sidecar paths require a {sidecar} placeholder");
    return expanded;
  };

  return SQLITE_SIDECAR_SUFFIXES.map((suffix) => {
    const migrationSource = migrationSourcePath
      ? ({
          migrationSources: [
            {
              relativePath: expand(migrationSourcePath, suffix),
              match: "exact",
              action: "migrate",
              onFailure: "leave-source",
            },
          ],
        } as const)
      : {};
    return {
      id: idPrefix + "-" + suffix,
      scope,
      relativePath:
        typeof relativePath === "string"
          ? expand(relativePath, suffix)
          : {
              default: expand(relativePath.default, suffix),
              namedProfile: expand(relativePath.namedProfile, suffix),
            },
      ...template,
      ...migrationSource,
    };
  });
}

function createPairingArtifacts(): HermesManagedArtifact[] {
  return [
    {
      id: "pairing-approved",
      scope: "agent-home",
      relativePath: "pairing/{platform}-approved.json",
      ...PAIRING_APPROVED_FILE,
      migrationSources: [
        {
          relativePath: "platforms/pairing/{platform}-approved.json",
          match: "pattern",
          action: "migrate",
          onFailure: "leave-source",
        },
      ],
    },
    {
      id: "pairing-approved-write-staging",
      scope: "agent-home",
      relativePath: "pairing/tmp{temp}.tmp",
      ...ROOT_PRIVATE_STAGING_FILE,
    },
    {
      id: "pairing-pending",
      scope: "agent-home",
      relativePath: "runtime/pairing/{platform}-pending.json",
      ...PAIRING_RUNTIME_FILE,
      migrationSources: [
        { relativePath: "pairing/{platform}-pending.json", match: "pattern", action: "discard" },
        {
          relativePath: "platforms/pairing/{platform}-pending.json",
          match: "pattern",
          action: "discard",
        },
      ],
    },
    {
      id: "pairing-rate-limits",
      scope: "agent-home",
      relativePath: "runtime/pairing/_rate_limits.json",
      ...PAIRING_RUNTIME_FILE,
      match: "exact",
      migrationSources: [
        { relativePath: "pairing/_rate_limits.json", match: "exact", action: "discard" },
        {
          relativePath: "platforms/pairing/_rate_limits.json",
          match: "exact",
          action: "discard",
        },
      ],
    },
    {
      id: "pairing-write-staging",
      scope: "agent-home",
      relativePath: "runtime/pairing/tmp{temp}.tmp",
      ...WRITABLE_STAGING_FILE,
      producers: GATEWAY_ROLE,
      readers: GATEWAY_ROLE,
      required: GATEWAY_PRIVATE_DISCARD_REQUIREMENTS,
      migrationSources: [
        {
          relativePath: "platforms/pairing/tmp{temp}.tmp",
          match: "pattern",
          action: "discard",
        },
      ],
    },
  ];
}

function createModelCacheArtifacts(id: string, relativePath: string): HermesManagedArtifact[] {
  return [
    {
      id,
      scope: "agent-home",
      relativePath,
      ...GATEWAY_DERIVED_FILE,
    },
    {
      id: "dashboard-" + id,
      scope: "dashboard",
      relativePath,
      ...DASHBOARD_DERIVED_FILE,
    },
  ];
}

export const HERMES_MANAGED_ARTIFACTS = [
  {
    id: "agent-home-root",
    scope: "agent-home",
    relativePath: ".",
    match: "exact",
    kind: "directory",
    presence: "required",
    artifactClass: "protected-configuration",
    producers: ["root"],
    readers: ALL_ROLES,
    required: HOME_REQUIREMENTS,
    shields: "seal",
    backup: "exclude",
    restore: "regenerate",
    migration: "preserve",
  },
  {
    id: "top-level-atomic-staging",
    scope: "agent-home",
    relativePath: ".{temp}.tmp",
    ...WRITABLE_STAGING_FILE,
  },
  {
    id: "top-level-temporary-staging",
    scope: "agent-home",
    relativePath: "tmp{temp}.tmp",
    ...WRITABLE_STAGING_FILE,
  },
  {
    id: "nemoclaw-protected-write-staging",
    scope: "agent-home",
    relativePath: ".{filename}.nemoclaw.{pid}.{token}",
    ...SEALED_STAGING_FILE,
  },
  {
    id: "profiles-root",
    scope: "default-home",
    relativePath: "profiles",
    match: "exact",
    kind: "directory",
    presence: "required",
    artifactClass: "derived-disposable-state",
    producers: ["root", "sandbox"],
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: HIGH_RISK_DIRECTORY_REQUIREMENTS,
    shields: "seal",
    backup: "exclude",
    restore: "regenerate",
    migration: "regenerate",
  },
  {
    // Descendants stay fail-closed unless a more specific rule names them.
    id: "dashboard-home",
    scope: "dashboard",
    relativePath: ".",
    match: "exact",
    kind: "directory",
    presence: "required",
    artifactClass: "derived-disposable-state",
    producers: ["root", "sandbox"],
    readers: ["sandbox"],
    required: DASHBOARD_DIRECTORY_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "regenerate",
    migration: "regenerate",
  },
  {
    id: "dashboard-atomic-staging",
    scope: "dashboard",
    relativePath: ".{temp}.tmp",
    ...DASHBOARD_DERIVED_FILE,
    match: "pattern",
  },
  {
    id: "dashboard-config-write-staging",
    scope: "dashboard",
    relativePath: "config.yaml.nemoclaw.tmp",
    ...DASHBOARD_DERIVED_FILE,
  },
  {
    id: "config",
    scope: "agent-home",
    relativePath: "config.yaml",
    match: "exact",
    kind: "file",
    presence: "required",
    artifactClass: "protected-configuration",
    producers: ["root", "sandbox"],
    readers: ALL_ROLES,
    required: CONFIG_FILE_REQUIREMENTS,
    shields: "seal",
    backup: { default: "exclude", namedProfile: "file" },
    restore: { default: "regenerate", namedProfile: "restore" },
    migration: "preserve",
  },
  {
    id: "config-hash",
    scope: "default-home",
    relativePath: ".config-hash",
    match: "exact",
    kind: "file",
    presence: "required",
    artifactClass: "protected-configuration",
    producers: ["root", "sandbox"],
    readers: ["root", "sandbox"],
    required: CONFIG_FILE_REQUIREMENTS,
    shields: "seal",
    backup: "exclude",
    restore: "regenerate",
    migration: "regenerate",
  },
  {
    id: "active-profile",
    scope: "default-home",
    relativePath: "active_profile",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "protected-configuration",
    producers: ["root", "sandbox"],
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: CONFIG_FILE_REQUIREMENTS,
    shields: "seal",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "active-profile-write-staging",
    scope: "default-home",
    relativePath: "active_profile.tmp",
    ...SEALED_STAGING_FILE,
  },
  {
    id: "environment",
    scope: "agent-home",
    relativePath: ".env",
    match: "exact",
    kind: "file",
    presence: "required",
    artifactClass: "credential-reference",
    producers: ["root", "sandbox"],
    readers: ALL_ROLES,
    required: CREDENTIAL_FILE_REQUIREMENTS,
    shields: "seal",
    backup: "exclude",
    restore: "regenerate",
    migration: "preserve",
  },
  {
    id: "shell-hook-allowlist",
    scope: "agent-home",
    relativePath: "shell-hooks-allowlist.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "protected-configuration",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: SHARED_CONFIG_FILE_REQUIREMENTS,
    shields: "seal",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "shell-hook-allowlist-lock",
    scope: "agent-home",
    relativePath: "shell-hooks-allowlist.json.lock",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_SHARED_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "shell-hook-allowlist-write-staging",
    scope: "agent-home",
    relativePath: "shell-hooks-allowlist.json.{temp}.tmp",
    ...SEALED_STAGING_FILE,
  },
  {
    id: "environment-sync-lock",
    scope: "agent-home",
    relativePath: ".sync.lock",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_SHARED_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "gateway-voice-mode",
    scope: "agent-home",
    relativePath: "gateway_voice_mode.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "durable-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "telegram-sticker-cache",
    scope: "agent-home",
    relativePath: "sticker_cache.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "derived-disposable-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  ...createModelCacheArtifacts("context-length-cache", "context_length_cache.yaml"),
  ...createModelCacheArtifacts("models-dev-cache", "models_dev_cache.json"),
  ...createModelCacheArtifacts("ollama-cloud-models-cache", "ollama_cloud_models_cache.json"),
  {
    id: "clean-shutdown-marker",
    scope: "agent-home",
    relativePath: ".clean_shutdown",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "authentication-state",
    scope: "agent-home",
    relativePath: "auth.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "credential-reference",
    producers: ROOT_AND_GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "preserve",
  },
  {
    id: "authentication-write-staging",
    scope: "agent-home",
    relativePath: "auth.json.tmp.{pid}.{token}",
    ...WRITABLE_STAGING_FILE,
    producers: ROOT_AND_GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
  },
  {
    id: "authentication-lock",
    scope: "agent-home",
    relativePath: "auth.lock",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "profile-metadata",
    scope: "named-profile",
    relativePath: "profile.yaml",
    match: "exact",
    kind: "file",
    presence: "required",
    artifactClass: "protected-configuration",
    producers: ["sandbox"],
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PROTECTED_DOCUMENT_REQUIREMENTS,
    shields: "seal",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "bundled-skills-opt-out",
    scope: "named-profile",
    relativePath: ".no-bundled-skills",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "protected-configuration",
    producers: ["sandbox"],
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PROTECTED_DOCUMENT_REQUIREMENTS,
    shields: "seal",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "tool-home",
    scope: "agent-home",
    relativePath: "home",
    ...DERIVED_WRITABLE_DIRECTORY,
    artifactClass: "mutable-runtime-state",
    migration: "preserve",
  },
  {
    id: "lsp-cache",
    scope: "agent-home",
    relativePath: "lsp",
    ...DERIVED_HIGH_RISK_DIRECTORY,
  },
  {
    id: "lsp-powershell-runtime",
    scope: "agent-home",
    relativePath: "lsp/pses",
    match: "subtree",
    kind: "directory",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: SETGID_DIRECTORY_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "regenerate",
    migration: "discard",
  },
  {
    id: "dashboard-config",
    scope: "dashboard",
    relativePath: "config.yaml",
    match: "exact",
    kind: "file",
    presence: "required",
    artifactClass: "protected-configuration",
    producers: ["sandbox"],
    readers: ["sandbox"],
    required: SANDBOX_PRIVATE_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "regenerate",
    migration: "regenerate",
  },
  {
    id: "dashboard-environment",
    scope: "dashboard",
    relativePath: ".env",
    match: "exact",
    kind: "file",
    presence: "required",
    artifactClass: "credential-reference",
    producers: ["sandbox"],
    readers: ["sandbox"],
    required: SANDBOX_PRIVATE_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "regenerate",
    migration: "regenerate",
  },
  {
    id: "dashboard-status",
    scope: "dashboard",
    relativePath: "gateway_state.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: ["sandbox"],
    readers: ["sandbox"],
    required: SANDBOX_PRIVATE_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "dashboard-memory",
    scope: "dashboard",
    relativePath: "MEMORY.md",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "durable-state",
    producers: ["sandbox"],
    readers: ["sandbox"],
    required: SANDBOX_PRIVATE_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "dashboard-user",
    scope: "dashboard",
    relativePath: "USER.md",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "protected-configuration",
    producers: ["sandbox"],
    readers: ["sandbox"],
    required: SANDBOX_PRIVATE_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  { id: "memories", scope: "agent-home", relativePath: "memories", ...MEMORIES_DIRECTORY },
  {
    id: "memory-document-lock",
    scope: "agent-home",
    relativePath: "memories/MEMORY.md.lock",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_SHARED_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "user-document-lock",
    scope: "agent-home",
    relativePath: "memories/USER.md.lock",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_SHARED_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "memory-write-staging",
    scope: "agent-home",
    relativePath: "memories/.mem_{temp}.tmp",
    ...WRITABLE_STAGING_FILE,
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
  },
  { id: "sessions", scope: "agent-home", relativePath: "sessions", ...SESSIONS_DIRECTORY },
  {
    id: "sessions-write-staging",
    scope: "agent-home",
    relativePath: "sessions/.sessions_{temp}.tmp",
    match: "pattern",
    kind: "file",
    presence: "optional",
    artifactClass: "derived-disposable-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "hook-output-spill",
    scope: "agent-home",
    relativePath: "hook_outputs",
    ...DERIVED_WRITABLE_DIRECTORY,
    producers: SANDBOX_AND_GATEWAY_ROLE,
  },
  { id: "plans", scope: "agent-home", relativePath: "plans", ...DURABLE_WRITABLE_DIRECTORY },
  {
    id: "scripts",
    scope: "agent-home",
    relativePath: "scripts",
    ...DURABLE_HIGH_RISK_DIRECTORY,
  },
  {
    id: "knowledge",
    scope: "agent-home",
    relativePath: "knowledge",
    ...DURABLE_HIGH_RISK_DIRECTORY,
  },
  {
    id: "preferences",
    scope: "agent-home",
    relativePath: "preferences",
    ...DURABLE_HIGH_RISK_DIRECTORY,
  },
  {
    id: "kanban-state",
    scope: "agent-home",
    relativePath: "kanban",
    ...DURABLE_SELECTIVE_DIRECTORY,
  },
  {
    id: "kanban-workspaces",
    scope: "agent-home",
    relativePath: "kanban/workspaces",
    ...DERIVED_HIGH_RISK_DIRECTORY,
  },
  {
    id: "kanban-logs",
    scope: "agent-home",
    relativePath: "kanban/logs",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "kanban-attachments",
    scope: "agent-home",
    relativePath: "kanban/attachments",
    ...DURABLE_WRITABLE_SETGID_DIRECTORY,
  },
  {
    id: "kanban-current",
    scope: "agent-home",
    relativePath: "kanban/current",
    ...DURABLE_SHARED_FILE,
  },
  {
    id: "kanban-dispatcher-lock",
    scope: "agent-home",
    relativePath: "kanban/.dispatcher.lock",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "kanban-board-database",
    scope: "agent-home",
    relativePath: "kanban/boards/{board}/kanban.db",
    ...KANBAN_DATABASE,
  },
  ...createSqliteSidecars(
    "kanban-board-database-sidecar",
    "agent-home",
    "kanban/boards/{board}/kanban.db-{sidecar}",
    KANBAN_SIDECAR,
  ),
  {
    id: "kanban-board-lock",
    scope: "agent-home",
    relativePath: "kanban/boards/{board}/kanban.db.{lock}.lock",
    ...KANBAN_RUNTIME_FILE,
  },
  {
    id: "kanban-board-recovery",
    scope: "agent-home",
    relativePath: "kanban/boards/{board}/kanban.db.corrupt.{backup}",
    ...KANBAN_RECOVERY_FILE,
  },
  {
    id: "kanban-board-workspaces",
    scope: "agent-home",
    relativePath: "kanban/boards/{board}/workspaces/**",
    ...KANBAN_HIGH_RISK_DIRECTORY,
  },
  {
    id: "kanban-board-attachments",
    scope: "agent-home",
    relativePath: "kanban/boards/{board}/attachments/**",
    ...KANBAN_DURABLE_DIRECTORY,
  },
  {
    id: "kanban-board-logs",
    scope: "agent-home",
    relativePath: "kanban/boards/{board}/logs/**",
    ...KANBAN_DERIVED_DIRECTORY,
  },
  {
    id: "archived-kanban-board-database",
    scope: "agent-home",
    relativePath: "kanban/boards/_archived/{board}/kanban.db",
    ...KANBAN_DATABASE,
  },
  ...createSqliteSidecars(
    "archived-kanban-board-database-sidecar",
    "agent-home",
    "kanban/boards/_archived/{board}/kanban.db-{sidecar}",
    KANBAN_SIDECAR,
  ),
  {
    id: "archived-kanban-board-lock",
    scope: "agent-home",
    relativePath: "kanban/boards/_archived/{board}/kanban.db.{lock}.lock",
    ...KANBAN_RUNTIME_FILE,
  },
  {
    id: "archived-kanban-board-recovery",
    scope: "agent-home",
    relativePath: "kanban/boards/_archived/{board}/kanban.db.corrupt.{backup}",
    ...KANBAN_RECOVERY_FILE,
  },
  {
    id: "archived-kanban-board-workspaces",
    scope: "agent-home",
    relativePath: "kanban/boards/_archived/{board}/workspaces/**",
    ...KANBAN_HIGH_RISK_DIRECTORY,
  },
  {
    id: "archived-kanban-board-attachments",
    scope: "agent-home",
    relativePath: "kanban/boards/_archived/{board}/attachments/**",
    ...KANBAN_DURABLE_DIRECTORY,
  },
  {
    id: "archived-kanban-board-logs",
    scope: "agent-home",
    relativePath: "kanban/boards/_archived/{board}/logs/**",
    ...KANBAN_DERIVED_DIRECTORY,
  },
  {
    id: "dashboard-kanban-state",
    scope: "dashboard",
    relativePath: "kanban",
    match: "subtree",
    kind: "directory",
    presence: "optional",
    artifactClass: "durable-state",
    producers: ["sandbox"],
    readers: ["sandbox"],
    required: DASHBOARD_DIRECTORY_REQUIREMENTS,
    shields: "keep-writable",
    backup: KANBAN_BACKUP,
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "dashboard-kanban-workspaces",
    scope: "dashboard",
    relativePath: "kanban/workspaces",
    match: "subtree",
    kind: "directory",
    presence: "optional",
    artifactClass: "derived-disposable-state",
    producers: ["sandbox"],
    readers: ["sandbox"],
    required: DASHBOARD_DIRECTORY_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "regenerate",
    migration: "regenerate",
  },
  {
    id: "dashboard-kanban-logs",
    scope: "dashboard",
    relativePath: "kanban/logs",
    match: "subtree",
    kind: "directory",
    presence: "optional",
    artifactClass: "derived-disposable-state",
    producers: ["sandbox"],
    readers: ["sandbox"],
    required: DASHBOARD_DIRECTORY_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "regenerate",
    migration: "regenerate",
  },
  {
    id: "dashboard-kanban-attachments",
    scope: "dashboard",
    relativePath: "kanban/attachments",
    match: "subtree",
    kind: "directory",
    presence: "optional",
    artifactClass: "durable-state",
    producers: ["sandbox"],
    readers: ["sandbox"],
    required: DASHBOARD_DIRECTORY_REQUIREMENTS,
    shields: "keep-writable",
    backup: "directory",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "dashboard-kanban-current",
    scope: "dashboard",
    relativePath: "kanban/current",
    ...DASHBOARD_DURABLE_FILE,
  },
  {
    id: "dashboard-kanban-board-database",
    scope: "dashboard",
    relativePath: "kanban/boards/{board}/kanban.db",
    ...DASHBOARD_KANBAN_DATABASE,
  },
  ...createSqliteSidecars(
    "dashboard-kanban-board-database-sidecar",
    "dashboard",
    "kanban/boards/{board}/kanban.db-{sidecar}",
    DASHBOARD_KANBAN_SIDECAR,
  ),
  {
    id: "dashboard-kanban-board-lock",
    scope: "dashboard",
    relativePath: "kanban/boards/{board}/kanban.db.{lock}.lock",
    ...DASHBOARD_KANBAN_RUNTIME_FILE,
  },
  {
    id: "dashboard-kanban-board-recovery",
    scope: "dashboard",
    relativePath: "kanban/boards/{board}/kanban.db.corrupt.{backup}",
    ...DASHBOARD_KANBAN_RECOVERY_FILE,
  },
  {
    id: "dashboard-kanban-board-workspaces",
    scope: "dashboard",
    relativePath: "kanban/boards/{board}/workspaces/**",
    ...DASHBOARD_KANBAN_DERIVED_DIRECTORY,
  },
  {
    id: "dashboard-kanban-board-attachments",
    scope: "dashboard",
    relativePath: "kanban/boards/{board}/attachments/**",
    ...DASHBOARD_KANBAN_DURABLE_DIRECTORY,
  },
  {
    id: "dashboard-kanban-board-logs",
    scope: "dashboard",
    relativePath: "kanban/boards/{board}/logs/**",
    ...DASHBOARD_KANBAN_DERIVED_DIRECTORY,
  },
  {
    id: "dashboard-archived-kanban-board-database",
    scope: "dashboard",
    relativePath: "kanban/boards/_archived/{board}/kanban.db",
    ...DASHBOARD_KANBAN_DATABASE,
  },
  ...createSqliteSidecars(
    "dashboard-archived-kanban-board-database-sidecar",
    "dashboard",
    "kanban/boards/_archived/{board}/kanban.db-{sidecar}",
    DASHBOARD_KANBAN_SIDECAR,
  ),
  {
    id: "dashboard-archived-kanban-board-lock",
    scope: "dashboard",
    relativePath: "kanban/boards/_archived/{board}/kanban.db.{lock}.lock",
    ...DASHBOARD_KANBAN_RUNTIME_FILE,
  },
  {
    id: "dashboard-archived-kanban-board-recovery",
    scope: "dashboard",
    relativePath: "kanban/boards/_archived/{board}/kanban.db.corrupt.{backup}",
    ...DASHBOARD_KANBAN_RECOVERY_FILE,
  },
  {
    id: "dashboard-archived-kanban-board-workspaces",
    scope: "dashboard",
    relativePath: "kanban/boards/_archived/{board}/workspaces/**",
    ...DASHBOARD_KANBAN_DERIVED_DIRECTORY,
  },
  {
    id: "dashboard-archived-kanban-board-attachments",
    scope: "dashboard",
    relativePath: "kanban/boards/_archived/{board}/attachments/**",
    ...DASHBOARD_KANBAN_DURABLE_DIRECTORY,
  },
  {
    id: "dashboard-archived-kanban-board-logs",
    scope: "dashboard",
    relativePath: "kanban/boards/_archived/{board}/logs/**",
    ...DASHBOARD_KANBAN_DERIVED_DIRECTORY,
  },
  {
    id: "skills-prompt-snapshot",
    scope: "agent-home",
    relativePath: "runtime/skills-prompt-snapshot.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "derived-disposable-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_SHARED_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
    migrationSources: [
      {
        relativePath: ".skills_prompt_snapshot.json",
        match: "exact",
        action: "discard",
      },
    ],
  },
  { id: "skills", scope: "agent-home", relativePath: "skills", ...SKILLS_DIRECTORY },
  {
    id: "skills-write-staging",
    scope: "agent-home",
    relativePath: "skills/.{temp}.tmp",
    ...SEALED_STAGING_FILE,
  },
  {
    id: "skills-descendant-write-staging",
    scope: "agent-home",
    relativePath: "skills/**/.{filename}.tmp.{temp}",
    ...SEALED_STAGING_FILE,
  },
  {
    id: "skills-hub-lock-staging",
    scope: "agent-home",
    relativePath: "skills/.hub/.lock_{temp}.tmp",
    ...SEALED_STAGING_FILE,
  },
  {
    id: "curator-state",
    scope: "agent-home",
    relativePath: "runtime/curator/state.json",
    ...DURABLE_SHARED_FILE,
    producers: SANDBOX_AND_GATEWAY_ROLE,
    migrationSources: [
      {
        relativePath: "skills/.curator_state",
        match: "exact",
        action: "migrate",
        onFailure: "leave-source",
      },
    ],
  },
  {
    id: "curator-recovery",
    scope: "agent-home",
    relativePath: "runtime/curator/backups",
    ...DURABLE_WRITABLE_SETGID_DIRECTORY,
    producers: SANDBOX_AND_GATEWAY_ROLE,
    migrationSources: [
      {
        relativePath: "skills/.curator_backups",
        match: "subtree",
        action: "migrate",
        onFailure: "leave-source",
      },
    ],
  },
  {
    id: "curator-archive",
    scope: "agent-home",
    relativePath: "skills/.archive",
    ...DURABLE_HIGH_RISK_DIRECTORY,
    artifactClass: "protected-configuration",
  },
  {
    id: "curator-suppression",
    scope: "agent-home",
    relativePath: "skills/.curator_suppressed",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "protected-configuration",
    producers: ALL_ROLES,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: SHARED_CONFIG_FILE_REQUIREMENTS,
    shields: "seal",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "skill-usage-state",
    scope: "agent-home",
    relativePath: "runtime/skill-usage.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "durable-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_SHARED_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "file",
    restore: "restore",
    migration: "preserve",
    migrationSources: [
      {
        relativePath: "skills/.usage.json",
        match: "exact",
        action: "migrate",
        onFailure: "leave-source",
      },
    ],
  },
  {
    id: "skill-usage-lock",
    scope: "agent-home",
    relativePath: "runtime/skill-usage.json.lock",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_SHARED_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  { id: "plugins", scope: "agent-home", relativePath: "plugins", ...DURABLE_HIGH_RISK_DIRECTORY },
  {
    id: "cron-definitions-root",
    scope: "agent-home",
    relativePath: "cron",
    ...CRON_DEFINITIONS_DIRECTORY,
  },
  {
    id: "cron-write-staging",
    scope: "agent-home",
    relativePath: "cron/.{temp}.tmp",
    ...SEALED_STAGING_FILE,
  },
  {
    id: "cron-output-write-staging",
    scope: "agent-home",
    relativePath: "cron/output/{job}/.output_{temp}.tmp",
    ...SEALED_STAGING_FILE,
  },
  {
    id: "runtime-cron-output-write-staging",
    scope: "agent-home",
    relativePath: "runtime/cron/output/{job}/.output_{temp}.tmp",
    ...WRITABLE_STAGING_FILE,
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
  },
  {
    // Hermes currently mixes these definitions with mutable run metadata.
    // The cron-jobs-schema-split gap records the consumer work needed before
    // Shields can enforce this target posture.
    id: "cron-job-definitions",
    scope: "agent-home",
    relativePath: "cron/jobs.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "protected-configuration",
    producers: ALL_ROLES,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: SHARED_CONFIG_FILE_REQUIREMENTS,
    shields: "seal",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "cron-job-runtime-state",
    scope: "agent-home",
    relativePath: "runtime/cron/job-state.json",
    ...DURABLE_SHARED_FILE,
    producers: SANDBOX_AND_GATEWAY_ROLE,
  },
  {
    id: "cron-tick-lock",
    scope: "agent-home",
    relativePath: "runtime/cron/.tick.lock",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_SHARED_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
    migrationSources: [
      {
        relativePath: "cron/.tick.lock",
        match: "exact",
        action: "discard",
      },
    ],
  },
  {
    id: "cron-jobs-lock",
    scope: "agent-home",
    relativePath: "runtime/cron/.jobs.lock",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_SHARED_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
    migrationSources: [
      {
        relativePath: "cron/.jobs.lock",
        match: "exact",
        action: "discard",
      },
    ],
  },
  {
    id: "cron-suggestions",
    scope: "agent-home",
    relativePath: "runtime/cron/suggestions.json",
    ...DURABLE_SHARED_FILE,
    producers: SANDBOX_AND_GATEWAY_ROLE,
    migrationSources: [
      {
        relativePath: "cron/suggestions.json",
        match: "exact",
        action: "migrate",
        onFailure: "leave-source",
      },
    ],
  },
  {
    id: "cron-output",
    scope: "agent-home",
    relativePath: "runtime/cron/output",
    ...DURABLE_WRITABLE_SETGID_DIRECTORY,
    producers: SANDBOX_AND_GATEWAY_ROLE,
    migrationSources: [
      {
        relativePath: "cron/output",
        match: "subtree",
        action: "migrate",
        onFailure: "leave-source",
      },
    ],
  },
  {
    id: "cron-ticker-heartbeat",
    scope: "agent-home",
    relativePath: "runtime/cron/ticker_heartbeat",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_SHARED_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
    migrationSources: [
      {
        relativePath: "cron/ticker_heartbeat",
        match: "exact",
        action: "discard",
      },
    ],
  },
  {
    id: "cron-ticker-last-success",
    scope: "agent-home",
    relativePath: "runtime/cron/ticker_last_success",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_SHARED_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
    migrationSources: [
      {
        relativePath: "cron/ticker_last_success",
        match: "exact",
        action: "discard",
      },
    ],
  },
  { id: "skins", scope: "agent-home", relativePath: "skins", ...DURABLE_HIGH_RISK_DIRECTORY },
  {
    id: "workspace",
    scope: "agent-home",
    relativePath: "workspace",
    ...DURABLE_HIGH_RISK_DIRECTORY,
  },
  {
    id: "platform-state",
    scope: "agent-home",
    relativePath: "platforms",
    ...PLATFORM_ROOT_DIRECTORY,
  },
  {
    id: "whatsapp-platform",
    scope: "agent-home",
    relativePath: "platforms/whatsapp",
    ...WHATSAPP_ROOT_DIRECTORY,
  },
  {
    id: "whatsapp-session",
    scope: "agent-home",
    relativePath: "platforms/whatsapp/session",
    ...WHATSAPP_SESSION_DIRECTORY,
  },
  {
    id: "legacy-whatsapp-platform",
    scope: "agent-home",
    relativePath: "whatsapp",
    ...WHATSAPP_ROOT_DIRECTORY,
  },
  {
    id: "legacy-whatsapp-session",
    scope: "agent-home",
    relativePath: "whatsapp/session",
    ...WHATSAPP_SESSION_DIRECTORY,
  },
  {
    id: "whatsapp-bridge-log",
    scope: "agent-home",
    relativePath: "platforms/whatsapp/bridge.log",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "derived-disposable-state",
    producers: GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: GATEWAY_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "legacy-whatsapp-bridge-log",
    scope: "agent-home",
    relativePath: "whatsapp/bridge.log",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "derived-disposable-state",
    producers: GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: GATEWAY_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "whatsapp-bridge-pid",
    scope: "agent-home",
    relativePath: "platforms/whatsapp/session/bridge.pid",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "legacy-whatsapp-bridge-pid",
    scope: "agent-home",
    relativePath: "whatsapp/session/bridge.pid",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "weixin-state",
    scope: "agent-home",
    relativePath: "weixin",
    ...WEIXIN_STATE_DIRECTORY,
  },
  {
    id: "weixin-accounts",
    scope: "agent-home",
    relativePath: "weixin/accounts",
    ...WEIXIN_ACCOUNTS_DIRECTORY,
  },
  {
    id: "weixin-context-tokens",
    scope: "agent-home",
    relativePath: "weixin/accounts/{account}.context-tokens.json",
    match: "pattern",
    kind: "file",
    presence: "optional",
    artifactClass: "durable-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "weixin-sync-cursor",
    scope: "agent-home",
    relativePath: "weixin/accounts/{account}.sync.json",
    match: "pattern",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "preserve",
  },
  {
    id: "pairing-state",
    scope: "agent-home",
    relativePath: "pairing",
    ...PAIRING_DIRECTORY,
  },
  {
    id: "pairing-runtime-state",
    scope: "agent-home",
    relativePath: "runtime/pairing",
    match: "subtree",
    kind: "directory",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_DIRECTORY_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  ...createPairingArtifacts(),
  {
    id: "feishu-comment-rules",
    scope: "agent-home",
    relativePath: "feishu_comment_rules.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "protected-configuration",
    producers: ["sandbox"],
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: CONFIG_FILE_REQUIREMENTS,
    shields: "seal",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "feishu-comment-pairing",
    scope: "agent-home",
    relativePath: "feishu_comment_pairing.json",
    match: "exact",
    kind: "file",
    presence: "required",
    artifactClass: "protected-configuration",
    producers: ["root"],
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: ROOT_PROTECTED_FILE_REQUIREMENTS,
    shields: "seal",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "feishu-comment-pairing-write-staging",
    scope: "agent-home",
    relativePath: "feishu_comment_pairing.tmp",
    ...ROOT_PRIVATE_STAGING_FILE,
    match: "exact",
  },
  {
    id: "logs",
    scope: "agent-home",
    relativePath: "logs",
    ...DERIVED_WRITABLE_DIRECTORY,
    required: SETGID_DIRECTORY_REQUIREMENTS,
  },
  {
    id: "logs-curator",
    scope: "agent-home",
    relativePath: "logs/curator",
    ...DERIVED_WRITABLE_DIRECTORY,
    required: SETGID_DIRECTORY_REQUIREMENTS,
  },
  { id: "cache", scope: "agent-home", relativePath: "cache", ...DERIVED_WRITABLE_DIRECTORY },
  {
    id: "legacy-web-cache",
    scope: "agent-home",
    relativePath: "web_cache",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "legacy-delegation-cache",
    scope: "agent-home",
    relativePath: "delegation_cache",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "legacy-piper-voices-cache",
    scope: "agent-home",
    relativePath: "piper_voices_cache",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "hooks-cache",
    scope: "agent-home",
    relativePath: "hooks",
    ...DERIVED_HIGH_RISK_DIRECTORY,
  },
  {
    id: "image-cache",
    scope: "agent-home",
    relativePath: "image_cache",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "audio-cache",
    scope: "agent-home",
    relativePath: "audio_cache",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "nemoclaw-plugin",
    scope: "agent-home",
    relativePath: "plugins/nemoclaw",
    ...DERIVED_HIGH_RISK_DIRECTORY,
  },
  {
    id: "document-cache",
    scope: "agent-home",
    relativePath: "document_cache",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "browser-screenshots",
    scope: "agent-home",
    relativePath: "browser_screenshots",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "checkpoints",
    scope: "agent-home",
    relativePath: "checkpoints",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "sandboxes",
    scope: "agent-home",
    relativePath: "sandboxes",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "upstream-backups",
    scope: "agent-home",
    relativePath: "backups",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "upstream-state-snapshots",
    scope: "agent-home",
    relativePath: "state-snapshots",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "local-runtime",
    scope: "agent-home",
    relativePath: "local",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "managed-binaries",
    scope: "agent-home",
    relativePath: "bin",
    ...DERIVED_HIGH_RISK_DIRECTORY,
  },
  {
    id: "tirith-binary",
    scope: "agent-home",
    relativePath: "bin/tirith",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "derived-disposable-state",
    producers: GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: GATEWAY_EXECUTABLE_REQUIREMENTS,
    shields: "seal",
    backup: "exclude",
    restore: "regenerate",
    migration: "regenerate",
  },
  {
    id: "managed-node",
    scope: "agent-home",
    relativePath: "node",
    ...DERIVED_HIGH_RISK_DIRECTORY,
  },
  {
    id: "node-modules",
    scope: "default-home",
    relativePath: "node_modules",
    ...DERIVED_HIGH_RISK_DIRECTORY,
  },
  {
    id: "upstream-source",
    scope: "default-home",
    relativePath: "hermes-agent",
    ...DERIVED_HIGH_RISK_DIRECTORY,
  },
  {
    id: "upstream-worktrees",
    scope: "default-home",
    relativePath: ".worktrees",
    ...DERIVED_HIGH_RISK_DIRECTORY,
  },
  {
    id: "generated-images",
    scope: "agent-home",
    relativePath: "images",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "pastes",
    scope: "agent-home",
    relativePath: "pastes",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "video-cache",
    scope: "agent-home",
    relativePath: "video_cache",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "temporary-vision-images",
    scope: "agent-home",
    relativePath: "temp_vision_images",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "temporary-video-files",
    scope: "agent-home",
    relativePath: "temp_video_files",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "spawn-trees",
    scope: "agent-home",
    relativePath: "spawn-trees",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "moa-traces",
    scope: "agent-home",
    relativePath: "moa-traces",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "pending-runtime",
    scope: "agent-home",
    relativePath: "pending",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  {
    id: "temporary-runtime",
    scope: "agent-home",
    relativePath: "tmp",
    ...DERIVED_WRITABLE_DIRECTORY,
  },
  { id: "memory-document", scope: "agent-home", relativePath: "MEMORY.md", ...DURABLE_SHARED_FILE },
  { id: "todo-state", scope: "agent-home", relativePath: "todo.json", ...DURABLE_SHARED_FILE },
  {
    id: "user-document",
    scope: "agent-home",
    relativePath: "USER.md",
    ...PROTECTED_OPTIONAL_DOCUMENT,
  },
  {
    id: "system-prompt",
    scope: "agent-home",
    relativePath: "system_prompt.md",
    ...PROTECTED_OPTIONAL_DOCUMENT,
  },
  {
    id: "agents-instructions",
    scope: "agent-home",
    relativePath: "AGENTS.md",
    ...PROTECTED_OPTIONAL_DOCUMENT,
  },
  {
    id: "claude-instructions",
    scope: "agent-home",
    relativePath: "CLAUDE.md",
    ...PROTECTED_OPTIONAL_DOCUMENT,
  },
  {
    id: "cursor-rules",
    scope: "agent-home",
    relativePath: ".cursorrules",
    ...PROTECTED_OPTIONAL_DOCUMENT,
  },
  {
    id: "soul",
    scope: "agent-home",
    relativePath: "SOUL.md",
    match: "exact",
    kind: "file",
    presence: "required",
    artifactClass: "protected-configuration",
    producers: ["root", "sandbox"],
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PROTECTED_DOCUMENT_REQUIREMENTS,
    shields: "seal",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "tui-history",
    scope: "agent-home",
    relativePath: ".hermes_history",
    match: "exact",
    kind: "file",
    presence: "required",
    artifactClass: "durable-state",
    producers: ["root", "sandbox"],
    readers: ["sandbox"],
    required: SANDBOX_SHARED_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "runtime-directory",
    scope: "agent-home",
    relativePath: "runtime",
    match: "subtree",
    kind: "directory",
    presence: "required",
    artifactClass: "mutable-runtime-state",
    producers: ALL_ROLES,
    readers: ALL_ROLES,
    required: GATEWAY_STICKY_DIRECTORY_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "regenerate",
    migration: "regenerate",
  },
  {
    id: "process-registry",
    scope: "agent-home",
    relativePath: "processes.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "drain-request",
    scope: "agent-home",
    relativePath: ".drain_request.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_SHARED_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "restart-notification",
    scope: "agent-home",
    relativePath: ".restart_notify.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: ROOT_AND_GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "preserve",
  },
  {
    id: "restart-notification-deduplication",
    scope: "agent-home",
    relativePath: ".restart_last_processed.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: ROOT_AND_GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "preserve",
  },
  {
    id: "restart-pending",
    scope: "agent-home",
    relativePath: ".restart_pending.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "preserve",
  },
  {
    id: "restart-failure-counts",
    scope: "agent-home",
    relativePath: ".restart_failure_counts",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "preserve",
  },
  {
    id: "gateway-start-ledger",
    scope: "agent-home",
    relativePath: "gateway-starts.log",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: ALL_ROLES,
    required: GATEWAY_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "gateway-start-ledger-write-staging",
    scope: "agent-home",
    relativePath: "gateway-starts.tmp",
    ...GATEWAY_DERIVED_FILE,
    readers: ALL_ROLES,
  },
  {
    id: "process-state-directory",
    scope: "agent-home",
    relativePath: "state",
    match: "subtree",
    kind: "directory",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: ROOT_AND_GATEWAY_ROLE,
    readers: ALL_ROLES,
    required: GATEWAY_DIRECTORY_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "gateway-directory",
    scope: "agent-home",
    relativePath: "gateway",
    match: "subtree",
    kind: "directory",
    presence: "required",
    artifactClass: "mutable-runtime-state",
    producers: ALL_ROLES,
    readers: ALL_ROLES,
    required: GATEWAY_DIRECTORY_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "regenerate",
    migration: "regenerate",
  },
  {
    id: "main-state-database",
    scope: "agent-home",
    relativePath: { default: "runtime/state.db", namedProfile: "state.db" },
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "durable-state",
    producers: ALL_ROLES,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: SQLITE_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "sqlite",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "cron-execution-database",
    scope: "agent-home",
    relativePath: "runtime/cron-executions.db",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "durable-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: SQLITE_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "sqlite",
    restore: "restore",
    migration: "preserve",
    migrationSources: [
      {
        relativePath: "cron/executions.db",
        match: "exact",
        action: "migrate",
        onFailure: "leave-source",
      },
    ],
  },
  {
    id: "discord-recovery-database",
    scope: "agent-home",
    relativePath: "gateway/discord_message_recovery.db",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "durable-state",
    producers: GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: GATEWAY_SHARED_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "sqlite",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "discord-thread-state",
    scope: "agent-home",
    relativePath: "discord_threads.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "durable-state",
    producers: GATEWAY_ROLE,
    readers: GATEWAY_ROLE,
    required: GATEWAY_PRIVATE_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "default-kanban-database",
    scope: "default-home",
    relativePath: "kanban.db",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "durable-state",
    producers: ALL_ROLES,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: SQLITE_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "sqlite",
    restore: "restore",
    migration: "preserve",
  },
  {
    id: "default-kanban-lock",
    scope: "default-home",
    relativePath: "kanban.db.{lock}.lock",
    ...KANBAN_RUNTIME_FILE,
  },
  {
    id: "default-kanban-recovery",
    scope: "default-home",
    relativePath: "kanban.db.corrupt.{backup}",
    ...KANBAN_RECOVERY_FILE,
  },
  {
    id: "dashboard-kanban-database",
    scope: "dashboard",
    relativePath: "kanban.db",
    ...DASHBOARD_SQLITE_DATABASE,
  },
  {
    id: "dashboard-default-kanban-lock",
    scope: "dashboard",
    relativePath: "kanban.db.{lock}.lock",
    ...DASHBOARD_KANBAN_RUNTIME_FILE,
  },
  {
    id: "dashboard-default-kanban-recovery",
    scope: "dashboard",
    relativePath: "kanban.db.corrupt.{backup}",
    ...DASHBOARD_KANBAN_RECOVERY_FILE,
  },
  {
    id: "projects-database",
    scope: "agent-home",
    relativePath: "projects.db",
    ...DURABLE_SQLITE_DATABASE,
  },
  {
    id: "response-store-database",
    scope: "agent-home",
    relativePath: "response_store.db",
    ...DURABLE_PRIVATE_SQLITE_DATABASE,
  },
  {
    id: "memory-store-database",
    scope: "agent-home",
    relativePath: "memory_store.db",
    ...DURABLE_SQLITE_DATABASE,
  },
  {
    id: "verification-evidence-database",
    scope: "agent-home",
    relativePath: "verification_evidence.db",
    ...DURABLE_SQLITE_DATABASE,
  },
  {
    id: "gateway-pid",
    scope: "agent-home",
    relativePath: "runtime/gateway.pid",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: ALL_ROLES,
    required: GATEWAY_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "gateway-lock",
    scope: "agent-home",
    relativePath: "runtime/gateway.lock",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: ALL_ROLES,
    required: GATEWAY_SHARED_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "gateway-status",
    scope: "agent-home",
    relativePath: "runtime/gateway_state.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: ALL_ROLES,
    required: GATEWAY_FILE_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "channel-directory",
    scope: "agent-home",
    relativePath: {
      default: "runtime/channel_directory.json",
      namedProfile: "channel_directory.json",
    },
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: SANDBOX_AND_GATEWAY_ROLE,
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: PRODUCER_FILE_DISCARD_REQUIREMENTS,
    shields: "keep-writable",
    backup: "exclude",
    restore: "discard",
    migration: "regenerate",
  },
  {
    id: "channel-aliases",
    scope: "agent-home",
    relativePath: "channel_aliases.json",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "protected-configuration",
    producers: ["root", "sandbox"],
    readers: SANDBOX_AND_GATEWAY_ROLE,
    required: CONFIG_FILE_REQUIREMENTS,
    shields: "seal",
    backup: "file",
    restore: "restore",
    migration: "preserve",
  },
  ...createSqliteSidecars(
    "main-state-sidecar",
    "agent-home",
    {
      default: "runtime/state.db-{sidecar}",
      namedProfile: "state.db-{sidecar}",
    },
    SQLITE_SIDECAR,
  ),
  ...createSqliteSidecars(
    "cron-execution-sidecar",
    "agent-home",
    "runtime/cron-executions.db-{sidecar}",
    SQLITE_SIDECAR,
    "cron/executions.db-{sidecar}",
  ),
  ...createSqliteSidecars(
    "discord-recovery-sidecar",
    "agent-home",
    "gateway/discord_message_recovery.db-{sidecar}",
    SQLITE_SIDECAR,
  ),
  ...createSqliteSidecars(
    "default-kanban-sidecar",
    "default-home",
    "kanban.db-{sidecar}",
    SQLITE_SIDECAR,
  ),
  ...createSqliteSidecars(
    "dashboard-kanban-sidecar",
    "dashboard",
    "kanban.db-{sidecar}",
    DASHBOARD_SQLITE_SIDECAR,
  ),
  ...createSqliteSidecars(
    "projects-database-sidecar",
    "agent-home",
    "projects.db-{sidecar}",
    SQLITE_SIDECAR,
  ),
  ...createSqliteSidecars(
    "response-store-database-sidecar",
    "agent-home",
    "response_store.db-{sidecar}",
    PRIVATE_SQLITE_SIDECAR,
  ),
  ...createSqliteSidecars(
    "memory-store-database-sidecar",
    "agent-home",
    "memory_store.db-{sidecar}",
    SQLITE_SIDECAR,
  ),
  ...createSqliteSidecars(
    "verification-evidence-database-sidecar",
    "agent-home",
    "verification_evidence.db-{sidecar}",
    SQLITE_SIDECAR,
  ),
  {
    id: "state-database-alias",
    scope: "default-home",
    relativePath: "state.db",
    ...COMPATIBILITY_LINK,
  },
  {
    id: "state-wal-alias",
    scope: "default-home",
    relativePath: "state.db-wal",
    ...COMPATIBILITY_LINK,
  },
  {
    id: "state-shm-alias",
    scope: "default-home",
    relativePath: "state.db-shm",
    ...COMPATIBILITY_LINK,
  },
  {
    id: "gateway-lock-alias",
    scope: "default-home",
    relativePath: "gateway.lock",
    ...COMPATIBILITY_LINK,
  },
  {
    id: "gateway-status-alias",
    scope: "default-home",
    relativePath: "gateway_state.json",
    ...COMPATIBILITY_LINK,
  },
  {
    id: "channel-directory-alias",
    scope: "default-home",
    relativePath: "channel_directory.json",
    ...COMPATIBILITY_LINK,
  },
  {
    id: "migration-marker",
    scope: "default-home",
    relativePath: ".migration-complete",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "derived-disposable-state",
    producers: ["root"],
    readers: ["root", "sandbox"],
    required: MIGRATION_MARKER_REQUIREMENTS,
    shields: "unchanged",
    backup: "exclude",
    restore: "discard",
    migration: "regenerate",
  },
  {
    id: "restart-seal-marker",
    scope: "default-home",
    relativePath: ".nemoclaw-hermes-restart-seal",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: ["root"],
    readers: ["root"],
    required: RESTART_MARKER_REQUIREMENTS,
    shields: "unchanged",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
  {
    id: "tirith-retry-marker",
    scope: "agent-home",
    relativePath: ".tirith-install-failed",
    match: "exact",
    kind: "file",
    presence: "optional",
    artifactClass: "mutable-runtime-state",
    producers: GATEWAY_ROLE,
    readers: ALL_ROLES,
    required: GATEWAY_SHARED_DISCARD_REQUIREMENTS,
    shields: "unchanged",
    backup: "exclude",
    restore: "discard",
    migration: "discard",
  },
] as const satisfies readonly HermesManagedArtifact[];

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function assertProfileName(name: string): void {
  if (!PROFILE_NAME.test(name) || name === "default") {
    throw new Error("Hermes profile name must match [a-z0-9][a-z0-9_-]{0,63}");
  }
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + "/");
}

function artifactSupportsHome(artifact: HermesManagedArtifact, home: HermesHome): boolean {
  if (artifact.scope === "agent-home") {
    return home.kind === "default" || home.kind === "named-profile";
  }
  if (artifact.scope === "default-home") return home.kind === "default";
  return artifact.scope === home.kind;
}

function artifactRelativePath(artifact: HermesManagedArtifact, home: HermesHome): string {
  let relativePath: string;
  if (typeof artifact.relativePath === "string") {
    relativePath = artifact.relativePath;
  } else {
    if (artifact.scope !== "agent-home") {
      throw new Error("Only agent-home artifacts can declare layout-specific paths");
    }
    if (home.kind === "default") relativePath = artifact.relativePath.default;
    else if (home.kind === "named-profile") relativePath = artifact.relativePath.namedProfile;
    else throw new Error("Agent-home artifacts do not belong to the dashboard home");
  }
  validateHermesRelativePath(relativePath, true);
  return relativePath;
}

function resolveHermesHomeRule<T>(rule: HermesHomeRule<T>, home: HermesHome): T {
  if (
    typeof rule !== "object" ||
    rule === null ||
    !("default" in rule) ||
    !("namedProfile" in rule)
  ) {
    return rule;
  }
  if (home.kind === "default") return rule.default;
  if (home.kind === "named-profile") return rule.namedProfile;
  throw new Error("Dashboard artifacts cannot declare default and named-profile rules");
}

function validateHermesRelativePath(relativePath: string, allowHome = false): void {
  if (
    !relativePath ||
    (relativePath === "." && !allowHome) ||
    relativePath.endsWith("/") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.split("/").includes("..")
  ) {
    throw new Error("Hermes paths must be canonical relative paths without parent traversal");
  }
}

function validateHermesRelativePattern(pattern: string): void {
  validateHermesRelativePath(pattern);

  const placeholders = new Set<string>();
  const segments = pattern.split("/");
  for (const segment of segments) {
    if (segment === "**") continue;
    if (segment.includes("*")) {
      throw new Error("Hermes path patterns allow only named placeholders and ** segments");
    }
    const matches = [...segment.matchAll(/\{([^{}]+)\}/gu)];
    if (segment.replace(/\{[^{}]+\}/gu, "").match(/[{}]/u)) {
      throw new Error("Hermes path patterns require balanced named placeholders");
    }
    for (const match of matches) {
      const name = match[1] ?? "";
      if (!/^[a-z][a-z0-9-]*$/u.test(name) || placeholders.has(name)) {
        throw new Error("Hermes path pattern placeholders must be unique lowercase names");
      }
      placeholders.add(name);
    }
  }
}

function matchesPatternSegment(patternSegment: string, candidateSegment: string): boolean {
  const placeholders = [...patternSegment.matchAll(/\{[^{}]+\}/gu)];
  if (placeholders.length === 0) return patternSegment === candidateSegment;

  let expression = "^";
  let cursor = 0;
  for (const placeholder of placeholders) {
    const index = placeholder.index ?? 0;
    expression += patternSegment.slice(cursor, index).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    expression += ".+";
    cursor = index + placeholder[0].length;
  }
  expression += patternSegment.slice(cursor).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "$";
  return new RegExp(expression, "u").test(candidateSegment);
}

function matchesHermesRelativePattern(pattern: string, candidate: string): boolean {
  validateHermesRelativePattern(pattern);
  const patternSegments = pattern.split("/");
  const candidateSegments = candidate.split("/");
  const memo = new Map<string, boolean>();

  const matchesFrom = (patternIndex: number, candidateIndex: number): boolean => {
    const key = patternIndex + ":" + candidateIndex;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let matches: boolean;
    if (patternIndex === patternSegments.length) {
      matches = candidateIndex === candidateSegments.length;
      memo.set(key, matches);
      return matches;
    }
    const patternSegment = patternSegments[patternIndex] ?? "";
    if (patternSegment === "**") {
      matches = false;
      for (let nextIndex = candidateIndex; nextIndex <= candidateSegments.length; nextIndex += 1) {
        if (matchesFrom(patternIndex + 1, nextIndex)) {
          matches = true;
          break;
        }
      }
    } else {
      const candidateSegment = candidateSegments[candidateIndex];
      matches =
        candidateSegment !== undefined &&
        matchesPatternSegment(patternSegment, candidateSegment) &&
        matchesFrom(patternIndex + 1, candidateIndex + 1);
    }
    memo.set(key, matches);
    return matches;
  };

  return matchesFrom(0, 0);
}

function compareHermesPatternSpecificity(left: string, right: string): number {
  const metrics = (pattern: string) => {
    const segments = pattern.split("/");
    return {
      depth: segments.filter((segment) => segment !== "**").length,
      literalCharacters: segments.reduce(
        (total, segment) => total + segment.replace(/\{[^{}]+\}/gu, "").replace("**", "").length,
        0,
      ),
      recursiveSegments: segments.filter((segment) => segment === "**").length,
    };
  };
  const leftMetrics = metrics(left);
  const rightMetrics = metrics(right);
  return (
    rightMetrics.depth - leftMetrics.depth ||
    rightMetrics.literalCharacters - leftMetrics.literalCharacters ||
    leftMetrics.recursiveSegments - rightMetrics.recursiveSegments
  );
}

interface HermesContractMatch {
  readonly relativePath: string;
  readonly match: "exact" | "subtree" | "pattern";
}

interface HermesArtifactContractMatch extends HermesContractMatch {
  readonly artifact: HermesManagedArtifact;
  readonly pathRole: "target" | "migration-source";
}

function matchesHermesContractPath(contract: HermesContractMatch, candidate: string): boolean {
  if (contract.match !== "pattern") validateHermesRelativePath(contract.relativePath, true);
  if (contract.relativePath === candidate) return true;
  if (contract.match === "pattern") {
    return matchesHermesRelativePattern(contract.relativePath, candidate);
  }
  return (
    contract.match === "subtree" &&
    (contract.relativePath === "." || candidate.startsWith(contract.relativePath + "/"))
  );
}

function compareHermesContractMatches(
  left: HermesContractMatch,
  right: HermesContractMatch,
  candidate: string,
): number {
  return (
    Number(right.relativePath === candidate) - Number(left.relativePath === candidate) ||
    compareHermesPatternSpecificity(left.relativePath, right.relativePath)
  );
}

function residualSupportsHome(residual: HermesUnsupportedResidualPath, home: HermesHome): boolean {
  if (residual.scope === "agent-home") {
    return home.kind === "default" || home.kind === "named-profile";
  }
  if (residual.scope === "default-home") return home.kind === "default";
  return home.kind === "named-profile";
}

export function resolveHermesHomePath(home: HermesHome): string {
  if (home.kind === "default") return HERMES_DEFAULT_HOME;
  if (home.kind === "dashboard") {
    return path.posix.join(HERMES_DEFAULT_HOME, HERMES_DASHBOARD_DIRECTORY);
  }
  assertProfileName(home.name);
  return path.posix.join(HERMES_DEFAULT_HOME, HERMES_NAMED_PROFILES_DIRECTORY, home.name);
}

export function resolveHermesPosture(
  requirement: HermesPostureRequirement,
  topology: HermesRuntimeTopology,
  producer?: HermesIdentity,
): HermesConcretePosture {
  const posture =
    "kind" in requirement
      ? requirement
      : topology === "root-separated"
        ? requirement.rootSeparated
        : requirement.sameUid;
  if (posture.kind === "tree") {
    const descendantOwner = posture.descendantOwner;
    if (descendantOwner === "producer") {
      if (!producer) {
        throw new Error("A producer identity is required for producer-owned Hermes descendants");
      }
      return { ...posture, descendantOwner: producer };
    }
    return { ...posture, descendantOwner };
  }
  if (posture.owner === "producer") {
    if (!producer) {
      throw new Error("A producer identity is required for a producer-owned Hermes artifact");
    }
    return { ...posture, owner: producer };
  }
  return {
    kind: "path",
    owner: posture.owner,
    group: posture.group,
    mode: posture.mode,
  };
}

export function resolveHermesIdentities(
  rule: HermesIdentityRule,
  topology: HermesRuntimeTopology,
): readonly HermesIdentity[] {
  if (!("rootSeparated" in rule)) return rule;
  return topology === "root-separated" ? rule.rootSeparated : rule.sameUid;
}

export function resolveHermesArtifactBackup(
  artifact: HermesManagedArtifact,
  home: HermesHome,
): HermesBackupBehavior {
  if (!artifactSupportsHome(artifact, home)) {
    throw new Error(
      "Hermes artifact '" + artifact.id + "' does not belong to the " + home.kind + " home",
    );
  }
  return resolveHermesHomeRule(artifact.backup, home);
}

export function resolveHermesArtifactRestore(
  artifact: HermesManagedArtifact,
  home: HermesHome,
): HermesRestoreBehavior {
  if (!artifactSupportsHome(artifact, home)) {
    throw new Error(
      "Hermes artifact '" + artifact.id + "' does not belong to the " + home.kind + " home",
    );
  }
  return resolveHermesHomeRule(artifact.restore, home);
}

export function resolveHermesBackupAction(
  behavior: HermesBackupBehavior,
  relativePath: string,
): HermesBackupAction {
  validateHermesRelativePath(relativePath);
  if (typeof behavior === "string") return behavior;
  const selectors = behavior.selectors
    .filter((candidate) => matchesHermesRelativePattern(candidate.relativePattern, relativePath))
    .sort((left, right) =>
      compareHermesPatternSpecificity(left.relativePattern, right.relativePattern),
    );
  const selector = selectors[0];
  const nextSelector = selectors[1];
  if (
    selector &&
    nextSelector &&
    compareHermesPatternSpecificity(selector.relativePattern, nextSelector.relativePattern) === 0
  ) {
    throw new Error("Ambiguous Hermes selective backup contract for " + relativePath);
  }
  return selector?.action ?? behavior.fallback;
}

/**
 * Resolves an artifact path in its home. Pattern artifacts retain named
 * placeholders and recursive `**` segments; callers can use the result as a path
 * template or pass a concrete path to {@link findHermesManagedArtifact}.
 */
export function resolveHermesArtifactPath(
  artifact: HermesManagedArtifact,
  requestedHome?: HermesHome,
): string {
  let home = requestedHome;
  if (!home) {
    if (artifact.scope === "named-profile") {
      throw new Error("Named-profile artifacts require a profile name");
    }
    home = artifact.scope === "dashboard" ? { kind: "dashboard" } : { kind: "default" };
  }
  if (!artifactSupportsHome(artifact, home)) {
    throw new Error(
      "Hermes artifact '" + artifact.id + "' does not belong to the " + home.kind + " home",
    );
  }
  const homePath = resolveHermesHomePath(home);
  const relativePath = artifactRelativePath(artifact, home);
  return relativePath === "." ? homePath : path.posix.join(homePath, relativePath);
}

export function findHermesManagedArtifact(absolutePath: string): ResolvedHermesArtifact | null {
  if (
    !path.posix.isAbsolute(absolutePath) ||
    (absolutePath !== "/" && absolutePath.endsWith("/")) ||
    path.posix.normalize(absolutePath) !== absolutePath
  ) {
    throw new Error("Hermes managed artifact lookup requires a canonical absolute path");
  }

  const dashboardRoot = resolveHermesHomePath({ kind: "dashboard" });
  const profilesRoot = path.posix.join(HERMES_DEFAULT_HOME, HERMES_NAMED_PROFILES_DIRECTORY);
  let home: HermesHome;

  if (isWithin(absolutePath, dashboardRoot)) {
    home = { kind: "dashboard" };
  } else if (isWithin(absolutePath, profilesRoot) && absolutePath !== profilesRoot) {
    const relative = path.posix.relative(profilesRoot, absolutePath);
    const profileName = relative.split("/")[0] ?? "";
    if (!PROFILE_NAME.test(profileName) || profileName === "default") return null;
    home = { kind: "named-profile", name: profileName };
  } else if (isWithin(absolutePath, HERMES_DEFAULT_HOME)) {
    home = { kind: "default" };
  } else {
    return null;
  }

  const homePath = resolveHermesHomePath(home);
  const relativePath = path.posix.relative(homePath, absolutePath) || ".";
  const managedArtifacts: readonly HermesManagedArtifact[] = HERMES_MANAGED_ARTIFACTS;
  const artifacts = managedArtifacts
    .flatMap((artifact) => {
      if (!artifactSupportsHome(artifact, home)) return [];
      const contracts: HermesArtifactContractMatch[] = [
        {
          artifact,
          relativePath: artifactRelativePath(artifact, home),
          match: artifact.match,
          pathRole: "target",
        },
        ...(artifact.migrationSources ?? []).map((source) => ({
          artifact,
          relativePath: source.relativePath,
          match: source.match,
          pathRole: "migration-source" as const,
        })),
      ];
      return contracts.filter((contract) => matchesHermesContractPath(contract, relativePath));
    })
    .sort((left, right) => compareHermesContractMatches(left, right, relativePath));
  const artifact = artifacts[0];
  const nextArtifact = artifacts[1];
  if (
    artifact &&
    nextArtifact &&
    compareHermesContractMatches(artifact, nextArtifact, relativePath) === 0
  ) {
    throw new Error("Ambiguous Hermes path contract for " + absolutePath);
  }

  const residuals = HERMES_UNSUPPORTED_RESIDUAL_PATHS.filter((candidate) => {
    if (!residualSupportsHome(candidate, home)) return false;
    return matchesHermesContractPath(candidate, relativePath);
  }).sort((left, right) => compareHermesContractMatches(left, right, relativePath));
  const residual = residuals[0];
  const nextResidual = residuals[1];
  if (
    residual &&
    nextResidual &&
    compareHermesContractMatches(residual, nextResidual, relativePath) === 0
  ) {
    throw new Error("Ambiguous unsupported Hermes path contract for " + absolutePath);
  }
  if (residual) {
    if (!artifact) return null;
    const residualPrecedence = compareHermesContractMatches(residual, artifact, relativePath);
    if (residualPrecedence === 0) {
      throw new Error("Ambiguous managed and unsupported Hermes path contract for " + absolutePath);
    }
    if (residualPrecedence < 0) return null;
  }

  return artifact ? { artifact: artifact.artifact, home, pathRole: artifact.pathRole } : null;
}
