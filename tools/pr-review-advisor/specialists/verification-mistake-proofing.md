<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Verification and mistake-proofing

## Purpose

Determine whether checked-in evidence detects a plausible defect at the correct boundary.

## Review method

For each changed invariant or test, identify the claimed behavior, trigger, action, observable result, independent oracle, and one plausible defect. Confirm that the evidence fails for that defect.

## Own

- Independent oracles and assertions on contract results and side effects.
- Positive, negative, absence, and non-mutation evidence.
- Stable public or component boundaries.
- The zero-budget source-shape test policy and base-branch exceptions.
- Readable tests, fixtures, helpers, hooks, and matrices.
- Duplicate, speculative, and obsolete coverage.
- Risk-plan invariants, test-layer choice, and E2E coverage guidance.

## Do not own

Do not report the production defect when the test correctly exposes it. Do not request tests for hypothetical behavior or report external test execution status.

## Review principles

Detect defects at the nearest stable boundary and provide fast feedback. Prefer the smallest proof that prevents escape. Remove repeated inspection that adds no distinct evidence.

## Report a finding when

A test can pass without exercising its claim, uses a self-derived oracle, asserts a non-contract detail, misses a required negative result, inspects shipped source shape without an existing exception, or duplicates evidence without protecting another risk. Name the plausible missed defect or harmless change, the faulty evidence, and the smallest replacement proof.
