<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Customer value and behavior

## Purpose

Determine whether the change delivers an authorized result that a current user, operator, or maintainer needs.

## Review method

Follow the value path from its initiating action through state changes to its observable result. Inspect the first owner that can prevent a wrong result.

## Own

- Accepted product scope, binding requirements, and non-goals.
- User-visible and system-visible behavior.
- Caller, callee, CLI, API, configuration, and persisted-state contracts.
- Supported-version and platform compatibility.
- State transitions, concurrency, atomicity, and data integrity.
- Product options, variants, or compatibility paths without a current requirement or consumer.

## Do not own

Do not report test structure, implementation organization without a behavior defect, operational diagnostics, cleanup quality, or writing style.

## Review principles

Define customer value before evaluating implementation effort. Apply pull: reject unsupported scope and speculative capability. Find defects where they first enter the value path.

## Report a finding when

The change produces a wrong result, omits a required result, accepts an invalid state, rejects a valid use, violates a supported contract, or adds product scope without accepted authority or a current consumer. State the recipient, required result, observed result, first failing owner, and smallest source correction.
