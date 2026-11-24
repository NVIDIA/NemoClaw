# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The gateway's data volume takes the target's StorageClass, or the cluster's
# default without one, and the gateway container takes the target's resources
# as written, or NemoClaw's sizing for 256 sandboxes without them.

run "defaults" {
  command = plan

  variables {
    values = ["inputs/kubernetes.json"]
  }

  assert {
    condition     = one([for object in output.objects : !can(object.spec.volumeClaimTemplates[0].spec.storageClassName) if object.kind == "StatefulSet"])
    error_message = "Without dataStorageClass, the gateway's data volume must use the cluster's default StorageClass."
  }

  assert {
    condition = jsonencode(one(flatten([
      for object in output.objects : [
        for container in object.spec.template.spec.containers : container.resources if container.name == "openshell-gateway"
      ] if object.kind == "StatefulSet"
      ]))) == jsonencode({
      requests = { cpu = "250m", memory = "256Mi" }
      limits   = { cpu = "1", memory = "2Gi" }
    })
    error_message = "Without resources, the gateway must keep requests of 250m and 256Mi and limits of 1 CPU and 2Gi."
  }
}

run "authored" {
  command = plan

  variables {
    values = ["inputs/sized.json"]
  }

  assert {
    condition     = one([for object in output.objects : try(object.spec.volumeClaimTemplates[0].spec.storageClassName, null) if object.kind == "StatefulSet"]) == "fast-local"
    error_message = "The gateway's data volume must claim the target's StorageClass."
  }

  # No CPU limit was written, so none is added.
  assert {
    condition = jsonencode(one(flatten([
      for object in output.objects : [
        for container in object.spec.template.spec.containers : container.resources if container.name == "openshell-gateway"
      ] if object.kind == "StatefulSet"
      ]))) == jsonencode({
      requests = { cpu = "500m", memory = "1Gi" }
      limits   = { memory = "4Gi" }
    })
    error_message = "The gateway container must take the target's resources as written."
  }
}
