# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# With gateway.kubernetes.expose.route on OpenShift, the chart's Route
# publishes the endpoint's host and passes TLS through to the gateway's TLS
# listener, so the router never sees plaintext or the client certificate. The
# Route carries the authored annotations, the chart's Service stays in the
# cluster, and the server certificate names the endpoint's host.

run "routed" {
  command = plan

  variables {
    values = ["inputs/routed.json"]
  }

  assert {
    condition = length([
      for object in output.objects : object
      if object.kind == "Route" && object.metadata.name == output.release
      && object.spec.host == "gateway.apps.example.com"
      && object.spec.tls.termination == "passthrough"
      && object.spec.to.kind == "Service" && object.spec.to.name == output.release
      && object.spec.port.targetPort == "grpc"
    ]) == 1
    error_message = "One Route must pass the endpoint's host through to the gateway's grpc port."
  }

  assert {
    condition = alltrue([
      for object in output.objects : object.metadata.annotations["haproxy.router.openshift.io/timeout"] == "1h"
      if object.kind == "Route"
    ])
    error_message = "The Route must carry the authored annotations."
  }

  assert {
    condition = alltrue([
      for object in output.objects : !contains(["NodePort", "LoadBalancer"], try(object.spec.type, "ClusterIP"))
      if object.kind == "Service"
    ])
    error_message = "The chart's Services must stay in the cluster."
  }

  assert {
    condition     = strcontains(output.manifest, "--server-san=gateway.apps.example.com")
    error_message = "The server certificate must name the endpoint's host."
  }
}
