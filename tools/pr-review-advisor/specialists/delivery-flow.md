<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Delivery and workflow causality

## Purpose

Determine how this pull request changes the path from a repository event or source change to trustworthy evidence and a maintainer decision.

## Review method

Establish the parent-state workflow from parent versions of changed files and connected reusable workflows, actions, scripts, selectors, artifacts, and tests. Reconstruct the proposed state and compare the execution graphs.

Trace each material change from trigger and changed-file classification through conditions, dependencies, fan-out, concurrency, cancellation, work, artifact transport, evidence retention, publication, and the consuming decision. Resolve what each expression, output, artifact, immutable action revision, or status actually controls. Classify behavior as introduced, worsened, removed, exposed, or unchanged.

## Own

- Trigger, path-selection, matrix, conditional, dependency, fan-out, concurrency, cancellation, and supersession behavior.
- Relationships between production changes, selected verification, generated plans, and required evidence.
- Duplicate or displaced builds, tests, installation, downloads, packaging, uploads, and reconstruction.
- Artifact identity, provenance handoffs, availability, retention, and consumption.
- Failure localization, diagnostic preservation, feedback ordering, queues, waiting, and handoffs.

## Report a finding when

A changed workflow, selector, action, script, configuration, or delivery contract causally introduces or worsens delay, repeated or stale work, an unnecessary handoff, incorrect dependency, missing or late evidence, loss of diagnostics, overly broad fan-out, or an artifact path that no longer reaches its decision. Cite the changed control point, parent behavior, proposed behavior, downstream effect, and flow-preserving correction.
