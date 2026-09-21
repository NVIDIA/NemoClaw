<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Gateway Readiness in a Single OpenTofu Plan

A manually executed HCL graph created a real Docker gateway and an OpenShell workspace in one saved-plan apply.
The gateway capability dependency completed before workspace creation, and the next plan reported no changes.
This extends the [deferred provider configuration result](openshell-deferred-configuration-linux-arm64.md) from a synthetic bootstrap to an actual gateway process.

## Revision and Environment

Tested on 2026-09-20 on Linux ARM64 after synchronizing `origin/v1` through `c51b2d42b4`.
The implementation is `8527dc85c9`; the checked-in live fixture is `90bb133fbc`.
The verified bundle is `0.1.0-dev.2fde7b41db53cbd5`, with OpenTofu 1.12.6, Docker provider 4.6.0, and the production NemoClaw provider.
The local engine was Docker 29.2.1 at `unix:///var/run/docker.sock`.
The already loaded gateway image was `ghcr.io/nvidia/openshell/gateway@sha256:ec2b0efea84fff198e888e97c85befb9c908acde92e8256f9b527877ed182d66`.
Its API reported `0.0.117-dev.186+g1fe79f539`.

The [standalone HCL fixture](../../crates/nemoclaw-e2e/tests/fixtures/gateway_readiness.tf) composes four responsibilities:

- NemoClaw gateway storage initializes and verifies retained gateway identity and configuration.
- The Docker provider starts the gateway process with `wait = false`.
- The NemoClaw gateway capability data source waits for a valid API observation and checks Docker compatibility through an HCL postcondition.
- The workspace depends on that capability observation.

The OpenShell provider endpoint depends on the Docker container ID, so it is unknown until the process is created.
The bootstrap provider alias has a separate known endpoint and uses only the engine-backed storage resource.
No SDK compiler, deployment coordinator, targeted apply, shell readiness loop, model, or agent was used.

## Observed Results

| Step | Result |
|---|---|
| Initial plan | Planned three managed resources; the initial manual attempt also verified that planning created no owned Docker resources. |
| Corrected fresh saved-plan apply | Completed in 2.72 seconds: storage, container, capability read, then workspace. |
| Unchanged plan | Exit code 0 with no changes, in 2.26 seconds. |
| Stop the owned gateway | Planning failed on workspace observation before any repair; the state file remained byte-for-byte unchanged. |
| Explicitly restart the owned gateway | Same container ID; planning returned no changes in 2.60 seconds. |
| Cleanup | Verified ownership labels before removing the test gateway, initializer, volume, and bridge. |

The successful run used container `nc-5303097f55791213-gateway`, port 38643, and the unused subnet `10.243.20.0/24`.
The workspace ID was `a8fb9e43-986f-49df-9f92-494c5756b1dd`.
These identify the completed test; do not reuse its identity or state for another deployment.
The first attempt used the longer container name as a workspace name and received an upstream invalid-argument response.
The corrected fixture uses the 19-character workspace prefix, and the successful run started with a new identity and empty state.

The real gateway was ready by its first capability observation; this run establishes dependency ordering, not that retries occurred.
The [deterministic OpenTofu test](../../crates/nemoclaw-e2e/tests/fixtures/standalone_openshell.rs) separately keeps the gateway unavailable for two observations and verifies that no workspace is created before it becomes available.
Provider unit tests cover the deadline, stalled observations, timeout validation, the default single observation, and immediate failure for authentication, permission, query, and incomplete-observation errors.

## Contract and Limits

The capability data source accepts optional `wait_timeout_seconds`, an integer from 0 through 300.
Omission or zero preserves one ordinary observation without retry; a positive value bounds the entire wait, including each in-flight read.
Only transport failures are retried, at 200-millisecond intervals between completed attempts.
An incompatible but valid capability response is returned immediately; the HCL postcondition rejects it.
With unknown upstream dependencies, OpenTofu defers the data read until apply.
Otherwise, the configured wait can also run during planning.

This qualifies gateway API availability and driver compatibility, not sandbox startup, application health, model inference, mTLS, GPU execution, or Podman.
The SDK's existing runtime readiness path was not changed in this step.
The stopped-gateway result confirms that bound-resource refresh still prevents a single graph from repairing an unavailable gateway before observation; retain staged recovery.
Application readiness remains runtime-owned.

Workspace and storage declarations prevent ordinary destruction.
The final removal was explicit disposal of the isolated test fixture, including its generated credentials and workspace database; it does not change the product's retained-storage behavior.
No pre-existing deployment resources were modified.

To repeat the manual qualification, use the checked-in HCL with a verified native bundle, its provider version, an explicitly selected local engine and pinned image, and fresh ownership, resource names, free port, subnet, and state directory.
Replace all `@...@` placeholders before initializing OpenTofu.
Set `TF_CLI_CONFIG_FILE` to a CLI configuration whose `provider_installation` block uses a `filesystem_mirror` pointing to the verified bundle's absolute `providers/` directory.
Supply the required HCL variables `name`, `owner`, `port`, and `subnet` in the new state directory.
Use a fresh UUID for `owner`, a name of the form `nc-<16 lowercase hex digits>-gateway`, a free unprivileged loopback port, and a non-overlapping private IPv4 `/24`.
The fixture binds the local Docker socket and therefore requires `unix:///var/run/docker.sock` on the test host.
Keep any failed-run state until recovery or ownership-checked cleanup is complete.
