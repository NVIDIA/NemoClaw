// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBuiltInChannelManifestRegistry } from "./channels";
import type { ChannelManifest, ChannelPolicyPresetReference, MessagingAgentId } from "./manifest";

export interface MessagingChannelDiagnosticSpec {
  readonly channelId: string;
  readonly policyPresets: readonly string[];
  readonly preferredDefault: boolean;
  readonly deepProbe?: "in-sandbox-qr";
  readonly doctorWhenNoHealthSignals?: {
    readonly detail: string;
    readonly hint: string;
  };
}

export function collectBuiltInMessagingChannelDiagnostics(
  options: { readonly agent?: MessagingAgentId } = {},
): MessagingChannelDiagnosticSpec[] {
  return collectMessagingChannelDiagnostics(
    createBuiltInChannelManifestRegistry().listAvailable(
      options.agent ? { agent: options.agent } : undefined,
    ),
  );
}

export function collectMessagingChannelDiagnostics(
  manifests: readonly ChannelManifest[],
): MessagingChannelDiagnosticSpec[] {
  return manifests.map((manifest) => {
    const deepProbe = manifest.auth.mode === "in-sandbox-qr" ? "in-sandbox-qr" : undefined;
    return {
      channelId: manifest.id,
      policyPresets: policyPresetNames(manifest.policyPresets),
      preferredDefault: deepProbe !== undefined,
      ...(deepProbe ? { deepProbe, doctorWhenNoHealthSignals: qrDeepProbeDoctorHint() } : {}),
    };
  });
}

function qrDeepProbeDoctorHint(): MessagingChannelDiagnosticSpec["doctorWhenNoHealthSignals"] {
  return {
    detail:
      "{channels} enabled; {channel} inbound delivery is not inferred from conflict signatures{pausedSuffix}",
    hint: "run `{cli} {sandbox} channels status --channel {channel}` to probe inbound delivery",
  };
}

function policyPresetNames(presets: readonly ChannelPolicyPresetReference[] | undefined): string[] {
  return (presets ?? []).map((preset) => (typeof preset === "string" ? preset : preset.name));
}
