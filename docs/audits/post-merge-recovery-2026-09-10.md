<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Post-Merge Documentation Recovery Audit

This audit traces overwritten automated documentation drafts to current owning pages.
It covers every `automation/post-merge-docs-*` PR returned by the complete repository PR inventory, including open, merged, and closed PRs.
The recovery changes documentation only.
The separate automation-preservation fix is outside this audit.

## Boundary and Method

- Audited `main`: [6f5c9ac40](https://github.com/NVIDIA/NemoClaw/commit/6f5c9ac408f19f324ad55f00c01dc0099b939178).
- Inventory: 74 REST pages, 7,322 unique PRs; 73 pages of 100 and a final page of 22.
- Matching inventory: 24 PRs, comprising 20 merged, 3 closed, and 1 open.
- Histories: 83 workflow-authored commits and 33 subsequent human commits on the PR first-parent chains.
- Candidate losses: 104 source blocks removed from a previous bot patch by a later bot refresh.
- Every candidate maps to one of the 32 semantic dispositions below. Repeated wording is grouped, but every occurrence remains linked.
- The three closed terminal drafts and the pure-deletion cross-check have separate dispositions below.
- Reviewed release ranges span v0.0.109 through the unreleased v0.0.122 draft; the inventory preserves generic PR titles. No v0.0.122 tag was available at the audit boundary.

The inventory used the authenticated GitHub REST client with all states and complete pagination:

```bash
gh api --paginate --slurp \
  'repos/NVIDIA/NemoClaw/pulls?state=all&per_page=100&sort=created&direction=asc'
```

The retained raw inventory has SHA-256 `b9e17d0f54f12cb52eb67a5717bc9b250c85fdecef08785a313819c57a8f37f5`.
A final freshness check appended the #11277 revision `357bb9f6b` after the initial inventory. Its scope-line rewrite maps to G32; the restored native NVIDIA export contract already covers it.
The table below retains the selected PRs and immutable commit identities so reviewers can reproduce the comparisons.

For each workflow commit, the last parent is the reviewed main revision.
For a refresh, the first parent is the previous draft.
The audit compared both the patch against reviewed main and the change from the previous draft.
It considered only changes introduced by the prior draft when identifying overwritten additions.
Inherited main changes were excluded from that loss set.
Removed and replaced main text was also reviewed for corrections that a refresh could undo.
Each candidate was then compared with the final PR tree, current owning documentation, current implementation, and corresponding tagged source when historical behavior mattered.
Human changes were inspected separately from bot refreshes.
Line absence alone is not treated as documentation loss: moved coverage, wording revisions, obsolete claims, and later corrections have explicit dispositions.

## Complete PR Inventory

| PR | State | Title | Bot / human commits | Initial reviewed main | Final PR commit |
| --- | --- | --- | --- | --- | --- |
| [#9390](https://github.com/NVIDIA/NemoClaw/pull/9390) | Merged | docs: catch up after merged changes | 1 / 0 | [fb01aff8e](https://github.com/NVIDIA/NemoClaw/commit/fb01aff8ed67596dcdfe38cb6f5dccdcba301a33) | [2fe323825](https://github.com/NVIDIA/NemoClaw/commit/2fe32382515204460b984b855333770b010017b4) |
| [#9446](https://github.com/NVIDIA/NemoClaw/pull/9446) | Merged | docs: catch up after merged changes | 1 / 0 | [aa505b57a](https://github.com/NVIDIA/NemoClaw/commit/aa505b57a787f75f77a6991601f385d757efdf33) | [a24a0f0f3](https://github.com/NVIDIA/NemoClaw/commit/a24a0f0f3d250065c40433d671f450dedffb2a36) |
| [#9448](https://github.com/NVIDIA/NemoClaw/pull/9448) | Merged | docs: catch up after merged changes | 1 / 0 | [9421dc235](https://github.com/NVIDIA/NemoClaw/commit/9421dc23583817fc2be0c66017999f91eccf7b75) | [5acacb5c6](https://github.com/NVIDIA/NemoClaw/commit/5acacb5c6fe9c6de186d905d65164a003b4a3151) |
| [#9498](https://github.com/NVIDIA/NemoClaw/pull/9498) | Merged | docs: catch up after merged changes | 1 / 0 | [8f8291083](https://github.com/NVIDIA/NemoClaw/commit/8f8291083328b7556b76da841599d837e12a0caf) | [db3746c05](https://github.com/NVIDIA/NemoClaw/commit/db3746c056e30bbf5ff1ae6c63f5010020461a4b) |
| [#9572](https://github.com/NVIDIA/NemoClaw/pull/9572) | Merged | docs: catch up after merged changes | 1 / 1 | [5ab38cfc6](https://github.com/NVIDIA/NemoClaw/commit/5ab38cfc6b6176cce5441d00af9efb5283c6cf81) | [cb98e3d33](https://github.com/NVIDIA/NemoClaw/commit/cb98e3d339c59364577f87b58ca73b3f5f1cca2b) |
| [#9642](https://github.com/NVIDIA/NemoClaw/pull/9642) | Merged | docs: catch up after merged changes | 1 / 1 | [fefc93e39](https://github.com/NVIDIA/NemoClaw/commit/fefc93e3950493b2348711639155cf25b985b82c) | [7afd85a25](https://github.com/NVIDIA/NemoClaw/commit/7afd85a2568241cbe5eeb8fcff11dc11b528d659) |
| [#9674](https://github.com/NVIDIA/NemoClaw/pull/9674) | Merged | docs: catch up after merged changes | 1 / 1 | [ee07d2f44](https://github.com/NVIDIA/NemoClaw/commit/ee07d2f44ecbb2dba52b55de899763df55bc4a50) | [b59a87fd9](https://github.com/NVIDIA/NemoClaw/commit/b59a87fd92db894b60ffb7944b9b7c17e9c9101c) |
| [#9687](https://github.com/NVIDIA/NemoClaw/pull/9687) | Merged | docs: catch up after merged changes | 1 / 0 | [15ea6333a](https://github.com/NVIDIA/NemoClaw/commit/15ea6333a3eb8f905ec6063d4ffc98123f8a9232) | [059a60c9e](https://github.com/NVIDIA/NemoClaw/commit/059a60c9e230218a1d1fb2bbe0ff910ac2e4aec6) |
| [#9693](https://github.com/NVIDIA/NemoClaw/pull/9693) | Merged | docs: catch up after merged changes | 1 / 0 | [7689b4a38](https://github.com/NVIDIA/NemoClaw/commit/7689b4a3831e4abc7a992c54d84c48ee60368dac) | [b9b1ae9cc](https://github.com/NVIDIA/NemoClaw/commit/b9b1ae9cccb23c4a34daecad386450472028140a) |
| [#9727](https://github.com/NVIDIA/NemoClaw/pull/9727) | Closed | docs: catch up after merged changes | 1 / 0 | [cd0216896](https://github.com/NVIDIA/NemoClaw/commit/cd0216896b297ab20029061491c1f5183d75a92e) | [8c974cc0d](https://github.com/NVIDIA/NemoClaw/commit/8c974cc0d2ab8877aee2ead2dcfd317eb095b161) |
| [#9840](https://github.com/NVIDIA/NemoClaw/pull/9840) | Merged | docs: catch up after merged changes | 1 / 0 | [0a87614c7](https://github.com/NVIDIA/NemoClaw/commit/0a87614c738eb08c954dee37757c96ad4f7a6b95) | [81de98797](https://github.com/NVIDIA/NemoClaw/commit/81de987974aaf6d4f340fd98443127e39b8e27a8) |
| [#9841](https://github.com/NVIDIA/NemoClaw/pull/9841) | Merged | docs: prepare v0.0.114 documentation | 2 / 4 | [dfbf7126e](https://github.com/NVIDIA/NemoClaw/commit/dfbf7126e9f2d3e1d2864423fb0a0a01bfa782ea) | [b4ed2f58f](https://github.com/NVIDIA/NemoClaw/commit/b4ed2f58f15afa0c6c3ee61227da8abcd0fccac9) |
| [#9948](https://github.com/NVIDIA/NemoClaw/pull/9948) | Merged | docs: prepare v0.0.114 documentation | 2 / 4 | [01bf567da](https://github.com/NVIDIA/NemoClaw/commit/01bf567dad29bbdebb4de8c0ce2211fcb345a659) | [35ee09c77](https://github.com/NVIDIA/NemoClaw/commit/35ee09c7726323425004d2d1d52a84ee4ba1dc5d) |
| [#10055](https://github.com/NVIDIA/NemoClaw/pull/10055) | Merged | docs: prepare v0.0.115 documentation | 3 / 11 | [7b29f4d5f](https://github.com/NVIDIA/NemoClaw/commit/7b29f4d5f7f881c1839a8c70def3197d7a425aea) | [6f0dd20be](https://github.com/NVIDIA/NemoClaw/commit/6f0dd20be3a732b913b7feb6a4bc62564f07b035) |
| [#10530](https://github.com/NVIDIA/NemoClaw/pull/10530) | Merged | docs: prepare v0.0.116 documentation | 7 / 2 | [b7261ff7c](https://github.com/NVIDIA/NemoClaw/commit/b7261ff7cc73c76a15deb3e95291c24b1624534e) | [61863724a](https://github.com/NVIDIA/NemoClaw/commit/61863724a1714f00e8fb9e3eea4444c8e0a724a5) |
| [#10599](https://github.com/NVIDIA/NemoClaw/pull/10599) | Merged | docs: prepare v0.0.117 documentation | 4 / 5 | [badcee0be](https://github.com/NVIDIA/NemoClaw/commit/badcee0be595edb568764342244893e82df10e14) | [498415ccf](https://github.com/NVIDIA/NemoClaw/commit/498415ccfac8618f7f01c39d3dd5d8c26f2defed) |
| [#10642](https://github.com/NVIDIA/NemoClaw/pull/10642) | Merged | docs: prepare v0.0.117 documentation | 3 / 1 | [9b8c0511a](https://github.com/NVIDIA/NemoClaw/commit/9b8c0511ad5eb2d537cf17ba21e65c3c88008b88) | [054133e61](https://github.com/NVIDIA/NemoClaw/commit/054133e6140f9951b278b8d2aff97d431b30a697) |
| [#10680](https://github.com/NVIDIA/NemoClaw/pull/10680) | Merged | docs: prepare v0.0.118 documentation | 12 / 0 | [daba09b02](https://github.com/NVIDIA/NemoClaw/commit/daba09b02bf97a6d630629cd49cc41be1596a7d9) | [605e1af35](https://github.com/NVIDIA/NemoClaw/commit/605e1af35b997a41b725401fef5ffe28899023b9) |
| [#10800](https://github.com/NVIDIA/NemoClaw/pull/10800) | Merged | docs: prepare v0.0.118 documentation | 1 / 0 | [4b33ec7a0](https://github.com/NVIDIA/NemoClaw/commit/4b33ec7a0282760adaacf5f055972f58b0946d33) | [325545fa4](https://github.com/NVIDIA/NemoClaw/commit/325545fa43828206c3316030daec9d615e553b02) |
| [#10832](https://github.com/NVIDIA/NemoClaw/pull/10832) | Merged | docs: prepare v0.0.119 documentation | 2 / 1 | [95c0a605a](https://github.com/NVIDIA/NemoClaw/commit/95c0a605a6c078df758ba11d5d34d4b5ee636217) | [16f5760bc](https://github.com/NVIDIA/NemoClaw/commit/16f5760bc5e0041faff710477c62018d3777d77e) |
| [#10919](https://github.com/NVIDIA/NemoClaw/pull/10919) | Closed | docs: prepare v0.0.120 documentation | 10 / 0 | [f2ee031ff](https://github.com/NVIDIA/NemoClaw/commit/f2ee031ffae355e2cc8bc5cb785f0c6f582f4ac9) | [4642d1bc5](https://github.com/NVIDIA/NemoClaw/commit/4642d1bc59ddc98b50742e576a66f46fdf1a8b3e) |
| [#11216](https://github.com/NVIDIA/NemoClaw/pull/11216) | Closed | docs: prepare v0.0.121 documentation | 4 / 2 | [9456014ea](https://github.com/NVIDIA/NemoClaw/commit/9456014ea9add96d17e081daa6be2ec35a1fdf26) | [53b0af7b7](https://github.com/NVIDIA/NemoClaw/commit/53b0af7b7dfc20006daba1615573c804234f2d13) |
| [#11243](https://github.com/NVIDIA/NemoClaw/pull/11243) | Merged | docs: prepare v0.0.121 documentation | 6 / 0 | [b0d4650c6](https://github.com/NVIDIA/NemoClaw/commit/b0d4650c6cc506c2a07ddf4c909035378a0626c7) | [887fb83bc](https://github.com/NVIDIA/NemoClaw/commit/887fb83bcc477960bc82909a8b221c3342583dc1) |
| [#11277](https://github.com/NVIDIA/NemoClaw/pull/11277) | Open | docs: prepare v0.0.122 documentation | 16 / 0 | [d5cdbaf1b](https://github.com/NVIDIA/NemoClaw/commit/d5cdbaf1b65c9cfe3e73c54b8fe09de61b3d0c0e) | [357bb9f6b](https://github.com/NVIDIA/NemoClaw/commit/357bb9f6b07d969d836582e0a749c91ea35c8a2c) |

## Semantic Dispositions

### G01 Deep Agents OpenRouter readiness

**Already covered.** The owning recovery page already requires a successful model inference request after the models endpoint returns 404. Repeating it in the command reference adds no missing behavior.

Loss blocks: L001.
Owning page: [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx](../../docs/manage-sandboxes/recover-rebuild-sandboxes.mdx).
Evidence: [src/lib/actions/sandbox/launch-readiness/health.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/launch-readiness/health.ts#L26), [v0.0.114 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.114/src/lib/actions/sandbox/launch-readiness/health.ts#L1).

### G02 Discord credential boundary

**Already covered.** Discord setup binds credentials to REST and gateway policy entries; Credential Storage owns the raw-credential boundary. The changed sentence did not remove that contract.

Loss blocks: L002.
Owning page: [docs/manage-sandboxes/set-up-discord.mdx](../../docs/manage-sandboxes/set-up-discord.mdx).
Evidence: [src/lib/messaging/channels/discord/manifest.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/messaging/channels/discord/manifest.ts#L66).

### G03 Stopped Discord attachment

**Superseded.** Current rebuild omits inactive built-in policy. Only a preserved custom credential-bound policy retains the validated static Discord provider. The current messaging page documents this narrower exception.

Loss blocks: L003, L004.
Owning page: [docs/manage-sandboxes/manage-messaging-channels.mdx](../../docs/manage-sandboxes/manage-messaging-channels.mdx).
Evidence: [src/lib/messaging/applier/setup-applier.test.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/messaging/applier/setup-applier.test.ts#L228).

### G04 GPU fallback cleanup

**Restored with corrections.** Restore absence proof without mutable-name deletion for a pre-progress native flag rejection, and refusal when resource-owner cleanup is required. Keep the existing bounded cleanup proof for other eligible failures.

Loss blocks: L005, L006, L007, L008, L009, L010, L011.
Owning page: [docs/reference/commands.mdx](../../docs/reference/commands.mdx).
Evidence: [src/lib/onboard/sandbox-gpu-create-attempt.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/onboard/sandbox-gpu-create-attempt.ts#L266), [v0.0.116 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.116/src/lib/onboard/sandbox-gpu-create-attempt.ts#L1).

### G05 Published Portable Ollama recovery

**Already covered / obsolete subset.** The recovery page already documents identity checks, stopped-runner recovery, final route proof, and rollback. The older assertion that probe-only connect is the only recovery command is obsolete: recover shares this path.

Loss blocks: L012, L013, L014, L016, L017, L018.
Owning page: [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx](../../docs/manage-sandboxes/recover-rebuild-sandboxes.mdx).
Evidence: [src/lib/actions/sandbox/connect.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/connect.ts#L958), [v0.0.117 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.117/src/lib/actions/sandbox/connect.ts#L1).

### G06 Debug gateway and default selection

**Restored.** Correct the stale-default warning claim. Explicit and registered-default selection use the recorded gateway; invalid binding, denied observation, or confirmed absence fails before a tarball is written. Unavailable non-denied observation is not described as a guaranteed failure.

Loss blocks: L015.
Owning page: [docs/reference/commands.mdx](../../docs/reference/commands.mdx).
Evidence: [src/lib/diagnostics/debug-command.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/diagnostics/debug-command.ts#L82), [src/lib/diagnostics/debug-command-deps.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/diagnostics/debug-command-deps.ts#L55), [v0.0.116 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.116/src/lib/diagnostics/debug-command.ts#L1).

### G07 WSL credential-helper recovery

**Already covered.** Troubleshooting already owns temporary credential-free configuration, cleanup, and exclusions for custom Dockerfiles, non-default contexts, and explicit host authority. Preserve its current conditions instead of duplicating older prose in rebuild.

Loss blocks: L019, L020.
Owning page: [docs/reference/troubleshooting.mdx](../../docs/reference/troubleshooting.mdx).
Evidence: [src/lib/onboard/preflight-docker-credential-store.test.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/onboard/preflight-docker-credential-store.test.ts#L1).

### G08 Provider-specific Portable inference recovery

**Restored.** State that published Ollama recovery applies to ollama-local; other providers verify their recorded routes and forwards without requiring or starting an Ollama runner.

Loss blocks: L021, L022, L023, L024, L025.
Owning page: [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx](../../docs/manage-sandboxes/recover-rebuild-sandboxes.mdx).
Evidence: [src/lib/actions/sandbox/connect.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/connect.ts#L1033), [v0.0.117 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.117/src/lib/actions/sandbox/connect.ts#L1).

### G09 v0.0.117 Portable probe performance

**Already covered.** The August 31 release entry already covers reuse of verified runtime and forward state and links PR #10614. Preserve that historical entry.

Loss blocks: L026.
Owning page: [docs/changelog/2026-08-31.mdx](../../docs/changelog/2026-08-31.mdx).
Evidence: [docs/changelog/2026-08-31.mdx](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/docs/changelog/2026-08-31.mdx#L35), [v0.0.117 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.117/docs/changelog/2026-08-31.mdx#L1).

### G10 OpenClaw gateway log labels

**Restored.** Document labeling of nonempty gateway lines after recognized timestamps, preserving existing labels and OpenShell audit output.

Loss blocks: L027.
Owning page: [docs/reference/commands.mdx](../../docs/reference/commands.mdx).
Evidence: [src/lib/domain/sandbox/logs.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/domain/sandbox/logs.ts#L136), [v0.0.117 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.117/src/lib/domain/sandbox/logs.ts#L1).

### G11 Probe observations and Hermes timing

**Restored.** Restore duration, attempts, first failure, and first/fallback decision fields in the command reference. Add Hermes currentness, inspection, and lifecycle timing. Link deployment and recovery pages to that owner instead of repeating every field.

Loss blocks: L028, L029, L030, L031, L032, L033, L034, L035, L036, L038, L057, L058, L059.
Owning page: [docs/reference/commands.mdx](../../docs/reference/commands.mdx).
Evidence: [src/lib/actions/sandbox/probe/timing.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/probe/timing.ts#L153), [src/lib/actions/sandbox/connect.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/connect.ts#L814), [v0.0.118 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.118/src/lib/actions/sandbox/probe/timing.ts#L1).

### G12 Failed replacement onboarding

**Restored.** A nonzero recreate result prevents post-create restoration and success reporting while preserving backup and registry recovery state.

Loss blocks: L037.
Owning page: [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx](../../docs/manage-sandboxes/recover-rebuild-sandboxes.mdx).
Evidence: [src/lib/actions/sandbox/rebuild-recreate-phase.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/rebuild-recreate-phase.ts#L280), [v0.0.118 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.118/src/lib/actions/sandbox/rebuild-recreate-phase.ts#L1).

### G13 DGX Spark FastOS identity

**Restored.** Restore the bounded trusted marker conditions and firmware fallback. Distinguish identity detection from OEM hardware qualification.

Loss blocks: L039, L040, L041, L042, L043, L044.
Owning page: [docs/reference/system-readiness.mdx](../../docs/reference/system-readiness.mdx).
Evidence: [src/lib/inference/platform-identity/n1x.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/inference/platform-identity/n1x.ts#L73), [v0.0.118 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.118/src/lib/inference/platform-identity/n1x.ts#L1).

### G14 Hermes external dashboard ingress

**Restored with corrections.** Restore the prohibition on URL credentials and the need to protect ingress because hostname validation is not client authentication. Preserve the current independent dashboard bind control; do not restore unconditional loopback host-forward claims.

Loss blocks: L045, L046, L047.
Owning page: [docs/get-started/quickstart-hermes.mdx](../../docs/get-started/quickstart-hermes.mdx).
Evidence: [agents/hermes/start.sh](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/agents/hermes/start.sh#L108), [agents/hermes/dashboard-external-host.patch](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/agents/hermes/dashboard-external-host.patch#L1), [v0.0.118 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.118/agents/hermes/start.sh#L1).

### G15 Sandbox command grammar

**Restored with corrections.** Restore the sandbox-required action form, pending-setup guidance, and action-name sandbox example. The historical ban on bare doctor is obsolete because global doctor now exists.

Loss blocks: L048, L049, L050.
Owning page: [docs/reference/commands.mdx](../../docs/reference/commands.mdx).
Evidence: [src/lib/cli/public-dispatch.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/cli/public-dispatch.ts#L314), [src/commands/doctor.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/commands/doctor.ts#L1), [v0.0.119 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.119/src/lib/cli/public-dispatch.ts#L1).

### G16 Incomplete installation recovery

**Already covered.** Troubleshooting already explains reinstalling the incomplete CLI and following sandbox recovery guidance.

Loss blocks: L051.
Owning page: [docs/reference/troubleshooting.mdx](../../docs/reference/troubleshooting.mdx).
Evidence: [docs/reference/troubleshooting.mdx](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/docs/reference/troubleshooting.mdx#L47).

### G17 Pi protected-input receipt refresh

**Restored.** Restore only the missing requirement to refresh both platform receipts after protected image inputs change and match those inputs and candidate digests. Keep the release-candidate support boundary.

Loss blocks: L052.
Owning page: [docs/reference/pi-support.mdx](../../docs/reference/pi-support.mdx).
Evidence: [scripts/checks/pi-qualification-receipt-refresh.mts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/scripts/checks/pi-qualification-receipt-refresh.mts#L1), [v0.0.120 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.120/scripts/checks/pi-qualification-receipt-refresh.mts#L1).

### G18 Messaging profile and refresh boundary

**Restored with corrections.** Restore complete profile validation and preservation of a matching provider credential until token minting. Do not restore blanket refusal of mismatched providers, guaranteed bridge availability after refresh failure, or obsolete provider-delete recovery commands: current replacement authority and refresh-material rollback limits remain documented.

Loss blocks: L053, L054, L055, L056, L060, L068.
Owning page: [docs/manage-sandboxes/add-channels-after-onboarding.mdx](../../docs/manage-sandboxes/add-channels-after-onboarding.mdx).
Evidence: [src/lib/adapters/openshell/provider-adapter-cli.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/adapters/openshell/provider-adapter-cli.ts#L1), [src/lib/messaging/applier/openshell-provider.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/messaging/applier/openshell-provider.ts#L183), [src/lib/actions/sandbox/policy-channel.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/policy-channel.ts#L1), [v0.0.120 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.120/src/lib/adapters/openshell/provider-adapter-cli.ts#L1).

### G19 Unsafe Deep Agents MCP projection

**Restored.** Restore the status-2 special-file refusal and absence of healthy server status in the Deep Agents variant only.

Loss blocks: L061, L063, L069.
Owning page: [docs/manage-sandboxes/manage-mcp-servers.mdx](../../docs/manage-sandboxes/manage-mcp-servers.mdx).
Evidence: [src/lib/actions/sandbox/mcp-bridge-adapter-deepagents-projection.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/mcp-bridge-adapter-deepagents-projection.ts#L6), [src/lib/actions/sandbox/mcp-bridge-adapter-deepagents-projection.test.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/mcp-bridge-adapter-deepagents-projection.test.ts#L136), [v0.0.120 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.120/src/lib/actions/sandbox/mcp-bridge-adapter-deepagents-projection.ts#L1).

### G20 Managed forward terminology

**Already covered.** Current pages use the more precise receipt-owned ForwardTcp terminology and retain status/recover, listener reservation, reachability, and no-separate-forward guidance. These were wording substitutions, not missing procedures.

Loss blocks: L062, L064, L065, L066.
Owning page: [docs/reference/troubleshooting.mdx](../../docs/reference/troubleshooting.mdx).
Evidence: [docs/manage-sandboxes/run-sandboxes.mdx](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/docs/manage-sandboxes/run-sandboxes.mdx#L26), [docs/reference/troubleshooting.mdx](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/docs/reference/troubleshooting.mdx#L4517).

### G21 Configuration export output contract

**Restored missing subset.** The current option table already rejects symlinks and other file types, and the output paragraph owns atomic replacement. Restore the omitted version-1 JSON source/path/digest fields; preserve Linux-only file output and existing staging-cleanup guidance.

Loss blocks: L067.
Owning page: [docs/reference/commands.mdx](../../docs/reference/commands.mdx).
Evidence: [src/lib/adapters/fs/config-export-file.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/adapters/fs/config-export-file.ts#L66), [src/lib/actions/config/export.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/config/export.ts#L1), [v0.0.120 export result](https://github.com/NVIDIA/NemoClaw/blob/v0.0.120/src/lib/config/export.ts#L1).

### G22 Legacy Hermes immutable image

**Already covered / narrowed.** The recovery page already requires the release-pinned image when no hint or override exists and fails before sandbox/registry changes. Preserve later verified-local-alias and official-digest rules instead of reinstating blanket local-image refusal.

Loss blocks: L070, L071.
Owning page: [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx](../../docs/manage-sandboxes/recover-rebuild-sandboxes.mdx).
Evidence: [src/lib/actions/sandbox/rebuild-flow-helpers.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/rebuild-flow-helpers.ts#L1).

### G23 Global doctor output conflict

**Already covered.** The command reference already states mutual exclusion, no checks, JSON on stdout, and the conflict on stderr. Table wording and envelope synonyms do not create a missing behavior.

Loss blocks: L072, L073, L074, L075, L077.
Owning page: [docs/reference/commands.mdx](../../docs/reference/commands.mdx).
Evidence: [src/commands/doctor.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/commands/doctor.ts#L1), [docs/reference/commands.mdx](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/docs/reference/commands.mdx#L3406), [v0.0.121 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.121/src/commands/doctor.ts#L1).

### G24 v0.0.121 delayed recovery

**Restored historical entry.** Verify PR #11236 in v0.0.120..v0.0.121 and the tagged 210-second bounded delayed-discovery policy plus failed-forward handling. Restore the missing release bullet without changing other historical release claims.

Loss blocks: L076.
Owning page: [docs/changelog/2026-09-08.mdx](../../docs/changelog/2026-09-08.mdx).
Evidence: [src/lib/actions/sandbox/process-recovery.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/process-recovery.ts#L175), [src/lib/actions/sandbox/connect.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/connect.ts#L1), [v0.0.121 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.121/src/lib/actions/sandbox/process-recovery.ts#L1).

### G25 Hermes operator configuration rebuild

**Restored with corrections.** Verify PR #10780 in v0.0.120..v0.0.121. Restore capture, merge, verification, restored/dropped keys, and failure handling in the owning recovery page and release entry. Exclude gateway settings, managed route fields, and credential material rather than promising all operator configuration.

Loss blocks: L078, L079, L080, L081, L082, L083.
Owning page: [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx](../../docs/manage-sandboxes/recover-rebuild-sandboxes.mdx).
Evidence: [src/lib/actions/sandbox/rebuild-durable-config.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/rebuild-durable-config.ts#L398), [src/lib/actions/sandbox/rebuild-pipeline.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/rebuild-pipeline.ts#L37), [src/lib/actions/sandbox/rebuild-restore-phase.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/rebuild-restore-phase.ts#L39), [v0.0.121 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.121/src/lib/actions/sandbox/rebuild-durable-config.ts#L1).

### G26 Linux rootless Docker socket

**Restored.** Restore the Linux socket candidate after verifying current getDockerSocketCandidates. It is absent from both the latest draft and audited main; this is the confirmed example from the request.

Loss blocks: L084.
Owning page: [docs/reference/system-readiness.mdx](../../docs/reference/system-readiness.mdx).
Evidence: [src/lib/platform.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/platform.ts#L302).

### G27 Tavily plugin wording

**Superseded / already covered.** Current troubleshooting explains that Tavily is bundled with the pinned OpenClaw runtime and verified rather than installed separately. The older provider-entry prose describes replaced image-generation details and adds no missing operator action.

Loss blocks: L085, L087.
Owning page: [docs/reference/troubleshooting.mdx](../../docs/reference/troubleshooting.mdx).
Evidence: [docs/reference/troubleshooting.mdx](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/docs/reference/troubleshooting.mdx#L664), [agents/openclaw/manifest.yaml](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/agents/openclaw/manifest.yaml#L1).

### G28 Abandoned route reservation

**Restored with corrections.** Restore abandonment reconciliation before route reservation under the onboarding lock. Place it outside the --fresh-only explanation because ordinary onboarding also performs it; active ownership is preserved.

Loss blocks: L086, L097.
Owning page: [docs/reference/commands.mdx](../../docs/reference/commands.mdx).
Evidence: [src/lib/onboard/setup-inference.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/onboard/setup-inference.ts#L155), [src/lib/onboard/sandbox-lifecycle.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/onboard/sandbox-lifecycle.ts#L53).

### G29 Portable Hermes start and stop

**Restored.** Restore post-start forward verification and the two stop conditions: Podman exited and OpenShell Error or Stopped. Retain pending/configuring receipt guidance and no-Docker fallback.

Loss blocks: L088, L089, L090, L095.
Owning page: [docs/reference/commands.mdx](../../docs/reference/commands.mdx).
Evidence: [src/lib/actions/sandbox/start.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/actions/sandbox/start.ts#L192), [src/lib/onboard/experimental/hermes-portable-lifecycle.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/onboard/experimental/hermes-portable-lifecycle.ts#L1094).

### G30 Distributed preset resume model

**Restored.** Restore checkpoint-model agreement before runtime mutation and the --fresh recovery instruction for a mismatch.

Loss blocks: L091.
Owning page: [docs/inference/set-up-vllm-on-two-dgx-sparks.mdx](../../docs/inference/set-up-vllm-on-two-dgx-sparks.mdx).
Evidence: [src/lib/inference/serving/managed-cluster-installer.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/inference/serving/managed-cluster-installer.ts#L68).

### G31 Portable recorded gateway

**Restored.** Restore recovery/uninstall binding to the gateway recorded during onboarding, including a non-default port.

Loss blocks: L092.
Owning page: [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx](../../docs/manage-sandboxes/recover-rebuild-sandboxes.mdx).
Evidence: [src/lib/onboard/experimental/hermes-portable-onboarding.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/onboard/experimental/hermes-portable-onboarding.ts#L160), [src/lib/onboard/experimental/hermes-portable-lifecycle.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/onboard/experimental/hermes-portable-lifecycle.ts#L739).

### G32 Native NVIDIA configuration export

**Restored with corrections.** Consolidate repeated wording revisions into the supported nvidia-prod built-in-profile/default-endpoint/no-override contract. Do not restore the draft claim that only OpenAI, Anthropic, and NVIDIA names are exportable; current export qualifies supported API/endpoint evidence.

Loss blocks: L093, L094, L096, L098, L099, L100, L101, L102, L103, L104.
Owning page: [docs/reference/commands.mdx](../../docs/reference/commands.mdx).
Evidence: [src/lib/adapters/openshell/providers.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/adapters/openshell/providers.ts#L29), [src/lib/adapters/config/live-export-source.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/adapters/config/live-export-source.ts#L142), [src/lib/domain/config/verify-export-source.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/domain/config/verify-export-source.ts#L329).

## Closed Terminal Drafts and Deleted-Text Cross-Check

| Item | Evidence | Disposition |
| --- | --- | --- |
| T1: #9727 fixed vLLM profile | [8c974cc0d](https://github.com/NVIDIA/NemoClaw/commit/8c974cc0d2ab8877aee2ead2dcfd317eb095b161); [src/lib/inference/vllm.ts](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/src/lib/inference/vllm.ts#L1922); [v0.0.112 source](https://github.com/NVIDIA/NemoClaw/blob/v0.0.112/src/lib/inference/vllm.ts#L1) | Restore rejection of cluster peers and mismatched serving presets to Choose a Local Inference Server. Preserve newer compatible-catalog-model selection; the draft's blanket model-override prohibition is obsolete. The terminal draft was never refreshed, so this is closed-draft recovery, not an overwrite event. |
| T2: #10919 legacy Hermes rebuild | [4642d1bc5](https://github.com/NVIDIA/NemoClaw/commit/4642d1bc59ddc98b50742e576a66f46fdf1a8b3e); [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L263) | Already covered by the immutable-image preflight and current override validation. G22 applies. |
| T3: #11216 global doctor conflict | [cac918499](https://github.com/NVIDIA/NemoClaw/commit/cac91849964d809559b9b805dadf3927972f1f01); [docs/reference/commands.mdx](https://github.com/NVIDIA/NemoClaw/blob/6f5c9ac408f19f324ad55f00c01dc0099b939178/docs/reference/commands.mdx#L3406) | Already covered by mutual exclusion and stdout/stderr failure behavior. G23 applies. |
| D1: GPU pure deletion | The #10530 transition from `31c6417a9` to `2463c728f` reintroduced a deleted cleanup sentence. | The replacement-text and pure-deletion scans identify the same cleanup cause as G04. No independent removed-text loss class remained. |

The open #11277 draft was inspected through its recorded final commit.
Ordinary new content still present in that draft is not classified as overwritten.
The single-bot-commit PRs have no intra-PR refresh event; their patches were still checked against their own main parents.

## Every Workflow Revision

| PR | Bot commit | Reviewed main parent | Previous draft | Previous reachable release |
| --- | --- | --- | --- | --- |
| #9390 | [2fe323825](https://github.com/NVIDIA/NemoClaw/commit/2fe32382515204460b984b855333770b010017b4) | [fb01aff8e](https://github.com/NVIDIA/NemoClaw/commit/fb01aff8ed67596dcdfe38cb6f5dccdcba301a33) | Initial draft | `v0.0.109` |
| #9446 | [a24a0f0f3](https://github.com/NVIDIA/NemoClaw/commit/a24a0f0f3d250065c40433d671f450dedffb2a36) | [aa505b57a](https://github.com/NVIDIA/NemoClaw/commit/aa505b57a787f75f77a6991601f385d757efdf33) | Initial draft | `v0.0.109` |
| #9448 | [5acacb5c6](https://github.com/NVIDIA/NemoClaw/commit/5acacb5c6fe9c6de186d905d65164a003b4a3151) | [9421dc235](https://github.com/NVIDIA/NemoClaw/commit/9421dc23583817fc2be0c66017999f91eccf7b75) | Initial draft | `v0.0.109` |
| #9498 | [db3746c05](https://github.com/NVIDIA/NemoClaw/commit/db3746c056e30bbf5ff1ae6c63f5010020461a4b) | [8f8291083](https://github.com/NVIDIA/NemoClaw/commit/8f8291083328b7556b76da841599d837e12a0caf) | Initial draft | `v0.0.110` |
| #9572 | [b246aa08a](https://github.com/NVIDIA/NemoClaw/commit/b246aa08a0a27e0df3bab351d4dd686e8c6a28f2) | [5ab38cfc6](https://github.com/NVIDIA/NemoClaw/commit/5ab38cfc6b6176cce5441d00af9efb5283c6cf81) | Initial draft | `v0.0.110` |
| #9642 | [80c2e2403](https://github.com/NVIDIA/NemoClaw/commit/80c2e24035ff9fce1095b8d82a021134c671d3ca) | [fefc93e39](https://github.com/NVIDIA/NemoClaw/commit/fefc93e3950493b2348711639155cf25b985b82c) | Initial draft | `v0.0.111` |
| #9674 | [4b1a144f8](https://github.com/NVIDIA/NemoClaw/commit/4b1a144f84c0813ca6d63c57007973bf15c9cf13) | [ee07d2f44](https://github.com/NVIDIA/NemoClaw/commit/ee07d2f44ecbb2dba52b55de899763df55bc4a50) | Initial draft | `v0.0.111` |
| #9687 | [059a60c9e](https://github.com/NVIDIA/NemoClaw/commit/059a60c9e230218a1d1fb2bbe0ff910ac2e4aec6) | [15ea6333a](https://github.com/NVIDIA/NemoClaw/commit/15ea6333a3eb8f905ec6063d4ffc98123f8a9232) | Initial draft | `v0.0.111` |
| #9693 | [b9b1ae9cc](https://github.com/NVIDIA/NemoClaw/commit/b9b1ae9cccb23c4a34daecad386450472028140a) | [7689b4a38](https://github.com/NVIDIA/NemoClaw/commit/7689b4a3831e4abc7a992c54d84c48ee60368dac) | Initial draft | `v0.0.111` |
| #9727 | [8c974cc0d](https://github.com/NVIDIA/NemoClaw/commit/8c974cc0d2ab8877aee2ead2dcfd317eb095b161) | [cd0216896](https://github.com/NVIDIA/NemoClaw/commit/cd0216896b297ab20029061491c1f5183d75a92e) | Initial draft | `v0.0.111` |
| #9840 | [81de98797](https://github.com/NVIDIA/NemoClaw/commit/81de987974aaf6d4f340fd98443127e39b8e27a8) | [0a87614c7](https://github.com/NVIDIA/NemoClaw/commit/0a87614c738eb08c954dee37757c96ad4f7a6b95) | Initial draft | `v0.0.112` |
| #9841 | [e51af3eb5](https://github.com/NVIDIA/NemoClaw/commit/e51af3eb5ebe007908f41021bde66e3923c91a52) | [dfbf7126e](https://github.com/NVIDIA/NemoClaw/commit/dfbf7126e9f2d3e1d2864423fb0a0a01bfa782ea) | Initial draft | `v0.0.113` |
| #9841 | [ce5747380](https://github.com/NVIDIA/NemoClaw/commit/ce5747380f30423a82176ce950debb09994e4d4a) | [c6dbeae8f](https://github.com/NVIDIA/NemoClaw/commit/c6dbeae8fc44ef8b0fca9813571bc4240c3a682a) | [e51af3eb5](https://github.com/NVIDIA/NemoClaw/commit/e51af3eb5ebe007908f41021bde66e3923c91a52) | `v0.0.113` |
| #9948 | [e2f25efd3](https://github.com/NVIDIA/NemoClaw/commit/e2f25efd3aaa0b0147fbbe4ae16d5f7f849df301) | [01bf567da](https://github.com/NVIDIA/NemoClaw/commit/01bf567dad29bbdebb4de8c0ce2211fcb345a659) | Initial draft | `v0.0.113` |
| #9948 | [1e8a77c8d](https://github.com/NVIDIA/NemoClaw/commit/1e8a77c8d9e55011dd41e4b134c56c18846a75df) | [226b7b4f7](https://github.com/NVIDIA/NemoClaw/commit/226b7b4f7b70a3cd8fbe4e0100ffd381e1df78ff) | [e2f25efd3](https://github.com/NVIDIA/NemoClaw/commit/e2f25efd3aaa0b0147fbbe4ae16d5f7f849df301) | `v0.0.113` |
| #10055 | [74e7832e8](https://github.com/NVIDIA/NemoClaw/commit/74e7832e888125f0ea2692bc604650c7aa1608c3) | [7b29f4d5f](https://github.com/NVIDIA/NemoClaw/commit/7b29f4d5f7f881c1839a8c70def3197d7a425aea) | Initial draft | `v0.0.113` |
| #10055 | [6010c9fd0](https://github.com/NVIDIA/NemoClaw/commit/6010c9fd0bfc8414373fd8173e1c5dc621f46833) | [b6e5936e6](https://github.com/NVIDIA/NemoClaw/commit/b6e5936e6f87180caa0c5a74e32b0cf88016b881) | [74e7832e8](https://github.com/NVIDIA/NemoClaw/commit/74e7832e888125f0ea2692bc604650c7aa1608c3) | `v0.0.113` |
| #10055 | [e7e0c70d8](https://github.com/NVIDIA/NemoClaw/commit/e7e0c70d86b64fdcf1bcbf4b91164320b37f7e08) | [43b4094c5](https://github.com/NVIDIA/NemoClaw/commit/43b4094c5ad3808df7b8a410dc4495b5a502cb3b) | [6010c9fd0](https://github.com/NVIDIA/NemoClaw/commit/6010c9fd0bfc8414373fd8173e1c5dc621f46833) | `v0.0.113` |
| #10530 | [06241a884](https://github.com/NVIDIA/NemoClaw/commit/06241a884c637b8d0054fc54eff18ac6b1171b0a) | [b7261ff7c](https://github.com/NVIDIA/NemoClaw/commit/b7261ff7cc73c76a15deb3e95291c24b1624534e) | Initial draft | `v0.0.115` |
| #10530 | [31c6417a9](https://github.com/NVIDIA/NemoClaw/commit/31c6417a96b3c6e73cd7e0b2d66f1d5cc10a1716) | [b105a590f](https://github.com/NVIDIA/NemoClaw/commit/b105a590f92731e3e96c257509ab157277c796b2) | [06241a884](https://github.com/NVIDIA/NemoClaw/commit/06241a884c637b8d0054fc54eff18ac6b1171b0a) | `v0.0.115` |
| #10530 | [2463c728f](https://github.com/NVIDIA/NemoClaw/commit/2463c728ff693bff19222853694c24dc54452912) | [a15d65534](https://github.com/NVIDIA/NemoClaw/commit/a15d6553415194453e3d6ccfc1fcfedecb0e526b) | [31c6417a9](https://github.com/NVIDIA/NemoClaw/commit/31c6417a96b3c6e73cd7e0b2d66f1d5cc10a1716) | `v0.0.115` |
| #10530 | [e0f13728a](https://github.com/NVIDIA/NemoClaw/commit/e0f13728a62572c650d6e1b9cd1fafd17a8a9bbc) | [fa6b2c89e](https://github.com/NVIDIA/NemoClaw/commit/fa6b2c89eb01e2b27648cfea61208a9897d5fcb4) | [2463c728f](https://github.com/NVIDIA/NemoClaw/commit/2463c728ff693bff19222853694c24dc54452912) | `v0.0.115` |
| #10530 | [ae8622a2e](https://github.com/NVIDIA/NemoClaw/commit/ae8622a2e47a15641714e554c329465762262e6c) | [c1667560d](https://github.com/NVIDIA/NemoClaw/commit/c1667560d820d31b669ab77712bbf8ce780425c3) | [e0f13728a](https://github.com/NVIDIA/NemoClaw/commit/e0f13728a62572c650d6e1b9cd1fafd17a8a9bbc) | `v0.0.115` |
| #10530 | [58451ae86](https://github.com/NVIDIA/NemoClaw/commit/58451ae861c48487da0d817ad7bf6d2a2e1a12ac) | [29e79e716](https://github.com/NVIDIA/NemoClaw/commit/29e79e7163ea3837f90759c3ed93d54422eb6341) | [ae8622a2e](https://github.com/NVIDIA/NemoClaw/commit/ae8622a2e47a15641714e554c329465762262e6c) | `v0.0.115` |
| #10530 | [9e8fb9ff7](https://github.com/NVIDIA/NemoClaw/commit/9e8fb9ff782ed93699a2be7fe46e9b47cf122689) | [cf72805fe](https://github.com/NVIDIA/NemoClaw/commit/cf72805feee92b2f76d9a5d0d1944eff35be843e) | [58451ae86](https://github.com/NVIDIA/NemoClaw/commit/58451ae861c48487da0d817ad7bf6d2a2e1a12ac) | `v0.0.115` |
| #10599 | [29100a321](https://github.com/NVIDIA/NemoClaw/commit/29100a321cd9fb2cb12697e19b28db40885f5f5b) | [badcee0be](https://github.com/NVIDIA/NemoClaw/commit/badcee0be595edb568764342244893e82df10e14) | Initial draft | `v0.0.116` |
| #10599 | [5ebc7d102](https://github.com/NVIDIA/NemoClaw/commit/5ebc7d10223e3e1e12340681139750449efb0626) | [883fbe39f](https://github.com/NVIDIA/NemoClaw/commit/883fbe39fae2f31f12f585888aa763fd3d5f5b9c) | [29100a321](https://github.com/NVIDIA/NemoClaw/commit/29100a321cd9fb2cb12697e19b28db40885f5f5b) | `v0.0.116` |
| #10599 | [7bd747eb8](https://github.com/NVIDIA/NemoClaw/commit/7bd747eb810bb5b3d6d0338fa21f858662430624) | [3c3d76a13](https://github.com/NVIDIA/NemoClaw/commit/3c3d76a13847cfa9a0880d97e971a2926c3c886d) | [5ebc7d102](https://github.com/NVIDIA/NemoClaw/commit/5ebc7d10223e3e1e12340681139750449efb0626) | `v0.0.116` |
| #10599 | [a5998e863](https://github.com/NVIDIA/NemoClaw/commit/a5998e8633876d3a053d7e6e4f8817a4d9b4fae5) | [dc6647f4f](https://github.com/NVIDIA/NemoClaw/commit/dc6647f4fdb24d07ed3f8d6cb8be85b299080a4e) | [7bd747eb8](https://github.com/NVIDIA/NemoClaw/commit/7bd747eb810bb5b3d6d0338fa21f858662430624) | `v0.0.116` |
| #10642 | [a072a44b1](https://github.com/NVIDIA/NemoClaw/commit/a072a44b1d699626226a028343e6e28b7ff7b752) | [9b8c0511a](https://github.com/NVIDIA/NemoClaw/commit/9b8c0511ad5eb2d537cf17ba21e65c3c88008b88) | Initial draft | `v0.0.116` |
| #10642 | [55b272438](https://github.com/NVIDIA/NemoClaw/commit/55b2724383aae239866133c8f7e2282efd75fafc) | [288cd8c3e](https://github.com/NVIDIA/NemoClaw/commit/288cd8c3e82ac390d4d8c29d354e136d595c621b) | [a072a44b1](https://github.com/NVIDIA/NemoClaw/commit/a072a44b1d699626226a028343e6e28b7ff7b752) | `v0.0.116` |
| #10642 | [783eb29f2](https://github.com/NVIDIA/NemoClaw/commit/783eb29f28ead2e34e94a9a84ab443481aa97521) | [b6b593e7e](https://github.com/NVIDIA/NemoClaw/commit/b6b593e7e868cf213858d8c3afa5c400e010b368) | [55b272438](https://github.com/NVIDIA/NemoClaw/commit/55b2724383aae239866133c8f7e2282efd75fafc) | `v0.0.116` |
| #10680 | [9df87e456](https://github.com/NVIDIA/NemoClaw/commit/9df87e45657cd81cdbb4a08406753ed523f37d66) | [daba09b02](https://github.com/NVIDIA/NemoClaw/commit/daba09b02bf97a6d630629cd49cc41be1596a7d9) | Initial draft | `v0.0.117` |
| #10680 | [e613661d0](https://github.com/NVIDIA/NemoClaw/commit/e613661d00efdf3059fd7135ac6137a691de5f0f) | [024d06287](https://github.com/NVIDIA/NemoClaw/commit/024d062871ab99142b5f29317f38d881e26809a8) | [9df87e456](https://github.com/NVIDIA/NemoClaw/commit/9df87e45657cd81cdbb4a08406753ed523f37d66) | `v0.0.117` |
| #10680 | [25789eb23](https://github.com/NVIDIA/NemoClaw/commit/25789eb23765b683f18095854697a191303bea01) | [d1d6e891f](https://github.com/NVIDIA/NemoClaw/commit/d1d6e891fb1300c25ab6f858098bbabd059c5424) | [e613661d0](https://github.com/NVIDIA/NemoClaw/commit/e613661d00efdf3059fd7135ac6137a691de5f0f) | `v0.0.117` |
| #10680 | [1046a13f0](https://github.com/NVIDIA/NemoClaw/commit/1046a13f0aed474dbf08456915d883e35e125e77) | [b6cbeb23f](https://github.com/NVIDIA/NemoClaw/commit/b6cbeb23f989e4972c72ec11895dee04bf389fe1) | [25789eb23](https://github.com/NVIDIA/NemoClaw/commit/25789eb23765b683f18095854697a191303bea01) | `v0.0.117` |
| #10680 | [b91126b70](https://github.com/NVIDIA/NemoClaw/commit/b91126b701e808f48c959f948d2f2581133f8955) | [341283d85](https://github.com/NVIDIA/NemoClaw/commit/341283d856d1e23e1794ce9420fbf9b04d78b196) | [1046a13f0](https://github.com/NVIDIA/NemoClaw/commit/1046a13f0aed474dbf08456915d883e35e125e77) | `v0.0.117` |
| #10680 | [2d2e77fbb](https://github.com/NVIDIA/NemoClaw/commit/2d2e77fbb447ffd28e0a6f28b6b695672db3e865) | [96fd11104](https://github.com/NVIDIA/NemoClaw/commit/96fd11104022046ee47308beb67df69e2f7a4221) | [b91126b70](https://github.com/NVIDIA/NemoClaw/commit/b91126b701e808f48c959f948d2f2581133f8955) | `v0.0.117` |
| #10680 | [76b454f62](https://github.com/NVIDIA/NemoClaw/commit/76b454f6228f15cb73737ef0c68bc519cc7fc4da) | [380d5c298](https://github.com/NVIDIA/NemoClaw/commit/380d5c2981829cbbf4e38ba279473bbf023a051e) | [2d2e77fbb](https://github.com/NVIDIA/NemoClaw/commit/2d2e77fbb447ffd28e0a6f28b6b695672db3e865) | `v0.0.117` |
| #10680 | [776ee21c6](https://github.com/NVIDIA/NemoClaw/commit/776ee21c640aec41f4549ad31df8aa8aa73c5bc8) | [7b07dd428](https://github.com/NVIDIA/NemoClaw/commit/7b07dd428042fa031eba9d54472f97b2f1b284c1) | [76b454f62](https://github.com/NVIDIA/NemoClaw/commit/76b454f6228f15cb73737ef0c68bc519cc7fc4da) | `v0.0.117` |
| #10680 | [ad68dcf37](https://github.com/NVIDIA/NemoClaw/commit/ad68dcf37a495575b44b99728c70a109fe7b5b79) | [4b74e8e38](https://github.com/NVIDIA/NemoClaw/commit/4b74e8e386afd38ad0b6c7980611ebd4b5b7f486) | [776ee21c6](https://github.com/NVIDIA/NemoClaw/commit/776ee21c640aec41f4549ad31df8aa8aa73c5bc8) | `v0.0.117` |
| #10680 | [a843f3ea9](https://github.com/NVIDIA/NemoClaw/commit/a843f3ea94f34cf1f0b3eded5ed6120d0dd61993) | [1d280066f](https://github.com/NVIDIA/NemoClaw/commit/1d280066f8ac73ecb222f7e9f6dbbefcad83592d) | [ad68dcf37](https://github.com/NVIDIA/NemoClaw/commit/ad68dcf37a495575b44b99728c70a109fe7b5b79) | `v0.0.117` |
| #10680 | [005028181](https://github.com/NVIDIA/NemoClaw/commit/005028181717d4f2d1672cbaef5ba8b4dbccafb6) | [f68ccab0c](https://github.com/NVIDIA/NemoClaw/commit/f68ccab0c9cde2afbef32425fea1f2472a0f8532) | [a843f3ea9](https://github.com/NVIDIA/NemoClaw/commit/a843f3ea94f34cf1f0b3eded5ed6120d0dd61993) | `v0.0.117` |
| #10680 | [605e1af35](https://github.com/NVIDIA/NemoClaw/commit/605e1af35b997a41b725401fef5ffe28899023b9) | [2b7ae7fed](https://github.com/NVIDIA/NemoClaw/commit/2b7ae7fed4dd1e0aa0363ef488e643c3c9d424c3) | [005028181](https://github.com/NVIDIA/NemoClaw/commit/005028181717d4f2d1672cbaef5ba8b4dbccafb6) | `v0.0.117` |
| #10800 | [325545fa4](https://github.com/NVIDIA/NemoClaw/commit/325545fa43828206c3316030daec9d615e553b02) | [4b33ec7a0](https://github.com/NVIDIA/NemoClaw/commit/4b33ec7a0282760adaacf5f055972f58b0946d33) | Initial draft | `v0.0.117` |
| #10832 | [fa9005b5f](https://github.com/NVIDIA/NemoClaw/commit/fa9005b5f0d5d5b6996e0bc2c6a651191020319c) | [95c0a605a](https://github.com/NVIDIA/NemoClaw/commit/95c0a605a6c078df758ba11d5d34d4b5ee636217) | Initial draft | `v0.0.118` |
| #10832 | [8e41cc728](https://github.com/NVIDIA/NemoClaw/commit/8e41cc7280fa1f01c2387f16ad7ecb02d8fc9bcc) | [e76756027](https://github.com/NVIDIA/NemoClaw/commit/e76756027d7d561045cfbcf0c03d292ab05f6988) | [fa9005b5f](https://github.com/NVIDIA/NemoClaw/commit/fa9005b5f0d5d5b6996e0bc2c6a651191020319c) | `v0.0.118` |
| #10919 | [71516d48e](https://github.com/NVIDIA/NemoClaw/commit/71516d48ebdfe6633aaf01dcc187bf4e9caef7ef) | [f2ee031ff](https://github.com/NVIDIA/NemoClaw/commit/f2ee031ffae355e2cc8bc5cb785f0c6f582f4ac9) | Initial draft | `v0.0.119` |
| #10919 | [27b15f2a7](https://github.com/NVIDIA/NemoClaw/commit/27b15f2a7806200fffe4596e354f8fc6962843e3) | [8b0f617ad](https://github.com/NVIDIA/NemoClaw/commit/8b0f617adf362fb2ed373820d02a43a00d9d2304) | [71516d48e](https://github.com/NVIDIA/NemoClaw/commit/71516d48ebdfe6633aaf01dcc187bf4e9caef7ef) | `v0.0.119` |
| #10919 | [5d0ff066d](https://github.com/NVIDIA/NemoClaw/commit/5d0ff066df527b3fa5d100da152c5347b1f4f6a2) | [d4eff54a8](https://github.com/NVIDIA/NemoClaw/commit/d4eff54a8d213a3a8fe5650703c8e708eab4dd7d) | [27b15f2a7](https://github.com/NVIDIA/NemoClaw/commit/27b15f2a7806200fffe4596e354f8fc6962843e3) | `v0.0.119` |
| #10919 | [af1233393](https://github.com/NVIDIA/NemoClaw/commit/af123339354eb7631c4052b98f97bf21648de3b0) | [3ab308534](https://github.com/NVIDIA/NemoClaw/commit/3ab308534bf5fdc4346ee14a6603f6377408827f) | [5d0ff066d](https://github.com/NVIDIA/NemoClaw/commit/5d0ff066df527b3fa5d100da152c5347b1f4f6a2) | `v0.0.119` |
| #10919 | [7ac72ad4e](https://github.com/NVIDIA/NemoClaw/commit/7ac72ad4e1092a70bfcbe4299211660e5b22a7aa) | [34d29c5ff](https://github.com/NVIDIA/NemoClaw/commit/34d29c5ff6107c04b9b567a18763eb0a74c4cd6a) | [af1233393](https://github.com/NVIDIA/NemoClaw/commit/af123339354eb7631c4052b98f97bf21648de3b0) | `v0.0.119` |
| #10919 | [dcc991f0f](https://github.com/NVIDIA/NemoClaw/commit/dcc991f0f7a4a64f85415dc83743d88dbf3fd9c8) | [6df1b1fa1](https://github.com/NVIDIA/NemoClaw/commit/6df1b1fa1eb8fc5d09c1f04dc0a8c89275b45ea4) | [7ac72ad4e](https://github.com/NVIDIA/NemoClaw/commit/7ac72ad4e1092a70bfcbe4299211660e5b22a7aa) | `v0.0.119` |
| #10919 | [c73823d82](https://github.com/NVIDIA/NemoClaw/commit/c73823d82ce9590e6d9ff7ee233f0214e38636b6) | [2fdb78353](https://github.com/NVIDIA/NemoClaw/commit/2fdb783533f58c7e316aedf7595a1808c9589bbc) | [dcc991f0f](https://github.com/NVIDIA/NemoClaw/commit/dcc991f0f7a4a64f85415dc83743d88dbf3fd9c8) | `v0.0.119` |
| #10919 | [cab50c1fc](https://github.com/NVIDIA/NemoClaw/commit/cab50c1fc4825e89f3a044d19dfb69e93c399cf8) | [94bb868ea](https://github.com/NVIDIA/NemoClaw/commit/94bb868ea0f3e98533b06196def74b7559a1d1d4) | [c73823d82](https://github.com/NVIDIA/NemoClaw/commit/c73823d82ce9590e6d9ff7ee233f0214e38636b6) | `v0.0.119` |
| #10919 | [7a6a67ba4](https://github.com/NVIDIA/NemoClaw/commit/7a6a67ba49d71ea74f93ac4564295b297b6d6e7b) | [5b7433648](https://github.com/NVIDIA/NemoClaw/commit/5b74336486a8492ad87dd7eaba3d1bc06abbadf6) | [cab50c1fc](https://github.com/NVIDIA/NemoClaw/commit/cab50c1fc4825e89f3a044d19dfb69e93c399cf8) | `v0.0.119` |
| #10919 | [4642d1bc5](https://github.com/NVIDIA/NemoClaw/commit/4642d1bc59ddc98b50742e576a66f46fdf1a8b3e) | [685eab2f5](https://github.com/NVIDIA/NemoClaw/commit/685eab2f5ac0fbd18c07c44a39143abceac4ca03) | [7a6a67ba4](https://github.com/NVIDIA/NemoClaw/commit/7a6a67ba49d71ea74f93ac4564295b297b6d6e7b) | `v0.0.119` |
| #11216 | [3893e1cb6](https://github.com/NVIDIA/NemoClaw/commit/3893e1cb6570431f08e419bca3ad9775381293b1) | [9456014ea](https://github.com/NVIDIA/NemoClaw/commit/9456014ea9add96d17e081daa6be2ec35a1fdf26) | Initial draft | `v0.0.120` |
| #11216 | [32713b909](https://github.com/NVIDIA/NemoClaw/commit/32713b90955822a1a6cc31dd14ea110f2eaa5db4) | [d10ba0e23](https://github.com/NVIDIA/NemoClaw/commit/d10ba0e23d6b867aa0c23874f87263d5ada4ddfc) | [3893e1cb6](https://github.com/NVIDIA/NemoClaw/commit/3893e1cb6570431f08e419bca3ad9775381293b1) | `v0.0.120` |
| #11216 | [dbb66a468](https://github.com/NVIDIA/NemoClaw/commit/dbb66a4682e15a730bfbb790b422cb5e9c58af3e) | [d35b4dfc2](https://github.com/NVIDIA/NemoClaw/commit/d35b4dfc2edbd7aa0ab4e5bc8771fbdbc3586536) | [32713b909](https://github.com/NVIDIA/NemoClaw/commit/32713b90955822a1a6cc31dd14ea110f2eaa5db4) | `v0.0.120` |
| #11216 | [cac918499](https://github.com/NVIDIA/NemoClaw/commit/cac91849964d809559b9b805dadf3927972f1f01) | [8fed029c7](https://github.com/NVIDIA/NemoClaw/commit/8fed029c7a33efceb186a803027d3ce024b394db) | [dbb66a468](https://github.com/NVIDIA/NemoClaw/commit/dbb66a4682e15a730bfbb790b422cb5e9c58af3e) | `v0.0.120` |
| #11243 | [fd1649abf](https://github.com/NVIDIA/NemoClaw/commit/fd1649abf2c3d5eb53237d047cf2ab771eef9742) | [b0d4650c6](https://github.com/NVIDIA/NemoClaw/commit/b0d4650c6cc506c2a07ddf4c909035378a0626c7) | Initial draft | `v0.0.120` |
| #11243 | [3c68dd125](https://github.com/NVIDIA/NemoClaw/commit/3c68dd1256a9a5b351a178740f797e11730ffa28) | [018ace12a](https://github.com/NVIDIA/NemoClaw/commit/018ace12a294d3b4d7a9c74475ba0a1ee72976fe) | [fd1649abf](https://github.com/NVIDIA/NemoClaw/commit/fd1649abf2c3d5eb53237d047cf2ab771eef9742) | `v0.0.120` |
| #11243 | [bf07f4926](https://github.com/NVIDIA/NemoClaw/commit/bf07f492629b80e8b6fe2bcffbf4fc5a027bc01b) | [7c54bc084](https://github.com/NVIDIA/NemoClaw/commit/7c54bc084adc9a2aed3002fac05eada7a066d9d4) | [3c68dd125](https://github.com/NVIDIA/NemoClaw/commit/3c68dd1256a9a5b351a178740f797e11730ffa28) | `v0.0.120` |
| #11243 | [023b3e35d](https://github.com/NVIDIA/NemoClaw/commit/023b3e35dc1980ea45a1f77d7eb460442bc213d4) | [de7f565dd](https://github.com/NVIDIA/NemoClaw/commit/de7f565dd062b6f5affe12218ad825c97efee042) | [bf07f4926](https://github.com/NVIDIA/NemoClaw/commit/bf07f492629b80e8b6fe2bcffbf4fc5a027bc01b) | `v0.0.120` |
| #11243 | [aec5f1e2c](https://github.com/NVIDIA/NemoClaw/commit/aec5f1e2c126e9d73a4e7070b706bb15a2475e22) | [87d6dfae8](https://github.com/NVIDIA/NemoClaw/commit/87d6dfae852ede67a5acb63e2beae17020a754b6) | [023b3e35d](https://github.com/NVIDIA/NemoClaw/commit/023b3e35dc1980ea45a1f77d7eb460442bc213d4) | `v0.0.120` |
| #11243 | [887fb83bc](https://github.com/NVIDIA/NemoClaw/commit/887fb83bcc477960bc82909a8b221c3342583dc1) | [1b3cd3668](https://github.com/NVIDIA/NemoClaw/commit/1b3cd3668c0530969de8a24e941587793a0ea7c4) | [aec5f1e2c](https://github.com/NVIDIA/NemoClaw/commit/aec5f1e2c126e9d73a4e7070b706bb15a2475e22) | `v0.0.120` |
| #11277 | [bed578a1d](https://github.com/NVIDIA/NemoClaw/commit/bed578a1d735f1e401391295b31d53d60dec23e9) | [d5cdbaf1b](https://github.com/NVIDIA/NemoClaw/commit/d5cdbaf1b65c9cfe3e73c54b8fe09de61b3d0c0e) | Initial draft | `v0.0.121` |
| #11277 | [fcc038ff8](https://github.com/NVIDIA/NemoClaw/commit/fcc038ff8115285e0f51b159d6966fe28861a97e) | [091be1634](https://github.com/NVIDIA/NemoClaw/commit/091be1634190ce00812a0813fde26f3a7b2b0417) | [bed578a1d](https://github.com/NVIDIA/NemoClaw/commit/bed578a1d735f1e401391295b31d53d60dec23e9) | `v0.0.121` |
| #11277 | [00eb0ccf4](https://github.com/NVIDIA/NemoClaw/commit/00eb0ccf4fc36838800a634c10b9adf05013e24b) | [b5f1d6bbb](https://github.com/NVIDIA/NemoClaw/commit/b5f1d6bbb0e01c78015094c1d650a051bbaf82a6) | [fcc038ff8](https://github.com/NVIDIA/NemoClaw/commit/fcc038ff8115285e0f51b159d6966fe28861a97e) | `v0.0.121` |
| #11277 | [4f8ac0e18](https://github.com/NVIDIA/NemoClaw/commit/4f8ac0e1812eb5ff9ee67d579f48f890369c15a6) | [605851fe4](https://github.com/NVIDIA/NemoClaw/commit/605851fe4a4ca1ca96c1f37b72e6127a1e00ff8e) | [00eb0ccf4](https://github.com/NVIDIA/NemoClaw/commit/00eb0ccf4fc36838800a634c10b9adf05013e24b) | `v0.0.121` |
| #11277 | [8d9ba551f](https://github.com/NVIDIA/NemoClaw/commit/8d9ba551f05a8c8ecddff7880d998ac9d4126d0f) | [c1f906e5a](https://github.com/NVIDIA/NemoClaw/commit/c1f906e5aa4150116a70382e6350d7b9ad89823c) | [4f8ac0e18](https://github.com/NVIDIA/NemoClaw/commit/4f8ac0e1812eb5ff9ee67d579f48f890369c15a6) | `v0.0.121` |
| #11277 | [15f6b2a50](https://github.com/NVIDIA/NemoClaw/commit/15f6b2a50f1c1e350c9544593d9de33c4059d19d) | [7d687ff7e](https://github.com/NVIDIA/NemoClaw/commit/7d687ff7ea490c307b2a9ad2dcf5401967da609b) | [8d9ba551f](https://github.com/NVIDIA/NemoClaw/commit/8d9ba551f05a8c8ecddff7880d998ac9d4126d0f) | `v0.0.121` |
| #11277 | [4a5cd633c](https://github.com/NVIDIA/NemoClaw/commit/4a5cd633c84a66a89304656034d71c3603fcab66) | [f8f9a1b24](https://github.com/NVIDIA/NemoClaw/commit/f8f9a1b240cdd4e830869277b2361c633864833d) | [15f6b2a50](https://github.com/NVIDIA/NemoClaw/commit/15f6b2a50f1c1e350c9544593d9de33c4059d19d) | `v0.0.121` |
| #11277 | [7b70bf86e](https://github.com/NVIDIA/NemoClaw/commit/7b70bf86e97f5058db5da41a25985a5933fbad1d) | [ae5b2ca92](https://github.com/NVIDIA/NemoClaw/commit/ae5b2ca922023120f90e23242c133c774ae30aa0) | [4a5cd633c](https://github.com/NVIDIA/NemoClaw/commit/4a5cd633c84a66a89304656034d71c3603fcab66) | `v0.0.121` |
| #11277 | [020e47b33](https://github.com/NVIDIA/NemoClaw/commit/020e47b3314d7db06311b5c3ee621cc7858f4048) | [f893b8359](https://github.com/NVIDIA/NemoClaw/commit/f893b8359eb6529bfc81131a353c65dab869a33a) | [7b70bf86e](https://github.com/NVIDIA/NemoClaw/commit/7b70bf86e97f5058db5da41a25985a5933fbad1d) | `v0.0.121` |
| #11277 | [1d4d41d20](https://github.com/NVIDIA/NemoClaw/commit/1d4d41d203c04012db4df00ba76f1ff33857bee3) | [a89af34fa](https://github.com/NVIDIA/NemoClaw/commit/a89af34fa9689b57493f7a50b48655d2b2320354) | [020e47b33](https://github.com/NVIDIA/NemoClaw/commit/020e47b3314d7db06311b5c3ee621cc7858f4048) | `v0.0.121` |
| #11277 | [bf2bbbfc2](https://github.com/NVIDIA/NemoClaw/commit/bf2bbbfc22d1e6484189aaf0f876692de68a6297) | [801fb0c5b](https://github.com/NVIDIA/NemoClaw/commit/801fb0c5bad751d4c06fdd51840bf5e755b5a48c) | [1d4d41d20](https://github.com/NVIDIA/NemoClaw/commit/1d4d41d203c04012db4df00ba76f1ff33857bee3) | `v0.0.121` |
| #11277 | [457aa3ac7](https://github.com/NVIDIA/NemoClaw/commit/457aa3ac70944bf5e2ccaacd2e9748afa2fec84f) | [9b2514c3f](https://github.com/NVIDIA/NemoClaw/commit/9b2514c3f6019ea6cd859d56b3ac2c3e386d5f64) | [bf2bbbfc2](https://github.com/NVIDIA/NemoClaw/commit/bf2bbbfc22d1e6484189aaf0f876692de68a6297) | `v0.0.121` |
| #11277 | [41ffad31b](https://github.com/NVIDIA/NemoClaw/commit/41ffad31bd3dd032165b7e6e2c6c11447f57a2b4) | [f82198e4b](https://github.com/NVIDIA/NemoClaw/commit/f82198e4bc79ce1b20da7ebfa6f457ebc8cf8f2b) | [457aa3ac7](https://github.com/NVIDIA/NemoClaw/commit/457aa3ac70944bf5e2ccaacd2e9748afa2fec84f) | `v0.0.121` |
| #11277 | [ee21c693b](https://github.com/NVIDIA/NemoClaw/commit/ee21c693b9537a6e6bb1003de0cc49f41f98f24e) | [e4ef25149](https://github.com/NVIDIA/NemoClaw/commit/e4ef251490902737909b7d2710c41ed549a07243) | [41ffad31b](https://github.com/NVIDIA/NemoClaw/commit/41ffad31bd3dd032165b7e6e2c6c11447f57a2b4) | `v0.0.121` |
| #11277 | [ffacf0879](https://github.com/NVIDIA/NemoClaw/commit/ffacf08793ff7af5eaf631ee290182d3f9ae7afb) | [6f5c9ac40](https://github.com/NVIDIA/NemoClaw/commit/6f5c9ac408f19f324ad55f00c01dc0099b939178) | [ee21c693b](https://github.com/NVIDIA/NemoClaw/commit/ee21c693b9537a6e6bb1003de0cc49f41f98f24e) | `v0.0.121` |
| #11277 | [357bb9f6b](https://github.com/NVIDIA/NemoClaw/commit/357bb9f6b07d969d836582e0a749c91ea35c8a2c) | [a4265abfc](https://github.com/NVIDIA/NemoClaw/commit/a4265abfc2e46922100baff0ba8f5985b681cf69) | [ffacf0879](https://github.com/NVIDIA/NemoClaw/commit/ffacf08793ff7af5eaf631ee290182d3f9ae7afb) | `v0.0.121` |

## Every Candidate Loss

The original-text link identifies the previous draft and source line.
The transition link compares that draft with the refresh that removed the block.
The workflow-revision table identifies both main parents for each comparison.

| Loss | PR | Original text | Refresh transition | Disposition |
| --- | --- | --- | --- | --- |
| L001 | #9841 | [docs/reference/commands.mdx:1297](https://github.com/NVIDIA/NemoClaw/blob/e51af3eb5ebe007908f41021bde66e3923c91a52/docs/reference/commands.mdx#L1297) | [e51af3eb5 → ce5747380](https://github.com/NVIDIA/NemoClaw/compare/e51af3eb5ebe007908f41021bde66e3923c91a52...ce5747380f30423a82176ce950debb09994e4d4a) | [G01](#g01-deep-agents-openrouter-readiness) |
| L002 | #9948 | [docs/manage-sandboxes/set-up-discord.mdx:32](https://github.com/NVIDIA/NemoClaw/blob/e2f25efd3aaa0b0147fbbe4ae16d5f7f849df301/docs/manage-sandboxes/set-up-discord.mdx#L32) | [e2f25efd3 → 1e8a77c8d](https://github.com/NVIDIA/NemoClaw/compare/e2f25efd3aaa0b0147fbbe4ae16d5f7f849df301...1e8a77c8d9e55011dd41e4b134c56c18846a75df) | [G02](#g02-discord-credential-boundary) |
| L003 | #10055 | [docs/manage-sandboxes/manage-messaging-channels.mdx:104](https://github.com/NVIDIA/NemoClaw/blob/74e7832e888125f0ea2692bc604650c7aa1608c3/docs/manage-sandboxes/manage-messaging-channels.mdx#L104) | [74e7832e8 → 6010c9fd0](https://github.com/NVIDIA/NemoClaw/compare/74e7832e888125f0ea2692bc604650c7aa1608c3...6010c9fd0bfc8414373fd8173e1c5dc621f46833) | [G03](#g03-stopped-discord-attachment) |
| L004 | #10055 | [docs/manage-sandboxes/manage-messaging-channels.mdx:104](https://github.com/NVIDIA/NemoClaw/blob/6010c9fd0bfc8414373fd8173e1c5dc621f46833/docs/manage-sandboxes/manage-messaging-channels.mdx#L104) | [6010c9fd0 → e7e0c70d8](https://github.com/NVIDIA/NemoClaw/compare/6010c9fd0bfc8414373fd8173e1c5dc621f46833...e7e0c70d86b64fdcf1bcbf4b91164320b37f7e08) | [G03](#g03-stopped-discord-attachment) |
| L005 | #10530 | [docs/reference/commands.mdx:1173](https://github.com/NVIDIA/NemoClaw/blob/06241a884c637b8d0054fc54eff18ac6b1171b0a/docs/reference/commands.mdx#L1173) | [06241a884 → 31c6417a9](https://github.com/NVIDIA/NemoClaw/compare/06241a884c637b8d0054fc54eff18ac6b1171b0a...31c6417a96b3c6e73cd7e0b2d66f1d5cc10a1716) | [G04](#g04-gpu-fallback-cleanup) |
| L006 | #10530 | [docs/reference/commands.mdx:1178](https://github.com/NVIDIA/NemoClaw/blob/06241a884c637b8d0054fc54eff18ac6b1171b0a/docs/reference/commands.mdx#L1178) | [06241a884 → 31c6417a9](https://github.com/NVIDIA/NemoClaw/compare/06241a884c637b8d0054fc54eff18ac6b1171b0a...31c6417a96b3c6e73cd7e0b2d66f1d5cc10a1716) | [G04](#g04-gpu-fallback-cleanup) |
| L007 | #10530 | [docs/reference/troubleshooting.mdx:3478](https://github.com/NVIDIA/NemoClaw/blob/06241a884c637b8d0054fc54eff18ac6b1171b0a/docs/reference/troubleshooting.mdx#L3478) | [06241a884 → 31c6417a9](https://github.com/NVIDIA/NemoClaw/compare/06241a884c637b8d0054fc54eff18ac6b1171b0a...31c6417a96b3c6e73cd7e0b2d66f1d5cc10a1716) | [G04](#g04-gpu-fallback-cleanup) |
| L008 | #10530 | [docs/reference/troubleshooting.mdx:3486](https://github.com/NVIDIA/NemoClaw/blob/06241a884c637b8d0054fc54eff18ac6b1171b0a/docs/reference/troubleshooting.mdx#L3486) | [06241a884 → 31c6417a9](https://github.com/NVIDIA/NemoClaw/compare/06241a884c637b8d0054fc54eff18ac6b1171b0a...31c6417a96b3c6e73cd7e0b2d66f1d5cc10a1716) | [G04](#g04-gpu-fallback-cleanup) |
| L009 | #10530 | [docs/reference/troubleshooting.mdx:3493](https://github.com/NVIDIA/NemoClaw/blob/06241a884c637b8d0054fc54eff18ac6b1171b0a/docs/reference/troubleshooting.mdx#L3493) | [06241a884 → 31c6417a9](https://github.com/NVIDIA/NemoClaw/compare/06241a884c637b8d0054fc54eff18ac6b1171b0a...31c6417a96b3c6e73cd7e0b2d66f1d5cc10a1716) | [G04](#g04-gpu-fallback-cleanup) |
| L010 | #10530 | [docs/reference/commands.mdx:1173](https://github.com/NVIDIA/NemoClaw/blob/31c6417a96b3c6e73cd7e0b2d66f1d5cc10a1716/docs/reference/commands.mdx#L1173) | [31c6417a9 → 2463c728f](https://github.com/NVIDIA/NemoClaw/compare/31c6417a96b3c6e73cd7e0b2d66f1d5cc10a1716...2463c728ff693bff19222853694c24dc54452912) | [G04](#g04-gpu-fallback-cleanup) |
| L011 | #10530 | [docs/reference/troubleshooting.mdx:3478](https://github.com/NVIDIA/NemoClaw/blob/31c6417a96b3c6e73cd7e0b2d66f1d5cc10a1716/docs/reference/troubleshooting.mdx#L3478) | [31c6417a9 → 2463c728f](https://github.com/NVIDIA/NemoClaw/compare/31c6417a96b3c6e73cd7e0b2d66f1d5cc10a1716...2463c728ff693bff19222853694c24dc54452912) | [G04](#g04-gpu-fallback-cleanup) |
| L012 | #10530 | [docs/reference/commands.mdx:1455](https://github.com/NVIDIA/NemoClaw/blob/2463c728ff693bff19222853694c24dc54452912/docs/reference/commands.mdx#L1455) | [2463c728f → e0f13728a](https://github.com/NVIDIA/NemoClaw/compare/2463c728ff693bff19222853694c24dc54452912...e0f13728a62572c650d6e1b9cd1fafd17a8a9bbc) | [G05](#g05-published-portable-ollama-recovery) |
| L013 | #10530 | [docs/reference/commands.mdx:1426](https://github.com/NVIDIA/NemoClaw/blob/e0f13728a62572c650d6e1b9cd1fafd17a8a9bbc/docs/reference/commands.mdx#L1426) | [e0f13728a → ae8622a2e](https://github.com/NVIDIA/NemoClaw/compare/e0f13728a62572c650d6e1b9cd1fafd17a8a9bbc...ae8622a2e47a15641714e554c329465762262e6c) | [G05](#g05-published-portable-ollama-recovery) |
| L014 | #10530 | [docs/reference/commands.mdx:1414](https://github.com/NVIDIA/NemoClaw/blob/ae8622a2e47a15641714e554c329465762262e6c/docs/reference/commands.mdx#L1414) | [ae8622a2e → 58451ae86](https://github.com/NVIDIA/NemoClaw/compare/ae8622a2e47a15641714e554c329465762262e6c...58451ae861c48487da0d817ad7bf6d2a2e1a12ac) | [G05](#g05-published-portable-ollama-recovery) |
| L015 | #10530 | [docs/reference/commands.mdx:4599](https://github.com/NVIDIA/NemoClaw/blob/ae8622a2e47a15641714e554c329465762262e6c/docs/reference/commands.mdx#L4599) | [ae8622a2e → 58451ae86](https://github.com/NVIDIA/NemoClaw/compare/ae8622a2e47a15641714e554c329465762262e6c...58451ae861c48487da0d817ad7bf6d2a2e1a12ac) | [G06](#g06-debug-gateway-and-default-selection) |
| L016 | #10530 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:239](https://github.com/NVIDIA/NemoClaw/blob/58451ae861c48487da0d817ad7bf6d2a2e1a12ac/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L239) | [58451ae86 → 9e8fb9ff7](https://github.com/NVIDIA/NemoClaw/compare/58451ae861c48487da0d817ad7bf6d2a2e1a12ac...9e8fb9ff782ed93699a2be7fe46e9b47cf122689) | [G05](#g05-published-portable-ollama-recovery) |
| L017 | #10530 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:244](https://github.com/NVIDIA/NemoClaw/blob/58451ae861c48487da0d817ad7bf6d2a2e1a12ac/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L244) | [58451ae86 → 9e8fb9ff7](https://github.com/NVIDIA/NemoClaw/compare/58451ae861c48487da0d817ad7bf6d2a2e1a12ac...9e8fb9ff782ed93699a2be7fe46e9b47cf122689) | [G05](#g05-published-portable-ollama-recovery) |
| L018 | #10530 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:247](https://github.com/NVIDIA/NemoClaw/blob/58451ae861c48487da0d817ad7bf6d2a2e1a12ac/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L247) | [58451ae86 → 9e8fb9ff7](https://github.com/NVIDIA/NemoClaw/compare/58451ae861c48487da0d817ad7bf6d2a2e1a12ac...9e8fb9ff782ed93699a2be7fe46e9b47cf122689) | [G05](#g05-published-portable-ollama-recovery) |
| L019 | #10530 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:301](https://github.com/NVIDIA/NemoClaw/blob/58451ae861c48487da0d817ad7bf6d2a2e1a12ac/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L301) | [58451ae86 → 9e8fb9ff7](https://github.com/NVIDIA/NemoClaw/compare/58451ae861c48487da0d817ad7bf6d2a2e1a12ac...9e8fb9ff782ed93699a2be7fe46e9b47cf122689) | [G07](#g07-wsl-credential-helper-recovery) |
| L020 | #10530 | [docs/reference/troubleshooting.mdx:209](https://github.com/NVIDIA/NemoClaw/blob/58451ae861c48487da0d817ad7bf6d2a2e1a12ac/docs/reference/troubleshooting.mdx#L209) | [58451ae86 → 9e8fb9ff7](https://github.com/NVIDIA/NemoClaw/compare/58451ae861c48487da0d817ad7bf6d2a2e1a12ac...9e8fb9ff782ed93699a2be7fe46e9b47cf122689) | [G07](#g07-wsl-credential-helper-recovery) |
| L021 | #10599 | [docs/reference/commands.mdx:1433](https://github.com/NVIDIA/NemoClaw/blob/29100a321cd9fb2cb12697e19b28db40885f5f5b/docs/reference/commands.mdx#L1433) | [29100a321 → 5ebc7d102](https://github.com/NVIDIA/NemoClaw/compare/29100a321cd9fb2cb12697e19b28db40885f5f5b...5ebc7d10223e3e1e12340681139750449efb0626) | [G08](#g08-provider-specific-portable-inference-recovery) |
| L022 | #10599 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:110](https://github.com/NVIDIA/NemoClaw/blob/5ebc7d10223e3e1e12340681139750449efb0626/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L110) | [5ebc7d102 → 7bd747eb8](https://github.com/NVIDIA/NemoClaw/compare/5ebc7d10223e3e1e12340681139750449efb0626...7bd747eb810bb5b3d6d0338fa21f858662430624) | [G08](#g08-provider-specific-portable-inference-recovery) |
| L023 | #10599 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:123](https://github.com/NVIDIA/NemoClaw/blob/5ebc7d10223e3e1e12340681139750449efb0626/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L123) | [5ebc7d102 → 7bd747eb8](https://github.com/NVIDIA/NemoClaw/compare/5ebc7d10223e3e1e12340681139750449efb0626...7bd747eb810bb5b3d6d0338fa21f858662430624) | [G08](#g08-provider-specific-portable-inference-recovery) |
| L024 | #10599 | [docs/reference/commands.mdx:1416](https://github.com/NVIDIA/NemoClaw/blob/5ebc7d10223e3e1e12340681139750449efb0626/docs/reference/commands.mdx#L1416) | [5ebc7d102 → 7bd747eb8](https://github.com/NVIDIA/NemoClaw/compare/5ebc7d10223e3e1e12340681139750449efb0626...7bd747eb810bb5b3d6d0338fa21f858662430624) | [G08](#g08-provider-specific-portable-inference-recovery) |
| L025 | #10599 | [docs/reference/commands.mdx:1416](https://github.com/NVIDIA/NemoClaw/blob/7bd747eb810bb5b3d6d0338fa21f858662430624/docs/reference/commands.mdx#L1416) | [7bd747eb8 → a5998e863](https://github.com/NVIDIA/NemoClaw/compare/7bd747eb810bb5b3d6d0338fa21f858662430624...a5998e8633876d3a053d7e6e4f8817a4d9b4fae5) | [G08](#g08-provider-specific-portable-inference-recovery) |
| L026 | #10642 | [docs/changelog/2026-08-31.mdx:44](https://github.com/NVIDIA/NemoClaw/blob/a072a44b1d699626226a028343e6e28b7ff7b752/docs/changelog/2026-08-31.mdx#L44) | [a072a44b1 → 55b272438](https://github.com/NVIDIA/NemoClaw/compare/a072a44b1d699626226a028343e6e28b7ff7b752...55b2724383aae239866133c8f7e2282efd75fafc) | [G09](#g09-v00117-portable-probe-performance) |
| L027 | #10642 | [docs/reference/commands.mdx:1690](https://github.com/NVIDIA/NemoClaw/blob/55b2724383aae239866133c8f7e2282efd75fafc/docs/reference/commands.mdx#L1690) | [55b272438 → 783eb29f2](https://github.com/NVIDIA/NemoClaw/compare/55b2724383aae239866133c8f7e2282efd75fafc...783eb29f28ead2e34e94a9a84ab443481aa97521) | [G10](#g10-openclaw-gateway-log-labels) |
| L028 | #10680 | [docs/deployment/deploy-to-headless-server.mdx:219](https://github.com/NVIDIA/NemoClaw/blob/9df87e45657cd81cdbb4a08406753ed523f37d66/docs/deployment/deploy-to-headless-server.mdx#L219) | [9df87e456 → e613661d0](https://github.com/NVIDIA/NemoClaw/compare/9df87e45657cd81cdbb4a08406753ed523f37d66...e613661d00efdf3059fd7135ac6137a691de5f0f) | [G11](#g11-probe-observations-and-hermes-timing) |
| L029 | #10680 | [docs/reference/commands.mdx:991](https://github.com/NVIDIA/NemoClaw/blob/9df87e45657cd81cdbb4a08406753ed523f37d66/docs/reference/commands.mdx#L991) | [9df87e456 → e613661d0](https://github.com/NVIDIA/NemoClaw/compare/9df87e45657cd81cdbb4a08406753ed523f37d66...e613661d00efdf3059fd7135ac6137a691de5f0f) | [G11](#g11-probe-observations-and-hermes-timing) |
| L030 | #10680 | [docs/deployment/deploy-to-headless-server.mdx:220](https://github.com/NVIDIA/NemoClaw/blob/e613661d00efdf3059fd7135ac6137a691de5f0f/docs/deployment/deploy-to-headless-server.mdx#L220) | [e613661d0 → 25789eb23](https://github.com/NVIDIA/NemoClaw/compare/e613661d00efdf3059fd7135ac6137a691de5f0f...25789eb23765b683f18095854697a191303bea01) | [G11](#g11-probe-observations-and-hermes-timing) |
| L031 | #10680 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:190](https://github.com/NVIDIA/NemoClaw/blob/e613661d00efdf3059fd7135ac6137a691de5f0f/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L190) | [e613661d0 → 25789eb23](https://github.com/NVIDIA/NemoClaw/compare/e613661d00efdf3059fd7135ac6137a691de5f0f...25789eb23765b683f18095854697a191303bea01) | [G11](#g11-probe-observations-and-hermes-timing) |
| L032 | #10680 | [docs/reference/commands.mdx:991](https://github.com/NVIDIA/NemoClaw/blob/e613661d00efdf3059fd7135ac6137a691de5f0f/docs/reference/commands.mdx#L991) | [e613661d0 → 25789eb23](https://github.com/NVIDIA/NemoClaw/compare/e613661d00efdf3059fd7135ac6137a691de5f0f...25789eb23765b683f18095854697a191303bea01) | [G11](#g11-probe-observations-and-hermes-timing) |
| L033 | #10680 | [docs/deployment/deploy-to-headless-server.mdx:219](https://github.com/NVIDIA/NemoClaw/blob/25789eb23765b683f18095854697a191303bea01/docs/deployment/deploy-to-headless-server.mdx#L219) | [25789eb23 → 1046a13f0](https://github.com/NVIDIA/NemoClaw/compare/25789eb23765b683f18095854697a191303bea01...1046a13f0aed474dbf08456915d883e35e125e77) | [G11](#g11-probe-observations-and-hermes-timing) |
| L034 | #10680 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:190](https://github.com/NVIDIA/NemoClaw/blob/25789eb23765b683f18095854697a191303bea01/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L190) | [25789eb23 → 1046a13f0](https://github.com/NVIDIA/NemoClaw/compare/25789eb23765b683f18095854697a191303bea01...1046a13f0aed474dbf08456915d883e35e125e77) | [G11](#g11-probe-observations-and-hermes-timing) |
| L035 | #10680 | [docs/reference/commands.mdx:991](https://github.com/NVIDIA/NemoClaw/blob/25789eb23765b683f18095854697a191303bea01/docs/reference/commands.mdx#L991) | [25789eb23 → 1046a13f0](https://github.com/NVIDIA/NemoClaw/compare/25789eb23765b683f18095854697a191303bea01...1046a13f0aed474dbf08456915d883e35e125e77) | [G11](#g11-probe-observations-and-hermes-timing) |
| L036 | #10680 | [docs/reference/commands.mdx:991](https://github.com/NVIDIA/NemoClaw/blob/1046a13f0aed474dbf08456915d883e35e125e77/docs/reference/commands.mdx#L991) | [1046a13f0 → b91126b70](https://github.com/NVIDIA/NemoClaw/compare/1046a13f0aed474dbf08456915d883e35e125e77...b91126b701e808f48c959f948d2f2581133f8955) | [G11](#g11-probe-observations-and-hermes-timing) |
| L037 | #10680 | [docs/reference/commands.mdx:2674](https://github.com/NVIDIA/NemoClaw/blob/1046a13f0aed474dbf08456915d883e35e125e77/docs/reference/commands.mdx#L2674) | [1046a13f0 → b91126b70](https://github.com/NVIDIA/NemoClaw/compare/1046a13f0aed474dbf08456915d883e35e125e77...b91126b701e808f48c959f948d2f2581133f8955) | [G12](#g12-failed-replacement-onboarding) |
| L038 | #10680 | [docs/reference/commands.mdx:1000](https://github.com/NVIDIA/NemoClaw/blob/b91126b701e808f48c959f948d2f2581133f8955/docs/reference/commands.mdx#L1000) | [b91126b70 → 2d2e77fbb](https://github.com/NVIDIA/NemoClaw/compare/b91126b701e808f48c959f948d2f2581133f8955...2d2e77fbb447ffd28e0a6f28b6b695672db3e865) | [G11](#g11-probe-observations-and-hermes-timing) |
| L039 | #10680 | [docs/reference/system-readiness.mdx:142](https://github.com/NVIDIA/NemoClaw/blob/2d2e77fbb447ffd28e0a6f28b6b695672db3e865/docs/reference/system-readiness.mdx#L142) | [2d2e77fbb → 76b454f62](https://github.com/NVIDIA/NemoClaw/compare/2d2e77fbb447ffd28e0a6f28b6b695672db3e865...76b454f6228f15cb73737ef0c68bc519cc7fc4da) | [G13](#g13-dgx-spark-fastos-identity) |
| L040 | #10680 | [docs/reference/system-readiness.mdx:155](https://github.com/NVIDIA/NemoClaw/blob/2d2e77fbb447ffd28e0a6f28b6b695672db3e865/docs/reference/system-readiness.mdx#L155) | [2d2e77fbb → 76b454f62](https://github.com/NVIDIA/NemoClaw/compare/2d2e77fbb447ffd28e0a6f28b6b695672db3e865...76b454f6228f15cb73737ef0c68bc519cc7fc4da) | [G13](#g13-dgx-spark-fastos-identity) |
| L041 | #10680 | [docs/reference/system-readiness.mdx:155](https://github.com/NVIDIA/NemoClaw/blob/76b454f6228f15cb73737ef0c68bc519cc7fc4da/docs/reference/system-readiness.mdx#L155) | [76b454f62 → 776ee21c6](https://github.com/NVIDIA/NemoClaw/compare/76b454f6228f15cb73737ef0c68bc519cc7fc4da...776ee21c640aec41f4549ad31df8aa8aa73c5bc8) | [G13](#g13-dgx-spark-fastos-identity) |
| L042 | #10680 | [docs/reference/system-readiness.mdx:155](https://github.com/NVIDIA/NemoClaw/blob/776ee21c640aec41f4549ad31df8aa8aa73c5bc8/docs/reference/system-readiness.mdx#L155) | [776ee21c6 → ad68dcf37](https://github.com/NVIDIA/NemoClaw/compare/776ee21c640aec41f4549ad31df8aa8aa73c5bc8...ad68dcf37a495575b44b99728c70a109fe7b5b79) | [G13](#g13-dgx-spark-fastos-identity) |
| L043 | #10680 | [docs/reference/system-readiness.mdx:142](https://github.com/NVIDIA/NemoClaw/blob/ad68dcf37a495575b44b99728c70a109fe7b5b79/docs/reference/system-readiness.mdx#L142) | [ad68dcf37 → a843f3ea9](https://github.com/NVIDIA/NemoClaw/compare/ad68dcf37a495575b44b99728c70a109fe7b5b79...a843f3ea94f34cf1f0b3eded5ed6120d0dd61993) | [G13](#g13-dgx-spark-fastos-identity) |
| L044 | #10680 | [docs/reference/system-readiness.mdx:155](https://github.com/NVIDIA/NemoClaw/blob/ad68dcf37a495575b44b99728c70a109fe7b5b79/docs/reference/system-readiness.mdx#L155) | [ad68dcf37 → a843f3ea9](https://github.com/NVIDIA/NemoClaw/compare/ad68dcf37a495575b44b99728c70a109fe7b5b79...a843f3ea94f34cf1f0b3eded5ed6120d0dd61993) | [G13](#g13-dgx-spark-fastos-identity) |
| L045 | #10680 | [docs/get-started/quickstart-hermes.mdx:175](https://github.com/NVIDIA/NemoClaw/blob/a843f3ea94f34cf1f0b3eded5ed6120d0dd61993/docs/get-started/quickstart-hermes.mdx#L175) | [a843f3ea9 → 005028181](https://github.com/NVIDIA/NemoClaw/compare/a843f3ea94f34cf1f0b3eded5ed6120d0dd61993...005028181717d4f2d1672cbaef5ba8b4dbccafb6) | [G14](#g14-hermes-external-dashboard-ingress) |
| L046 | #10680 | [docs/get-started/quickstart-hermes.mdx:175](https://github.com/NVIDIA/NemoClaw/blob/005028181717d4f2d1672cbaef5ba8b4dbccafb6/docs/get-started/quickstart-hermes.mdx#L175) | [005028181 → 605e1af35](https://github.com/NVIDIA/NemoClaw/compare/005028181717d4f2d1672cbaef5ba8b4dbccafb6...605e1af35b997a41b725401fef5ffe28899023b9) | [G14](#g14-hermes-external-dashboard-ingress) |
| L047 | #10680 | [docs/reference/commands.mdx:3584](https://github.com/NVIDIA/NemoClaw/blob/005028181717d4f2d1672cbaef5ba8b4dbccafb6/docs/reference/commands.mdx#L3584) | [005028181 → 605e1af35](https://github.com/NVIDIA/NemoClaw/compare/005028181717d4f2d1672cbaef5ba8b4dbccafb6...605e1af35b997a41b725401fef5ffe28899023b9) | [G14](#g14-hermes-external-dashboard-ingress) |
| L048 | #10832 | [docs/reference/commands.mdx:159](https://github.com/NVIDIA/NemoClaw/blob/fa9005b5f0d5d5b6996e0bc2c6a651191020319c/docs/reference/commands.mdx#L159) | [fa9005b5f → 8e41cc728](https://github.com/NVIDIA/NemoClaw/compare/fa9005b5f0d5d5b6996e0bc2c6a651191020319c...8e41cc7280fa1f01c2387f16ad7ecb02d8fc9bcc) | [G15](#g15-sandbox-command-grammar) |
| L049 | #10832 | [docs/reference/commands.mdx:169](https://github.com/NVIDIA/NemoClaw/blob/fa9005b5f0d5d5b6996e0bc2c6a651191020319c/docs/reference/commands.mdx#L169) | [fa9005b5f → 8e41cc728](https://github.com/NVIDIA/NemoClaw/compare/fa9005b5f0d5d5b6996e0bc2c6a651191020319c...8e41cc7280fa1f01c2387f16ad7ecb02d8fc9bcc) | [G15](#g15-sandbox-command-grammar) |
| L050 | #10832 | [docs/reference/commands.mdx:173](https://github.com/NVIDIA/NemoClaw/blob/fa9005b5f0d5d5b6996e0bc2c6a651191020319c/docs/reference/commands.mdx#L173) | [fa9005b5f → 8e41cc728](https://github.com/NVIDIA/NemoClaw/compare/fa9005b5f0d5d5b6996e0bc2c6a651191020319c...8e41cc7280fa1f01c2387f16ad7ecb02d8fc9bcc) | [G15](#g15-sandbox-command-grammar) |
| L051 | #10832 | [docs/reference/troubleshooting.mdx:45](https://github.com/NVIDIA/NemoClaw/blob/fa9005b5f0d5d5b6996e0bc2c6a651191020319c/docs/reference/troubleshooting.mdx#L45) | [fa9005b5f → 8e41cc728](https://github.com/NVIDIA/NemoClaw/compare/fa9005b5f0d5d5b6996e0bc2c6a651191020319c...8e41cc7280fa1f01c2387f16ad7ecb02d8fc9bcc) | [G16](#g16-incomplete-installation-recovery) |
| L052 | #10919 | [docs/reference/pi-support.mdx:53](https://github.com/NVIDIA/NemoClaw/blob/71516d48ebdfe6633aaf01dcc187bf4e9caef7ef/docs/reference/pi-support.mdx#L53) | [71516d48e → 27b15f2a7](https://github.com/NVIDIA/NemoClaw/compare/71516d48ebdfe6633aaf01dcc187bf4e9caef7ef...27b15f2a7806200fffe4596e354f8fc6962843e3) | [G17](#g17-pi-protected-input-receipt-refresh) |
| L053 | #10919 | [docs/manage-sandboxes/add-channels-after-onboarding.mdx:43](https://github.com/NVIDIA/NemoClaw/blob/27b15f2a7806200fffe4596e354f8fc6962843e3/docs/manage-sandboxes/add-channels-after-onboarding.mdx#L43) | [27b15f2a7 → 5d0ff066d](https://github.com/NVIDIA/NemoClaw/compare/27b15f2a7806200fffe4596e354f8fc6962843e3...5d0ff066df527b3fa5d100da152c5347b1f4f6a2) | [G18](#g18-messaging-profile-and-refresh-boundary) |
| L054 | #10919 | [docs/manage-sandboxes/add-channels-after-onboarding.mdx:72](https://github.com/NVIDIA/NemoClaw/blob/27b15f2a7806200fffe4596e354f8fc6962843e3/docs/manage-sandboxes/add-channels-after-onboarding.mdx#L72) | [27b15f2a7 → 5d0ff066d](https://github.com/NVIDIA/NemoClaw/compare/27b15f2a7806200fffe4596e354f8fc6962843e3...5d0ff066df527b3fa5d100da152c5347b1f4f6a2) | [G18](#g18-messaging-profile-and-refresh-boundary) |
| L055 | #10919 | [docs/manage-sandboxes/manage-messaging-channels.mdx:30](https://github.com/NVIDIA/NemoClaw/blob/27b15f2a7806200fffe4596e354f8fc6962843e3/docs/manage-sandboxes/manage-messaging-channels.mdx#L30) | [27b15f2a7 → 5d0ff066d](https://github.com/NVIDIA/NemoClaw/compare/27b15f2a7806200fffe4596e354f8fc6962843e3...5d0ff066df527b3fa5d100da152c5347b1f4f6a2) | [G18](#g18-messaging-profile-and-refresh-boundary) |
| L056 | #10919 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:293](https://github.com/NVIDIA/NemoClaw/blob/27b15f2a7806200fffe4596e354f8fc6962843e3/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L293) | [27b15f2a7 → 5d0ff066d](https://github.com/NVIDIA/NemoClaw/compare/27b15f2a7806200fffe4596e354f8fc6962843e3...5d0ff066df527b3fa5d100da152c5347b1f4f6a2) | [G18](#g18-messaging-profile-and-refresh-boundary) |
| L057 | #10919 | [docs/deployment/deploy-to-headless-server.mdx:219](https://github.com/NVIDIA/NemoClaw/blob/5d0ff066df527b3fa5d100da152c5347b1f4f6a2/docs/deployment/deploy-to-headless-server.mdx#L219) | [5d0ff066d → af1233393](https://github.com/NVIDIA/NemoClaw/compare/5d0ff066df527b3fa5d100da152c5347b1f4f6a2...af123339354eb7631c4052b98f97bf21648de3b0) | [G11](#g11-probe-observations-and-hermes-timing) |
| L058 | #10919 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:198](https://github.com/NVIDIA/NemoClaw/blob/5d0ff066df527b3fa5d100da152c5347b1f4f6a2/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L198) | [5d0ff066d → af1233393](https://github.com/NVIDIA/NemoClaw/compare/5d0ff066df527b3fa5d100da152c5347b1f4f6a2...af123339354eb7631c4052b98f97bf21648de3b0) | [G11](#g11-probe-observations-and-hermes-timing) |
| L059 | #10919 | [docs/reference/commands.mdx:1033](https://github.com/NVIDIA/NemoClaw/blob/5d0ff066df527b3fa5d100da152c5347b1f4f6a2/docs/reference/commands.mdx#L1033) | [5d0ff066d → af1233393](https://github.com/NVIDIA/NemoClaw/compare/5d0ff066df527b3fa5d100da152c5347b1f4f6a2...af123339354eb7631c4052b98f97bf21648de3b0) | [G11](#g11-probe-observations-and-hermes-timing) |
| L060 | #10919 | [docs/reference/commands.mdx:2112](https://github.com/NVIDIA/NemoClaw/blob/5d0ff066df527b3fa5d100da152c5347b1f4f6a2/docs/reference/commands.mdx#L2112) | [5d0ff066d → af1233393](https://github.com/NVIDIA/NemoClaw/compare/5d0ff066df527b3fa5d100da152c5347b1f4f6a2...af123339354eb7631c4052b98f97bf21648de3b0) | [G18](#g18-messaging-profile-and-refresh-boundary) |
| L061 | #10919 | [docs/manage-sandboxes/manage-mcp-servers.mdx:36](https://github.com/NVIDIA/NemoClaw/blob/af123339354eb7631c4052b98f97bf21648de3b0/docs/manage-sandboxes/manage-mcp-servers.mdx#L36) | [af1233393 → 7ac72ad4e](https://github.com/NVIDIA/NemoClaw/compare/af123339354eb7631c4052b98f97bf21648de3b0...7ac72ad4e1092a70bfcbe4299211660e5b22a7aa) | [G19](#g19-unsafe-deep-agents-mcp-projection) |
| L062 | #10919 | [docs/manage-sandboxes/run-sandboxes.mdx:26](https://github.com/NVIDIA/NemoClaw/blob/af123339354eb7631c4052b98f97bf21648de3b0/docs/manage-sandboxes/run-sandboxes.mdx#L26) | [af1233393 → 7ac72ad4e](https://github.com/NVIDIA/NemoClaw/compare/af123339354eb7631c4052b98f97bf21648de3b0...7ac72ad4e1092a70bfcbe4299211660e5b22a7aa) | [G20](#g20-managed-forward-terminology) |
| L063 | #10919 | [docs/reference/commands.mdx:2269](https://github.com/NVIDIA/NemoClaw/blob/af123339354eb7631c4052b98f97bf21648de3b0/docs/reference/commands.mdx#L2269) | [af1233393 → 7ac72ad4e](https://github.com/NVIDIA/NemoClaw/compare/af123339354eb7631c4052b98f97bf21648de3b0...7ac72ad4e1092a70bfcbe4299211660e5b22a7aa) | [G19](#g19-unsafe-deep-agents-mcp-projection) |
| L064 | #10919 | [docs/reference/troubleshooting.mdx:331](https://github.com/NVIDIA/NemoClaw/blob/af123339354eb7631c4052b98f97bf21648de3b0/docs/reference/troubleshooting.mdx#L331) | [af1233393 → 7ac72ad4e](https://github.com/NVIDIA/NemoClaw/compare/af123339354eb7631c4052b98f97bf21648de3b0...7ac72ad4e1092a70bfcbe4299211660e5b22a7aa) | [G20](#g20-managed-forward-terminology) |
| L065 | #10919 | [docs/reference/troubleshooting.mdx:4374](https://github.com/NVIDIA/NemoClaw/blob/af123339354eb7631c4052b98f97bf21648de3b0/docs/reference/troubleshooting.mdx#L4374) | [af1233393 → 7ac72ad4e](https://github.com/NVIDIA/NemoClaw/compare/af123339354eb7631c4052b98f97bf21648de3b0...7ac72ad4e1092a70bfcbe4299211660e5b22a7aa) | [G20](#g20-managed-forward-terminology) |
| L066 | #10919 | [docs/reference/troubleshooting.mdx:4386](https://github.com/NVIDIA/NemoClaw/blob/af123339354eb7631c4052b98f97bf21648de3b0/docs/reference/troubleshooting.mdx#L4386) | [af1233393 → 7ac72ad4e](https://github.com/NVIDIA/NemoClaw/compare/af123339354eb7631c4052b98f97bf21648de3b0...7ac72ad4e1092a70bfcbe4299211660e5b22a7aa) | [G20](#g20-managed-forward-terminology) |
| L067 | #10919 | [docs/reference/commands.mdx:220](https://github.com/NVIDIA/NemoClaw/blob/7ac72ad4e1092a70bfcbe4299211660e5b22a7aa/docs/reference/commands.mdx#L220) | [7ac72ad4e → dcc991f0f](https://github.com/NVIDIA/NemoClaw/compare/7ac72ad4e1092a70bfcbe4299211660e5b22a7aa...dcc991f0f7a4a64f85415dc83743d88dbf3fd9c8) | [G21](#g21-configuration-export-output-contract) |
| L068 | #10919 | [docs/manage-sandboxes/add-channels-after-onboarding.mdx:49](https://github.com/NVIDIA/NemoClaw/blob/dcc991f0f7a4a64f85415dc83743d88dbf3fd9c8/docs/manage-sandboxes/add-channels-after-onboarding.mdx#L49) | [dcc991f0f → c73823d82](https://github.com/NVIDIA/NemoClaw/compare/dcc991f0f7a4a64f85415dc83743d88dbf3fd9c8...c73823d82ce9590e6d9ff7ee233f0214e38636b6) | [G18](#g18-messaging-profile-and-refresh-boundary) |
| L069 | #10919 | [docs/manage-sandboxes/manage-mcp-servers.mdx:41](https://github.com/NVIDIA/NemoClaw/blob/c73823d82ce9590e6d9ff7ee233f0214e38636b6/docs/manage-sandboxes/manage-mcp-servers.mdx#L41) | [c73823d82 → cab50c1fc](https://github.com/NVIDIA/NemoClaw/compare/c73823d82ce9590e6d9ff7ee233f0214e38636b6...cab50c1fc4825e89f3a044d19dfb69e93c399cf8) | [G19](#g19-unsafe-deep-agents-mcp-projection) |
| L070 | #10919 | [docs/manage-sandboxes/update-sandboxes.mdx:34](https://github.com/NVIDIA/NemoClaw/blob/cab50c1fc4825e89f3a044d19dfb69e93c399cf8/docs/manage-sandboxes/update-sandboxes.mdx#L34) | [cab50c1fc → 7a6a67ba4](https://github.com/NVIDIA/NemoClaw/compare/cab50c1fc4825e89f3a044d19dfb69e93c399cf8...7a6a67ba49d71ea74f93ac4564295b297b6d6e7b) | [G22](#g22-legacy-hermes-immutable-image) |
| L071 | #10919 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:253](https://github.com/NVIDIA/NemoClaw/blob/7a6a67ba49d71ea74f93ac4564295b297b6d6e7b/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L253) | [7a6a67ba4 → 4642d1bc5](https://github.com/NVIDIA/NemoClaw/compare/7a6a67ba49d71ea74f93ac4564295b297b6d6e7b...4642d1bc59ddc98b50742e576a66f46fdf1a8b3e) | [G22](#g22-legacy-hermes-immutable-image) |
| L072 | #11216 | [docs/reference/commands.mdx:3280](https://github.com/NVIDIA/NemoClaw/blob/3893e1cb6570431f08e419bca3ad9775381293b1/docs/reference/commands.mdx#L3280) | [3893e1cb6 → 32713b909](https://github.com/NVIDIA/NemoClaw/compare/3893e1cb6570431f08e419bca3ad9775381293b1...32713b90955822a1a6cc31dd14ea110f2eaa5db4) | [G23](#g23-global-doctor-output-conflict) |
| L073 | #11216 | [docs/reference/commands.mdx:3297](https://github.com/NVIDIA/NemoClaw/blob/32713b90955822a1a6cc31dd14ea110f2eaa5db4/docs/reference/commands.mdx#L3297) | [32713b909 → dbb66a468](https://github.com/NVIDIA/NemoClaw/compare/32713b90955822a1a6cc31dd14ea110f2eaa5db4...dbb66a4682e15a730bfbb790b422cb5e9c58af3e) | [G23](#g23-global-doctor-output-conflict) |
| L074 | #11216 | [docs/reference/commands.mdx:3302](https://github.com/NVIDIA/NemoClaw/blob/32713b90955822a1a6cc31dd14ea110f2eaa5db4/docs/reference/commands.mdx#L3302) | [32713b909 → dbb66a468](https://github.com/NVIDIA/NemoClaw/compare/32713b90955822a1a6cc31dd14ea110f2eaa5db4...dbb66a4682e15a730bfbb790b422cb5e9c58af3e) | [G23](#g23-global-doctor-output-conflict) |
| L075 | #11216 | [docs/reference/commands.mdx:3303](https://github.com/NVIDIA/NemoClaw/blob/dbb66a4682e15a730bfbb790b422cb5e9c58af3e/docs/reference/commands.mdx#L3303) | [dbb66a468 → cac918499](https://github.com/NVIDIA/NemoClaw/compare/dbb66a4682e15a730bfbb790b422cb5e9c58af3e...cac91849964d809559b9b805dadf3927972f1f01) | [G23](#g23-global-doctor-output-conflict) |
| L076 | #11243 | [docs/changelog/2026-09-08.mdx:42](https://github.com/NVIDIA/NemoClaw/blob/fd1649abf2c3d5eb53237d047cf2ab771eef9742/docs/changelog/2026-09-08.mdx#L42) | [fd1649abf → 3c68dd125](https://github.com/NVIDIA/NemoClaw/compare/fd1649abf2c3d5eb53237d047cf2ab771eef9742...3c68dd1256a9a5b351a178740f797e11730ffa28) | [G24](#g24-v00121-delayed-recovery) |
| L077 | #11243 | [docs/reference/commands.mdx:3373](https://github.com/NVIDIA/NemoClaw/blob/3c68dd1256a9a5b351a178740f797e11730ffa28/docs/reference/commands.mdx#L3373) | [3c68dd125 → bf07f4926](https://github.com/NVIDIA/NemoClaw/compare/3c68dd1256a9a5b351a178740f797e11730ffa28...bf07f492629b80e8b6fe2bcffbf4fc5a027bc01b) | [G23](#g23-global-doctor-output-conflict) |
| L078 | #11243 | [docs/changelog/2026-09-08.mdx:51](https://github.com/NVIDIA/NemoClaw/blob/bf07f492629b80e8b6fe2bcffbf4fc5a027bc01b/docs/changelog/2026-09-08.mdx#L51) | [bf07f4926 → 023b3e35d](https://github.com/NVIDIA/NemoClaw/compare/bf07f492629b80e8b6fe2bcffbf4fc5a027bc01b...023b3e35dc1980ea45a1f77d7eb460442bc213d4) | [G25](#g25-hermes-operator-configuration-rebuild) |
| L079 | #11243 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:316](https://github.com/NVIDIA/NemoClaw/blob/bf07f492629b80e8b6fe2bcffbf4fc5a027bc01b/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L316) | [bf07f4926 → 023b3e35d](https://github.com/NVIDIA/NemoClaw/compare/bf07f492629b80e8b6fe2bcffbf4fc5a027bc01b...023b3e35dc1980ea45a1f77d7eb460442bc213d4) | [G25](#g25-hermes-operator-configuration-rebuild) |
| L080 | #11243 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:356](https://github.com/NVIDIA/NemoClaw/blob/bf07f492629b80e8b6fe2bcffbf4fc5a027bc01b/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L356) | [bf07f4926 → 023b3e35d](https://github.com/NVIDIA/NemoClaw/compare/bf07f492629b80e8b6fe2bcffbf4fc5a027bc01b...023b3e35dc1980ea45a1f77d7eb460442bc213d4) | [G25](#g25-hermes-operator-configuration-rebuild) |
| L081 | #11243 | [docs/reference/commands.mdx:2883](https://github.com/NVIDIA/NemoClaw/blob/bf07f492629b80e8b6fe2bcffbf4fc5a027bc01b/docs/reference/commands.mdx#L2883) | [bf07f4926 → 023b3e35d](https://github.com/NVIDIA/NemoClaw/compare/bf07f492629b80e8b6fe2bcffbf4fc5a027bc01b...023b3e35dc1980ea45a1f77d7eb460442bc213d4) | [G25](#g25-hermes-operator-configuration-rebuild) |
| L082 | #11243 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:317](https://github.com/NVIDIA/NemoClaw/blob/023b3e35dc1980ea45a1f77d7eb460442bc213d4/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L317) | [023b3e35d → aec5f1e2c](https://github.com/NVIDIA/NemoClaw/compare/023b3e35dc1980ea45a1f77d7eb460442bc213d4...aec5f1e2c126e9d73a4e7070b706bb15a2475e22) | [G25](#g25-hermes-operator-configuration-rebuild) |
| L083 | #11243 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:324](https://github.com/NVIDIA/NemoClaw/blob/aec5f1e2c126e9d73a4e7070b706bb15a2475e22/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L324) | [aec5f1e2c → 887fb83bc](https://github.com/NVIDIA/NemoClaw/compare/aec5f1e2c126e9d73a4e7070b706bb15a2475e22...887fb83bcc477960bc82909a8b221c3342583dc1) | [G25](#g25-hermes-operator-configuration-rebuild) |
| L084 | #11277 | [docs/reference/system-readiness.mdx:105](https://github.com/NVIDIA/NemoClaw/blob/bed578a1d735f1e401391295b31d53d60dec23e9/docs/reference/system-readiness.mdx#L105) | [bed578a1d → fcc038ff8](https://github.com/NVIDIA/NemoClaw/compare/bed578a1d735f1e401391295b31d53d60dec23e9...fcc038ff8115285e0f51b159d6966fe28861a97e) | [G26](#g26-linux-rootless-docker-socket) |
| L085 | #11277 | [docs/reference/troubleshooting.mdx:663](https://github.com/NVIDIA/NemoClaw/blob/fcc038ff8115285e0f51b159d6966fe28861a97e/docs/reference/troubleshooting.mdx#L663) | [fcc038ff8 → 00eb0ccf4](https://github.com/NVIDIA/NemoClaw/compare/fcc038ff8115285e0f51b159d6966fe28861a97e...00eb0ccf4fc36838800a634c10b9adf05013e24b) | [G27](#g27-tavily-plugin-wording) |
| L086 | #11277 | [docs/reference/commands.mdx:418](https://github.com/NVIDIA/NemoClaw/blob/00eb0ccf4fc36838800a634c10b9adf05013e24b/docs/reference/commands.mdx#L418) | [00eb0ccf4 → 4f8ac0e18](https://github.com/NVIDIA/NemoClaw/compare/00eb0ccf4fc36838800a634c10b9adf05013e24b...4f8ac0e1812eb5ff9ee67d579f48f890369c15a6) | [G28](#g28-abandoned-route-reservation) |
| L087 | #11277 | [docs/reference/troubleshooting.mdx:663](https://github.com/NVIDIA/NemoClaw/blob/00eb0ccf4fc36838800a634c10b9adf05013e24b/docs/reference/troubleshooting.mdx#L663) | [00eb0ccf4 → 4f8ac0e18](https://github.com/NVIDIA/NemoClaw/compare/00eb0ccf4fc36838800a634c10b9adf05013e24b...4f8ac0e1812eb5ff9ee67d579f48f890369c15a6) | [G27](#g27-tavily-plugin-wording) |
| L088 | #11277 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:97](https://github.com/NVIDIA/NemoClaw/blob/4f8ac0e1812eb5ff9ee67d579f48f890369c15a6/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L97) | [4f8ac0e18 → 8d9ba551f](https://github.com/NVIDIA/NemoClaw/compare/4f8ac0e1812eb5ff9ee67d579f48f890369c15a6...8d9ba551f05a8c8ecddff7880d998ac9d4126d0f) | [G29](#g29-portable-hermes-start-and-stop) |
| L089 | #11277 | [docs/reference/commands.mdx:1415](https://github.com/NVIDIA/NemoClaw/blob/4f8ac0e1812eb5ff9ee67d579f48f890369c15a6/docs/reference/commands.mdx#L1415) | [4f8ac0e18 → 8d9ba551f](https://github.com/NVIDIA/NemoClaw/compare/4f8ac0e1812eb5ff9ee67d579f48f890369c15a6...8d9ba551f05a8c8ecddff7880d998ac9d4126d0f) | [G29](#g29-portable-hermes-start-and-stop) |
| L090 | #11277 | [docs/reference/commands.mdx:1450](https://github.com/NVIDIA/NemoClaw/blob/4f8ac0e1812eb5ff9ee67d579f48f890369c15a6/docs/reference/commands.mdx#L1450) | [4f8ac0e18 → 8d9ba551f](https://github.com/NVIDIA/NemoClaw/compare/4f8ac0e1812eb5ff9ee67d579f48f890369c15a6...8d9ba551f05a8c8ecddff7880d998ac9d4126d0f) | [G29](#g29-portable-hermes-start-and-stop) |
| L091 | #11277 | [docs/inference/set-up-vllm-on-two-dgx-sparks.mdx:39](https://github.com/NVIDIA/NemoClaw/blob/8d9ba551f05a8c8ecddff7880d998ac9d4126d0f/docs/inference/set-up-vllm-on-two-dgx-sparks.mdx#L39) | [8d9ba551f → 15f6b2a50](https://github.com/NVIDIA/NemoClaw/compare/8d9ba551f05a8c8ecddff7880d998ac9d4126d0f...15f6b2a50f1c1e350c9544593d9de33c4059d19d) | [G30](#g30-distributed-preset-resume-model) |
| L092 | #11277 | [docs/manage-sandboxes/recover-rebuild-sandboxes.mdx:108](https://github.com/NVIDIA/NemoClaw/blob/8d9ba551f05a8c8ecddff7880d998ac9d4126d0f/docs/manage-sandboxes/recover-rebuild-sandboxes.mdx#L108) | [8d9ba551f → 15f6b2a50](https://github.com/NVIDIA/NemoClaw/compare/8d9ba551f05a8c8ecddff7880d998ac9d4126d0f...15f6b2a50f1c1e350c9544593d9de33c4059d19d) | [G31](#g31-portable-recorded-gateway) |
| L093 | #11277 | [docs/reference/commands.mdx:202](https://github.com/NVIDIA/NemoClaw/blob/15f6b2a50f1c1e350c9544593d9de33c4059d19d/docs/reference/commands.mdx#L202) | [15f6b2a50 → 4a5cd633c](https://github.com/NVIDIA/NemoClaw/compare/15f6b2a50f1c1e350c9544593d9de33c4059d19d...4a5cd633c84a66a89304656034d71c3603fcab66) | [G32](#g32-native-nvidia-configuration-export) |
| L094 | #11277 | [docs/reference/commands.mdx:232](https://github.com/NVIDIA/NemoClaw/blob/4a5cd633c84a66a89304656034d71c3603fcab66/docs/reference/commands.mdx#L232) | [4a5cd633c → 7b70bf86e](https://github.com/NVIDIA/NemoClaw/compare/4a5cd633c84a66a89304656034d71c3603fcab66...7b70bf86e97f5058db5da41a25985a5933fbad1d) | [G32](#g32-native-nvidia-configuration-export) |
| L095 | #11277 | [docs/reference/commands.mdx:1426](https://github.com/NVIDIA/NemoClaw/blob/4a5cd633c84a66a89304656034d71c3603fcab66/docs/reference/commands.mdx#L1426) | [4a5cd633c → 7b70bf86e](https://github.com/NVIDIA/NemoClaw/compare/4a5cd633c84a66a89304656034d71c3603fcab66...7b70bf86e97f5058db5da41a25985a5933fbad1d) | [G29](#g29-portable-hermes-start-and-stop) |
| L096 | #11277 | [docs/reference/commands.mdx:232](https://github.com/NVIDIA/NemoClaw/blob/7b70bf86e97f5058db5da41a25985a5933fbad1d/docs/reference/commands.mdx#L232) | [7b70bf86e → 020e47b33](https://github.com/NVIDIA/NemoClaw/compare/7b70bf86e97f5058db5da41a25985a5933fbad1d...020e47b3314d7db06311b5c3ee621cc7858f4048) | [G32](#g32-native-nvidia-configuration-export) |
| L097 | #11277 | [docs/reference/commands.mdx:429](https://github.com/NVIDIA/NemoClaw/blob/7b70bf86e97f5058db5da41a25985a5933fbad1d/docs/reference/commands.mdx#L429) | [7b70bf86e → 020e47b33](https://github.com/NVIDIA/NemoClaw/compare/7b70bf86e97f5058db5da41a25985a5933fbad1d...020e47b3314d7db06311b5c3ee621cc7858f4048) | [G28](#g28-abandoned-route-reservation) |
| L098 | #11277 | [docs/reference/commands.mdx:233](https://github.com/NVIDIA/NemoClaw/blob/020e47b3314d7db06311b5c3ee621cc7858f4048/docs/reference/commands.mdx#L233) | [020e47b33 → 1d4d41d20](https://github.com/NVIDIA/NemoClaw/compare/020e47b3314d7db06311b5c3ee621cc7858f4048...1d4d41d203c04012db4df00ba76f1ff33857bee3) | [G32](#g32-native-nvidia-configuration-export) |
| L099 | #11277 | [docs/reference/commands.mdx:232](https://github.com/NVIDIA/NemoClaw/blob/1d4d41d203c04012db4df00ba76f1ff33857bee3/docs/reference/commands.mdx#L232) | [1d4d41d20 → bf2bbbfc2](https://github.com/NVIDIA/NemoClaw/compare/1d4d41d203c04012db4df00ba76f1ff33857bee3...bf2bbbfc22d1e6484189aaf0f876692de68a6297) | [G32](#g32-native-nvidia-configuration-export) |
| L100 | #11277 | [docs/reference/commands.mdx:233](https://github.com/NVIDIA/NemoClaw/blob/bf2bbbfc22d1e6484189aaf0f876692de68a6297/docs/reference/commands.mdx#L233) | [bf2bbbfc2 → 457aa3ac7](https://github.com/NVIDIA/NemoClaw/compare/bf2bbbfc22d1e6484189aaf0f876692de68a6297...457aa3ac70944bf5e2ccaacd2e9748afa2fec84f) | [G32](#g32-native-nvidia-configuration-export) |
| L101 | #11277 | [docs/reference/commands.mdx:202](https://github.com/NVIDIA/NemoClaw/blob/457aa3ac70944bf5e2ccaacd2e9748afa2fec84f/docs/reference/commands.mdx#L202) | [457aa3ac7 → 41ffad31b](https://github.com/NVIDIA/NemoClaw/compare/457aa3ac70944bf5e2ccaacd2e9748afa2fec84f...41ffad31bd3dd032165b7e6e2c6c11447f57a2b4) | [G32](#g32-native-nvidia-configuration-export) |
| L102 | #11277 | [docs/reference/commands.mdx:232](https://github.com/NVIDIA/NemoClaw/blob/41ffad31bd3dd032165b7e6e2c6c11447f57a2b4/docs/reference/commands.mdx#L232) | [41ffad31b → ee21c693b](https://github.com/NVIDIA/NemoClaw/compare/41ffad31bd3dd032165b7e6e2c6c11447f57a2b4...ee21c693b9537a6e6bb1003de0cc49f41f98f24e) | [G32](#g32-native-nvidia-configuration-export) |
| L103 | #11277 | [docs/reference/commands.mdx:233](https://github.com/NVIDIA/NemoClaw/blob/ee21c693b9537a6e6bb1003de0cc49f41f98f24e/docs/reference/commands.mdx#L233) | [ee21c693b → ffacf0879](https://github.com/NVIDIA/NemoClaw/compare/ee21c693b9537a6e6bb1003de0cc49f41f98f24e...ffacf08793ff7af5eaf631ee290182d3f9ae7afb) | [G32](#g32-native-nvidia-configuration-export) |
| L104 | #11277 | [docs/reference/commands.mdx:232](https://github.com/NVIDIA/NemoClaw/blob/ffacf08793ff7af5eaf631ee290182d3f9ae7afb/docs/reference/commands.mdx#L232) | [ffacf0879 → 357bb9f6b](https://github.com/NVIDIA/NemoClaw/compare/ffacf08793ff7af5eaf631ee290182d3f9ae7afb...357bb9f6b07d969d836582e0a749c91ea35c8a2c) | [G32](#g32-native-nvidia-configuration-export) |

## Validation and Review

- DORI routing followed `docs/AGENTS.md`: collection-verification capability was unavailable, so the repository documentation guide supplied the writing and review rules.
- `npm run docs` passed with zero Fern errors and four warnings.
- The generated OpenClaw, Hermes, and Deep Agents pages were inspected for command substitution, conditional content, and links; Pi remains a single-variant page.
- The independent audit checked all 24 inventory entries, 83 bot patches, removed-text cases, and terminal closed drafts.
- The PR records the commit-specific independent writer review and publication validation.
- No implementation, automation, credential, or secret file changes are part of the recovery.
