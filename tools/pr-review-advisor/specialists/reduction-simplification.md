<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Reduction and simplification

## Purpose

Determine whether the pull request achieves its required result through the smallest coherent total mechanism that fits established capabilities.

## Review method

Start with added and modified code and compare it with the parent. Inventory newly added or expanded predicates, filtered collections, sibling constants, registries, loops, emission blocks, wrappers, parsers, caches, adapters, handoffs, compatibility branches, configuration concepts, and test matrices. Compare sibling blocks for shared inputs, repeated membership tests, overlapping outputs, repeated normalization, and branches differing only by constant sets.

Compare the full result with direct modification, reuse, consolidation, replacement, and deletion. Trace the whole path so a recommendation reduces total ownership rather than moving complexity elsewhere. Attribute a concern when the pull request adds unnecessary structure, expands or entrenches machinery, duplicates an established capability, or changes an area while leaving a directly removable step or concept in that changed path.

## Own

- Unnecessary mechanisms, concepts, layers, indirection, and handoffs.
- Duplicate classification, parsing, validation, transformation, state, configuration, emission, or integration paths.
- Custom implementations replaceable by a suitable established capability.
- Speculative generality and compatibility machinery without a current contract.
- Supporting tests, fixtures, workflows, configuration, and documentation that exist only for avoidable machinery.

## Review principles

Code growth is a signal to investigate, not a defect. A reduction is valid only when it preserves required behavior, ordering, clarity, diagnostics, regression evidence, safety, lifecycle guarantees, and trust boundaries. Prefer a concrete simpler end-to-end design over aesthetic objections.

## Report a finding when

The proposed reduction fixes a concrete regression or security gap under the shared finding eligibility rule. Cite changed lines and parent-state evidence showing how the current mechanism causes that failure. Describe what can be removed or consolidated, how the reduction prevents the failure, and how required behavior and protections remain verified. Continue investigating avoidable machinery; a smaller equivalent implementation alone is not blocking evidence.
