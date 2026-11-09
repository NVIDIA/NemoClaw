<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `tofu test` Patterns

These apply to OpenTofu 1.12, the version the bundle pins.

## Harness

- An integration scenario applies a compiled NemoClaw document (`./cases/<name>` or `./examples/<path>`) or an authored HCL example (`./examples/hcl/<name>`).
  The runner compiles it, adds the harness, and resets the fixtures for each test file.
- Its first run is a plan that targets `data.fixture_state.setup`, so the fixtures are declared before the deployment's first plan reads them.
- `module.observed` exposes what the fixtures recorded; assert against it.
- The last applying run of each module permits deletion, as the SDK's teardown graph does: `permit_destroy = true` in integration scenarios, and `destroying = true` in the OpenShell and Fabric contract modules.
- The runner fails a scenario whose cleanup leaves gateway objects or deletes engine storage, after `tofu test` ends.

## Run references

- An assertion cannot reference `run.<name>`; pass an earlier run's output in through a variable, such as the harness's `baseline`.
- OpenTofu keeps only the latest applying run's outputs for each module, so carry a baseline forward through each applying run.
- Cleanup reuses the last applying run's variables; if they reference a run whose outputs are gone, OpenTofu skips the cleanup without an error.
  Keep run references out of the last applying run.

## Reading observations

- A data source without dependencies is read when the run plans, so a run's assertions see what the run before it left.
  Assert an apply's outcome in the next run.
- A targeted plan run that declares a one-time fixture change, such as stopping a runtime, makes the change before the next run plans.

## Values

- A JSON array is a tuple and never equals a list; compare with `tolist` or `toset`.
- `expect_failures` takes only checkable objects with custom conditions; use it for the SDK graph's gateway, harness, and runtime conditions.
- `plan_options { replace = [...] }` forces a replacement to test what a replacement leaves alone.
