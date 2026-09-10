// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Derive publication checks from the single hook configuration. */
import YAML from "yaml";

type Hook = { id: string; entry?: string; args?: string[]; [key: string]: unknown };
type HookConfiguration = {
  repos: { hooks: Hook[]; [key: string]: unknown }[];
  [key: string]: unknown;
};

function replaceEntry(hook: Hook, before: string, after: string): void {
  if (hook.entry !== before) throw new Error(`Review the read-only command for ${hook.id}`);
  hook.entry = after;
}

export function readOnlyHookConfiguration(source: string): string {
  const configuration = YAML.parse(source) as HookConfiguration;
  for (const repo of configuration.repos) {
    for (const hook of repo.hooks) {
      switch (hook.id) {
        case "trailing-whitespace":
        case "end-of-file-fixer":
        case "mixed-line-ending":
          if (
            hook.entry ||
            JSON.stringify(hook.args ?? []) !==
              JSON.stringify(hook.id === "mixed-line-ending" ? ["--fix=lf"] : [])
          ) {
            throw new Error(`Review the read-only command for ${hook.id}`);
          }
          hook.entry = `python scripts/checks/read-only-fixer.py ${hook.id}`;
          hook.args = [];
          break;
        case "spdx-headers":
          replaceEntry(
            hook,
            "bash scripts/check-spdx-headers.sh --fix",
            "bash scripts/check-spdx-headers.sh",
          );
          break;
        case "platform-matrix-sync":
          replaceEntry(
            hook,
            "bash -c 'python3 scripts/generate-platform-docs.py && git add docs/get-started/prerequisites.mdx docs/inference/choose-inference-provider.mdx docs/reference/platform-support.mdx'",
            "python3 scripts/generate-platform-docs.py --check",
          );
          break;
        case "shfmt":
          if (JSON.stringify(hook.args) !== JSON.stringify(["-w", "-i", "2", "-ci", "-bn"]))
            throw new Error("Review the read-only shfmt arguments");
          hook.args = ["-d", "-i", "2", "-ci", "-bn"];
          break;
        case "oxfmt":
          replaceEntry(
            hook,
            "npx oxfmt --write --no-error-on-unmatched-pattern",
            "npx oxfmt --check --no-error-on-unmatched-pattern",
          );
          break;
        case "oxlint-fix":
          replaceEntry(
            hook,
            "npx oxlint --fix --no-error-on-unmatched-pattern",
            "npx oxlint --no-error-on-unmatched-pattern",
          );
          break;
        case "oxlint-type-aware":
          replaceEntry(
            hook,
            "npx oxlint --fix --type-aware --no-error-on-unmatched-pattern",
            "npx oxlint --type-aware --no-error-on-unmatched-pattern",
          );
          break;
      }
    }
  }
  return YAML.stringify(configuration);
}
