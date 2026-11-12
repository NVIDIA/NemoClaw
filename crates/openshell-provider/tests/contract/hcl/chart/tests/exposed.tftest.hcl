# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# With gateway.kubernetes.expose, the chart's own gateway Service publishes
# the endpoint's port on every node and forwards it to the gateway's TLS
# listener. The plaintext metrics port is neither published nor served, and
# the server certificate names the endpoint's host.

run "exposed" {
  command = plan

  variables {
    values = ["inputs/exposed.json"]
  }

  assert {
    condition = length([
      for object in output.objects : object
      if object.kind == "Service" && object.metadata.name == output.release
      && object.spec.type == "NodePort"
      && jsonencode([for port in object.spec.ports : [port.name, port.nodePort, port.targetPort]]) == jsonencode([["grpc", 30851, "grpc"]])
    ]) == 1
    error_message = "The release's Service must publish only the gateway's grpc port, at node port 30851."
  }

  assert {
    condition     = !can(regex("metrics_bind_address", output.configuration))
    error_message = "The gateway must not serve its plaintext metrics."
  }

  assert {
    condition     = strcontains(output.manifest, "--server-san=gateway.agents.example.com")
    error_message = "The server certificate must name the endpoint's host."
  }
}
