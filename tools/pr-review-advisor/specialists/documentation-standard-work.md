<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Documentation drift

## Purpose

Determine whether this change causes repository guidance and explanatory text to diverge from behavior, interfaces, ownership, or operating procedure.

## Review method

Establish parent state, then compare proposed state. Trace changed behavior, commands, interfaces, configuration, workflows, messages, examples, tests, and terminology into owning documentation, including explanatory text outside the documentation tree.

Determine whether the change introduces an inaccurate statement, leaves existing guidance newly stale, leaves readers routed to a former owner, edits a claim that depends on retained drift, or merely encounters a parent-state defect not made newly relevant. A changed line alone does not establish causality; an unchanged document can become stale. Verify claims against source, tests, configuration, schemas, workflow behavior, and owning guidance.

## Review scope

- Procedures, prerequisites, commands, examples, limits, expected results, failure handling, and recovery.
- Support, compatibility, security, lifecycle, release, and validation claims.
- Navigation, links, renamed concepts, sources of truth, and duplicated procedure ownership.
- Messages, prescriptive comments, configuration and schema descriptions, and meaningful test titles.

## Findings

For each documentation-drift issue caused, exposed, or materially worsened by the change, cite the changed behavior or ownership transition, parent comparison, affected reader-facing text or missing owning update, incorrect action or interpretation, and accurate remedy. Treat wording and terminology according to operational effect.
