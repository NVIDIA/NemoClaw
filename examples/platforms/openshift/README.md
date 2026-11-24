<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenShift Examples

| Configuration | Purpose and prerequisites | Expected result |
|---|---|---|
| [managed-development.yaml](managed-development.yaml) | Install a development gateway on a cluster you operate; supply kubeconfig, context, namespace, pullable harness images, and inference settings. | A managed gateway and three OpenClaw agents. |
| [external-gateway.yaml](external-gateway.yaml) | Use an existing OpenShift gateway; supply its endpoint, bearer and TLS references, harness images, and inference settings. | Three OpenClaw agents on the external gateway. |
| [published-route.yaml](published-route.yaml) | Configure an OIDC issuer and publish the gateway through an OpenShift Route. | A managed gateway and one OpenClaw sandbox. |

Follow [OpenShift setup](../../../docs/build-deploy/kubernetes.md#deploying-to-openshift) and the [shared YAML run procedure](../../README.md#prepare-and-run-a-yaml-example).
Replace each file's illustrative values and deployment UID before plan/apply.
Use explicit agent requests to verify replies, then check unchanged apply and retained teardown.
The external gateway remains under its operator's ownership.

These files receive schema, round-trip, and compiler checks.
Fixture integration scenarios exercise selected OpenShift configurations; they do not deploy these files to a live cluster.
No new live OpenShift evidence is claimed.
