// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseNetworkPolicies } from "./preset-parsing";

export type ManagedPolicyContentState = "match" | "absent" | "drift" | null;

export type ManagedPolicyBindingRuntime = Pick<
  typeof import("./index"),
  "getPresetContentGatewayState" | "loadPresetForSandbox" | "removePreset"
>;

export interface ManagedPolicyBindingRemovalInput {
  knownBefore?: ManagedPolicyContentState;
  removeOptions?: Parameters<ManagedPolicyBindingRuntime["removePreset"]>[2];
}

export interface ManagedPolicyBindingRemovalResult {
  before: ManagedPolicyContentState;
  after: ManagedPolicyContentState;
  attempted: boolean;
  reportedSuccess: boolean | null;
  errorMessage: string | null;
  failureDetail: string | null;
  verifiedAbsent: boolean;
}

/** Exact-content ownership and removal contract for one NemoClaw-managed policy preset. */
export class ManagedPolicyBinding {
  readonly presetName: string;
  readonly policyKey: string;

  constructor(input: { presetName: string; policyKey?: string }) {
    this.presetName = input.presetName.trim().toLowerCase();
    this.policyKey = (input.policyKey ?? input.presetName).trim().toLowerCase();
  }

  matchesPreset(name: string): boolean {
    return name.trim().toLowerCase() === this.presetName;
  }

  private contentOwnershipState(content: string): boolean | null {
    try {
      const policies = parseNetworkPolicies(content);
      return policies === null
        ? null
        : Object.prototype.hasOwnProperty.call(policies, this.policyKey);
    } catch {
      return null;
    }
  }

  ownsContent(content: string): boolean {
    return this.contentOwnershipState(content) === true;
  }

  inspectContent(
    sandboxName: string,
    content: string,
    runtime: ManagedPolicyBindingRuntime,
    policyKey?: string,
  ): ManagedPolicyContentState {
    try {
      return policyKey === undefined
        ? runtime.getPresetContentGatewayState(sandboxName, content)
        : runtime.getPresetContentGatewayState(sandboxName, content, policyKey);
    } catch {
      return null;
    }
  }

  load(
    sandboxName: string,
    runtime: ManagedPolicyBindingRuntime,
  ): { content: string | null; state: ManagedPolicyContentState } {
    let content: string | null = null;
    try {
      content = runtime.loadPresetForSandbox(sandboxName, this.presetName);
    } catch {
      content = null;
    }
    return {
      content,
      state: content ? this.inspectContent(sandboxName, content, runtime) : null,
    };
  }

  hasLiveCustomOwner(
    sandboxName: string,
    contents: readonly string[],
    runtime: ManagedPolicyBindingRuntime,
  ): boolean {
    let indeterminate = false;
    for (const content of contents) {
      const ownsContent = this.contentOwnershipState(content);
      if (ownsContent === null) {
        indeterminate = true;
        continue;
      }
      if (!ownsContent) continue;
      const state = this.inspectContent(sandboxName, content, runtime, this.policyKey);
      if (state === "match") return true;
      if (state === null) indeterminate = true;
    }
    if (indeterminate) {
      throw new Error(
        `Could not determine live policy ownership for '${this.policyKey}' in sandbox '${sandboxName}'; refusing to reconcile overlapping managed policy content.`,
      );
    }
    return false;
  }

  setAttribution(names: readonly string[], enabled: boolean): string[] {
    const withoutBinding = names.filter((name) => !this.matchesPreset(name));
    return enabled ? [...withoutBinding, this.presetName] : withoutBinding;
  }

  removeExact(
    sandboxName: string,
    content: string,
    runtime: ManagedPolicyBindingRuntime,
    input: ManagedPolicyBindingRemovalInput = {},
  ): ManagedPolicyBindingRemovalResult {
    const before =
      input.knownBefore === undefined
        ? this.inspectContent(sandboxName, content, runtime)
        : input.knownBefore;
    if (before !== "match") {
      return {
        before,
        after: before,
        attempted: false,
        reportedSuccess: null,
        errorMessage: null,
        failureDetail: null,
        verifiedAbsent: before === "absent",
      };
    }

    let reportedSuccess = false;
    let errorMessage: string | null = null;
    try {
      reportedSuccess =
        input.removeOptions === undefined
          ? runtime.removePreset(sandboxName, this.presetName)
          : runtime.removePreset(sandboxName, this.presetName, input.removeOptions);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    const after = this.inspectContent(sandboxName, content, runtime);
    const mutationFailure = errorMessage
      ? `remove: ${errorMessage}`
      : reportedSuccess
        ? null
        : "remove failed";
    const stateFailure =
      after === "absent"
        ? null
        : after === "match"
          ? "exact content still live after remove"
          : after === "drift"
            ? "post-remove content drifted"
            : "post-remove state unavailable";
    return {
      before,
      after,
      attempted: true,
      reportedSuccess,
      errorMessage,
      failureDetail:
        mutationFailure && stateFailure
          ? `${mutationFailure}; ${stateFailure}`
          : (mutationFailure ?? stateFailure),
      verifiedAbsent: after === "absent",
    };
  }
}
