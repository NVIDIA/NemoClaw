<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Examples by Capability

Capabilities can be demonstrated in a basic configuration, a combined travel example, or a platform deployment. These links lead to the canonical files; requirements remain specific to each example.

Use the linked configuration's family README and the [shared run procedure](../README.md#prepare-and-run-a-yaml-example). Inclusion records what a file configures, not live qualification or compatibility with other combinations.

## Agent Authentication

- [hermes-auth.yaml](../features/hermes-auth.yaml)

## Autoscaling Integration

- [platforms/kubernetes/gpu-autoscaling/README.md](../platforms/kubernetes/gpu-autoscaling/README.md)

## Gateway Authentication and Publication

- [managed-oidc.yaml](../platforms/kubernetes/managed-oidc.yaml)
- [published-nodeport.yaml](../platforms/kubernetes/published-nodeport.yaml)
- [published-route.yaml](../platforms/openshift/published-route.yaml)

## Inference Routing

- [inference-tuning.yaml](../features/inference-tuning.yaml)
- [inline-inference.yaml](../features/inline-inference.yaml)
- [multiple-models.yaml](../features/multiple-models.yaml)
- [multiple-providers.yaml](../features/multiple-providers.yaml)

## Policies and Multiple Sandboxes

- [explicit-policy.yaml](../features/explicit-policy.yaml)
- [multiple-sandboxes.yaml](../features/multiple-sandboxes.yaml)
- [shared-model.yaml](../platforms/docker/vllm/dgx-spark/shared-model.yaml)
- [shared-model.yaml](../platforms/docker/vllm/dgx-station/shared-model.yaml)

## Storage and Placement

- [hosted-nvidia.yaml](../platforms/kubernetes/hosted-inference/hosted-nvidia.yaml)
- [sandbox-placement.yaml](../platforms/kubernetes/sandbox-placement.yaml)

## Tools and Applications

- [application-container.yaml](../features/application-container.yaml)
- [web-search.yaml](../features/web-search.yaml)

## Travel Configurations

- [features/travel-team/README.md](../features/travel-team/README.md)
- [features/travel/README.md](../features/travel/README.md)
