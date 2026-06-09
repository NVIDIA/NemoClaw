// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelManifest,
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingEnvLinesRenderPlan,
  SandboxMessagingJsonRenderPlan,
} from "../../manifest";
import type { ManifestCompilerContext } from "../types";
import {
  collectTemplateReferencesInLines,
  collectTemplateReferencesInValue,
  resolveCredentialTemplatesInLines,
  resolveCredentialTemplatesInValue,
} from "./template";

export function planAgentRender(
  manifest: ChannelManifest,
  context: ManifestCompilerContext,
): SandboxMessagingAgentRenderPlan[] {
  return manifest.render
    .filter((render) => render.agent === context.agent)
    .map((render) => {
      if (render.kind === "json-fragment") {
        const value = resolveCredentialTemplatesInValue(
          render.fragment.value,
          manifest.credentials,
        );
        return {
          channelId: manifest.id,
          renderId: render.id,
          kind: "json-fragment",
          agent: render.agent,
          target: render.target,
          path: render.fragment.path,
          value,
          templateRefs: collectTemplateReferencesInValue(value),
        } satisfies SandboxMessagingJsonRenderPlan;
      }

      const lines = resolveCredentialTemplatesInLines(render.lines, manifest.credentials);
      return {
        channelId: manifest.id,
        renderId: render.id,
        kind: "env-lines",
        agent: render.agent,
        target: render.target,
        lines,
        templateRefs: collectTemplateReferencesInLines(lines),
      } satisfies SandboxMessagingEnvLinesRenderPlan;
    });
}
