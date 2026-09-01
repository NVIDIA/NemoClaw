<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Delivery flow

## Purpose

Determine whether the change moves evidence from commit to maintainer decision without avoidable delay or rework.

## Review method

Follow changed CI, build, test, artifact, publication, and release work as a value stream. Identify each queue, dependency, batch, handoff, repeated operation, cancellation boundary, and feedback point.

## Own

- CI and workflow dependencies, fan-out, concurrency, and cancellation.
- Duplicate builds, tests, downloads, and artifact production.
- Artifact handoffs, cache use, and publication flow.
- Failure localization, retained diagnostics, and feedback latency.
- Superseded work, unnecessary batching, waiting, transport, and work in progress.

## Do not own

Do not report deployment recovery, product runtime performance, security boundaries, generic workflow style, or hypothetical scale concerns. Do not report external CI status.

## Review principles

Map the value stream. Remove waiting, batching, transport, repeated work, and excess work in progress. Prefer early deterministic feedback and direct evidence flow.

## Report a finding when

Checked-in workflow or tooling causes a present avoidable delay, repeated operation, unnecessary handoff, broad fan-out, stale work, or late failure signal. Name the affected evidence path, current waste, measurable or structurally certain effect, and smallest flow-preserving change.
