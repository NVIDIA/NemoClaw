<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenShift Offline Validation

These checks cover the OpenShift profile introduced on `codex/kubernetes-backend` after merging `v1` revision `0e129eaa` on 2026-09-30.
The source revision is the commit containing this record.
The host was Linux AMD64; no OpenShift cluster, cluster version, live SCC admission, or external inference endpoint was tested.
The [scope decision](../design/scope.md#kubernetes-development-branch) permits offline implementation without making a compatibility claim.

## Observed Behavior

The SDK configuration tests passed for provider selection, managed distribution agreement, rejected mixed OpenShift drivers, immutable images, both three-agent examples, and export preservation.
The graph tests mapped the authored OpenShift profile to the upstream Kubernetes driver and emitted image metadata discovery without a local engine or hardware observation.
Python platform tests passed for absent OpenShift APIs, missing or invalid UID/GID ranges, changed allocations, namespace ownership changes, read-only observation, and authenticated TLS settings.

The actual pinned upstream Helm chart rendered successfully for the managed OpenShift profile and standalone Kubernetes fixture.
Both renders used the immutable gateway, runtime, and supervisor image pins while retaining TLS and bearer authentication.
The render regression initially failed because the merged chart moved image values; it passed after both callers adopted the current values contract.
With the optional chart tests enabled, 52 managed-platform Python tests and 65 local fixture Python tests passed.

A local Linux AMD64 `openclaw-openshift` image build completed with its installed Fabric catalog.
Its index was `sha256:5bfe7e3b84a5ee8b67c885ddc1c74442d5d79d57a65f072cedee07473475666e`.
Two image smoke checks passed as UID `1000700000` and distinct GID `1000800000`, with networking disabled and a read-only root filesystem.
They checked readable runtime files and plugins, absent privileged group membership, and empty read-only workspace seeds; the native OpenClaw version command also succeeded.
These checks do not run OpenShell sandbox isolation or an agent model response.

The full Rust workspace passed 1,036 tests, with 141 opt-in tests ignored.
Strict workspace Clippy, Rust formatting, Python lint and formatting, generated schema/reference checks, and the complete documentation checks passed; Fern retained one existing warning.
The metadata exporter passed 15 tests and the image build-plan suite passed nine.
Independent code and documentation reviews found no remaining consequential issue, and staged source contained no NVIDIA-key or private-key pattern.

A fresh verified Linux AMD64 bundle (`0.1.0-dev.7df0262d09d0f498`) passed three production-provider protocol fixtures in 10.04 seconds.
They used real OpenTofu with deterministic OpenShell gateway and hashed OCI metadata fixtures to check Kubernetes and OpenShift plan/apply, unchanged reapply, export preservation, driver-drift rejection without mutation, and destroy after removing the metadata artifact.
A separate real-OpenTofu fixture passed interrupted Kubernetes creation and recovery without taint or replacement in 7.01 seconds.
These protocol fixtures create no cluster and send no hosted inference requests.
The bundle was built before the final documentation-only result update; executable source and pinned dependencies were unchanged.

The actual built image exported three verified OCI metadata blobs into a private mode-0600 file.
A production-provider OpenTofu plan then read that artifact successfully with no gateway, Docker engine, or cluster configured.
It reported the verified image catalog and Linux AMD64 platform without creating managed resources.
The actual image also passed seven packaging checks; two checks for other harnesses were skipped.

## Remaining Qualification

A future disposable OpenShift target must validate restricted SCC admission, namespace allocation, Agent Sandbox, persistent storage, runtime isolation, network-policy enforcement, and all three agents' model responses.
It must also check unchanged plan, export/reapply, failed-operation recovery, destroy, and retained ownership before any compatibility claim.
Earlier [Kubernetes Fabric live results](kubernetes-fabric-live-linux-amd64.md) remain scoped to their recorded commits and kind environments; they do not qualify this merged revision or OpenShift.
