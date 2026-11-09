# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# A compatible image reports its runtime binaries. A different platform, or a
# read policy that omits the runtime's paths, is unsupported, and a missing
# image is unknown. The engine fixture refuses any request but a read.

run "compatible" {
  command = plan
  assert {
    condition     = data.fabric_harnesses.agent.compatibility_status == "supported" && length(local.binaries) > 0
    error_message = "The image is compatible: ${data.fabric_harnesses.agent.observation_json}"
  }
}

run "another_architecture" {
  command = plan
  variables { architecture = "amd64" }
  assert {
    condition     = data.fabric_harnesses.agent.compatibility_status == "unsupported" && length(local.binaries) > 0
    error_message = "An image for another architecture is unsupported: ${data.fabric_harnesses.agent.observation_json}"
  }
}

run "reads_without_the_runtime" {
  command = plan
  variables { reads = ["/sandbox"] }
  assert {
    condition     = data.fabric_harnesses.agent.compatibility_status == "unsupported" && length(local.binaries) > 0
    error_message = "A read policy without the runtime's paths is unsupported: ${data.fabric_harnesses.agent.observation_json}"
  }
}

run "missing_image" {
  command = plan
  variables { image = "missing:image" }
  assert {
    condition     = data.fabric_harnesses.agent.compatibility_status == "unknown" && length(local.binaries) == 0
    error_message = "A missing image is unknown and reports no binaries: ${data.fabric_harnesses.agent.observation_json}"
  }
}
