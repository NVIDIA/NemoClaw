<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Process Window pilot decision

Decision: **Accept for the phase 2 pilot**. This records the requester's existing implementation decision, not independent merge approval.

The requester authorized implementation and testing on separate NemoClaw `main` and `v1` PRs, followed by comparison with phase 1 local runs. The accepted two-phase design calls for repository guidance discovery, editable YAML, and a static lifecycle browser. It excludes enforcement analysis, a hosted backend, public packaging, and automatic source synchronization.

## Purpose and placement

Help contributors find guidance used by agents at each development stage and open its source at the analyzed revision. Keep uncertain relationships visible for review. Inference and schema validation cannot prove exhaustive discovery or correct semantic classification.

Place the self-contained copy in `tools/process-window/`. Keep its dependencies independent of the root project. Store both branch maps in `mapping.yaml` on `process-window-data`; publish one GitHub Pages browser with branch selection. The private source repository is not a CI dependency.

## Ownership and lifecycle

The PR author, `jyaunches`, owns implementation and pilot validation for these two contributions. Reusable fixes are developed in the source project and copied manually with a source-revision note. NemoClaw maintainers retain merge and activation decisions. This pilot does not establish a long-term service support commitment.

Refresh `main` on selected releases and `v1` on branch changes. Support manual analysis and mapping edits. Keep automatic refresh and publication off until maintainers adopt the integration and configure its repository settings. Disable refresh or publication through the documented variables; Git history and a build-only run provide recovery.

## Compatibility and trust

Use the owning branch's supported Node setup and independent tool dependencies. Preserve phase 1 mapping compatibility, including explicit YAML requirement audits. The ordinary workflow analyzes guidance and builds the site; it does not run requirement audits automatically.

Repository writers, including mapping editors, are trusted to use repository-level inference credentials. The mapping branch contains a workflow definition that its writers can change. Checking out tool code from main does not create a security boundary against those writers. Do not delegate mapping-branch writes to untrusted editors under this model. A future restricted editor role needs a separate credential and workflow authorization design before adoption.

The inference step receives the existing NVIDIA endpoint credential through its process environment. The tool does not persist it. PR validation uses no inference credential. Publication uses a separate job with conditional signed commits, and deployment uses the Pages environment. No workflow changes repository settings automatically.

## Validation and activation

Before merge, validate the tool, workflow, browser, and branch-specific CI. Run independent hosted analysis for both historical phase 1 revisions. Compare the YAML and rendered source links with the local results, and inspect substantive classification differences against repository evidence.

After merge and configuration, verify a real signed mapping commit, Pages deployment, automatic refresh for each branch, and a manual-edit rebuild. Confirm generated commits do not trigger inference loops and failed analysis leaves the working site available. Contract tests cannot establish these live publication outcomes. The PR validation report must distinguish completed tests from activation checks that remain unverified.
