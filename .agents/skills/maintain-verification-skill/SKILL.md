---
name: maintain-verification-skill
description: Audit a project-local verify skill and its feature map against the code and a live run, and ship only proven corrections. Use to audit or refresh a verify skill.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 Lauren Tan -->
<!-- SPDX-License-Identifier: Apache-2.0 AND MIT -->
<!-- Adapted from pstack's maintain-verification-skill; see ../NOTICE.md. -->

# Maintain a Verification Skill

A feature map goes stale when the product changes.
This skill audits a `.agents/skills/verify-<surface>` skill that the `create-verification-skill` skill generated, or any project skill with launch and drive sections and a feature map.
Cover every feature file from source and drive every feature live.

## Outcomes

- **clean**: every feature got source and live coverage, and nothing needs to change.
- **changed**: one pull request ships proven corrections.
- **blocked**: coverage couldn't finish or a proven fix couldn't ship; say exactly why.

## Edit Scope

Edit only the verify skill's directory and the helpers it owns.
Don't edit product code: a behavior the map describes that the product no longer has is either map drift, which you fix, or a product regression, which you report.

## Pass

0. **Find the target.** Find the `verify-*` skills under `.agents/skills`.
   Ask which one when there are several; stop and point to `create-verification-skill` when there are none.
1. **Check the index.** Fix missing, extra, duplicate, or dead entries in `features/README.md`.
2. **Read the source.** Give each feature file to a read-only agent session, run in parallel.
   Each one explains how the feature works from source, cites likely drift, and returns one live recipe.
   These sessions never drive the product or edit files.
3. **Reconcile.** Merge the recipes into as few deployment states as practical, spot-check cited drift, and look through recent commits for user-facing features missing from the map; cite a source path for each.
4. **Drive live.** Required even when the source looks clean.
   Drive every feature yourself, following the skill's own launch and cleanup.
   Throughout the pass:
   - Run the skill's doctor before the first drive and after any failed drive; when doctor can't see a failure, relaunch.
   - Confirm the evidence survives each cleanup at its named location.
   - Remove what each failed drive left behind, and leave no resource with the run's UID after the pass.

   A doctor failure caused by drift in the skill is drift: fix it and retry once before calling the pass blocked.
   Call a feature unreachable only with the missing prerequisite, such as credentials, a GPU, or a platform, and the route you tried.
   Drive every harness fix again before shipping it.
5. **Triage.** A wrong or missing description is map drift: fix it.
   Working behavior the harness can't drive is a harness gap: fix it.
   Broken product behavior is a product regression: report it, and keep it out of this change.
6. **Ship or stop.** For changed, reread every changed file and open one pull request with the `nemoclaw-contributor-create-pr` skill after the user agrees.
   For clean or blocked, report the outcome and coverage without a pull request.

Keep run notes outside the checkout; don't commit them.
