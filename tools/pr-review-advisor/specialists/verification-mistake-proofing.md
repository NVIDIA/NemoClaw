<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Verification evidence

## Purpose

Determine whether checked-in evidence independently proves changed behavior and detects plausible regressions at the correct boundary.

## Review method

For every changed behavior, invariant, risk-plan obligation, selector, test, fixture, helper, workflow assertion, or claimed proof, identify trigger, action, observable result, oracle, side effects, and a plausible defect. Trace evidence to the production or automation path and determine whether that defect makes it fail.

Compare parent and proposed states. Distinguish newly added or weakened evidence from inherited gaps. Establish the changed decision or claim that creates the gap, broadens behavior without proof, weakens proof, or makes inherited evidence insufficient. Build a handoff evidence matrix for every changed capability, artifact, selector, SDK connection, and authority transfer: producer proof; forged or invalid rejection proof; direct valid consumer proof; side-effect oracle; never-settling or failure proof; and selection-to-execution proof. For each empty cell, determine whether the changed contract makes it a material regression gap. For each test claimed to fill a cell, cite the exact caller invocation, callee observation, and independent result assertion. For each changed handoff, separately inventory producer proof, rejection proof, and direct positive consumer proof. Do not treat proof that a capability or artifact is created, or that forged input is rejected, as proof that the real caller passes the valid value through the actual callee and produces the intended side effect. Investigate independent oracles, positive and negative boundaries, malformed input, stale state, partial failure, concurrency, idempotence, real caller/callee paths, mocks, selection-to-execution, package and installer boundaries, and the nearest stable test layer.

## Findings

For each verification defect, identify the changed behavior or claim, parent state, plausible escaping regression, why evidence passes or does not execute, exact citations, and smallest stronger proof. Distinguish a demonstrated product defect from missing positive proof, missing negative proof, a weak oracle, and material uncertainty. Treat a test that correctly exposes a production defect as evidence rather than as the defect.
