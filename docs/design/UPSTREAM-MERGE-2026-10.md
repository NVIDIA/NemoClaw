<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Upstream merge — NVIDIA/NemoClaw → chad-dev (2026-10-04)

Merged `upstream/main` (**4,928 commits**, ~5 months) into `chad-dev`. Done in an
isolated git worktree; the live tree and pod were untouched during resolution.
Restore point: tag `pre-upstream-merge-20261004` (pushed) + pod backup 2026-10-04.

## Validation (post-merge)
- 0 conflict markers; `npm install` clean (517 pkgs).
- `npm run validate:configs` → **all 71 config/policy/schema files pass**.
- `node bin/nemoclaw.js --version` loads.
- `npm run typecheck:cli` clean except `@nvidia/openshell-sdk` (optionalDependency
  installed by `scripts/dev-setup.sh`/CI, not by plain `npm install`; import is
  identical in vanilla upstream — not a merge regression).

## Conflict resolution (29 files)
**Principle:** upstream wins on rewritten code; chad wins on live runtime config;
union where both added; honor upstream security decisions.

- **Took upstream** (rewritten/renamed; our deltas superseded): `src/lib/inference-config.ts`(+test),
  `src/lib/sandbox-channels.ts`(+test), `src/lib/sandbox-build-context.ts`,
  `src/lib/onboard.ts`, `scripts/generate-openclaw-config.py` (deleted; config-gen
  moved to TS), `eslint.config.mjs` (upstream switched to **oxlint/oxfmt**),
  `tsconfig.cli.json`, `package-lock.json`, `Dockerfile`, `Dockerfile.base`
  (Debian 12→13), `scripts/backup-workspace.sh`, `schemas/policy-preset.schema.json`,
  `AGENTS.md`, `CONTRIBUTING.md`, `docs/{index,get-started/quickstart,inference/inference-options,workspace/*}.md`,
  `test/{policies,validate-blueprint}.test.ts`.
- **Kept ours** (chad live runtime): `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`
  (gbrain/bun endpoints), `blueprint.yaml` version pins + `NVIDIA_API_KEY`
  credential_env + gbrain/gstack plugins, `local-inference.yaml` (LM Studio :1234 +
  gbrain/bun binaries).
- **Union**: `.gitignore`; `schemas/blueprint.schema.json` (plugins + identity);
  `package.json` (upstream toolchain + chad `chad:*`/`webui:*` scripts);
  `blueprint.yaml` hunk 3 (upstream router + chad plugins);
  `openclaw-sandbox.yaml` read-only paths (/opt/gbrain + /var/lib/dpkg).
- **Honored upstream #1705**: messaging removed from the baseline policy (no silent
  IM egress); chad's `telegram/discord/slack/whatsapp` **presets** are preserved as
  the opt-in path.

## Accommodate-live changes made in this merge
- `schemas/network-policy.schema.json`: `endpoints` `minItems` 1→0 — restores chad's
  documented **no-network preset** pattern (session-logs / subagent-codex /
  subagent-opencode use empty `endpoints`), which chad's old schema allowed and
  upstream's new schema forbade. Revisit when OpenShell upgrades.
- `tsconfig.cli.json`: re-added chad excludes `scripts/gbrain-patches`,
  `scripts/chad-smithers` (upstream's config dropped them; they're runtime/experiment
  code, never CLI-typechecked — restores pre-merge behavior).

## Test-driven fixes (after running the suite)
Ran the full suite: **44,778 passed / 394 failed (99.1%)**; failures are Linux/Docker/
GPU/E2E environment tests (can't pass on macOS) except two, both now fixed:
- Dropped the unused `:1234` (LM Studio) endpoint + description from `local-inference.yaml`
  — the sandbox never consumed it (chad-lite is host-side OWUI→LM Studio); it only broke
  upstream's `local-inference-configured-vllm-port` port-set assertion. Easy to re-add.
- Dropped chad's `presets/whatsapp.yaml` — unused by chad (not in REQUIRED_PRESETS),
  superseded by upstream's **native** WhatsApp channel (`src/lib/messaging/channels/whatsapp/`),
  and it broke the new `initial-policy-real-policy` deepagents-code tier test.
  **WhatsApp was a chad WIP goal, never completed** — pursue it via upstream's native
  channel going forward, not the old custom preset. telegram/discord/slack presets are
  likewise superseded; consider removing them too.

## Post-merge TODOs (separate from the merge)
1. **Upgrade OpenShell to 0.0.116** in the pod (MCP/JSON-RPC L7, #1865). Chad runs
   OpenClaw 2026.4.24 on an older OpenShell; `blueprint.yaml` pins kept at chad's
   range (0.0.32–0.0.36) so the merge doesn't break live. After the upgrade, flip the
   pins to `0.0.116`. Pod has NO PVC — back up `/sandbox` first (cold-start runbook).
2. **If the sandbox image is ever rebuilt**: re-port chad image customizations
   (chad-scripts baking + proton-tool from the old `sandbox-build-context.ts`,
   chromium) onto upstream's new Debian 13 `Dockerfile.base`.
3. **Note**: upstream now ships a native WhatsApp channel
   (`src/lib/messaging/channels/whatsapp/`) — chad's custom whatsapp additions in the
   deleted `sandbox-channels.ts` are superseded; prefer upstream's going forward.
4. **generate-openclaw-config.py** (deleted upstream) carried chad model-registry +
   Anthropic-provider + plugins config. Not called by chad tooling (verified), so no
   live impact; re-port to the new TS config-gen only if chad later needs it.

## Deferred: keep-in-sync automation
`scripts/chad-upstream-sync.sh` exists (PR-gated) but is intentionally NOT scheduled
until this first catch-up lands and settles. Wire its launchd agent afterward.
