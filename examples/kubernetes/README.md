<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Kubernetes Examples

Choose an example, copy it to your own deployment directory, and replace the values its header lists.
[Deploy to Kubernetes or OpenShift](../../docs/build-deploy/kubernetes.md) lists the cluster prerequisites and walks through plan, apply and destroy.

## Choose an Example

| File | Gateway | Agents and inference | What it shows |
|---|---|---|---|
| [managed-development.yaml](managed-development.yaml) | Managed, `development` profile | Three OpenClaw agents on hosted NVIDIA inference | The guide's starting point |
| [sandbox-placement.yaml](sandbox-placement.yaml) | Managed, `development` profile | One OpenClaw agent on hosted NVIDIA inference | A node selector, a toleration, CPU and memory requests and limits, and the StorageClass and size of the sandbox's claim |
| [published-nodeport.yaml](published-nodeport.yaml) | Managed, `oidc` profile | One OpenClaw agent on hosted NVIDIA inference | A gateway that a NodePort Service publishes, for the OpenShell CLI |
| [hosted-nvidia.yaml](hosted-nvidia.yaml) and [hosted-nvidia.tf](hosted-nvidia.tf) | Managed, `development` profile | OpenClaw and Hermes on hosted NVIDIA inference | Agent files on PVCs you create, in YAML and in HCL; [the GTC DC guide](../gtc-dc/README.md#amd64-kubernetes-with-nvidia-cloud-inference) prepares the claims |
| [in-cluster-vllm.yaml](in-cluster-vllm.yaml) | Managed, `development` profile | One OpenClaw agent on a vLLM server you run, with a key | [A model server in the cluster](../../docs/build-deploy/kubernetes.md#use-a-model-server-in-the-cluster) |
| [in-cluster-ollama.yaml](in-cluster-ollama.yaml) | Managed, `development` profile | One OpenClaw agent on an Ollama server you run, without a key | The same, for a server without a key |
| [external-gateway.yaml](external-gateway.yaml) | External | Three OpenClaw agents on an inference endpoint you name | [An existing gateway](../../docs/build-deploy/kubernetes.md#use-an-existing-gateway), reached with TLS and a bearer token |
| [gpu-autoscaling/](gpu-autoscaling/README.md) | Managed, `development` or `oidc` profile | OpenClaw and Hermes on GPU inference pods that Kubernetes scales | One sandbox per user on a shared, autoscaled model Service, with a load script |

[examples/openshift](../openshift) holds the OpenShift versions of `managed-development.yaml` and `external-gateway.yaml`.

## What Is Tested

Unit tests check every YAML file here against the schema and compile it.
Integration scenarios plan `hosted-nvidia.yaml` and `hosted-nvidia.tf`, and run `external-gateway.yaml` against a fake gateway.
No CI job deploys these files to a cluster: the live kind suite deploys its own documents in [crates/nemoclaw-e2e/cases](../../crates/nemoclaw-e2e/cases).
