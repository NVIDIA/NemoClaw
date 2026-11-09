# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# A stub OpenAI-compatible model for a Docker case, run with the bundled
# Docker provider on the case's engine before its first apply: the pinned
# nginx-unprivileged image the development issuer runs, on the host network
# at the port the case's `model` provider names. It lists one model and
# answers every chat completion with `reply`, streamed when the request asks,
# and refuses any request without `Authorization: Bearer KEY`. The test
# runner removes it after the case.

terraform {
  required_version = "= 1.12.12"
  required_providers {
    docker = {
      source = "kreuzwerker/docker"
    }
  }
}

variable "context" {
  type = object({
    config   = string
    versions = string
  })
}

variable "key" {
  description = "The key the case's provider sends, which the stub requires."
  type        = string
  sensitive   = true
}

variable "reply" {
  description = "The text of every completion."
  type        = string
}

locals {
  document = yamldecode(file(var.context.config))
  port     = tonumber(regex(":([0-9]+)/v1$", local.document.spec.inferenceProviders.model.endpoint)[0])
  image    = jsondecode(file(var.context.versions)).images.developmentIssuer
  # Responses, as nginx returns them: it expands the escaped line breaks in
  # single-quoted text.
  models = jsonencode({ object = "list", data = [{ id = "fixture-model", object = "model" }] })
  completion = jsonencode({
    id      = "chatcmpl-nemoclaw-stub"
    object  = "chat.completion"
    created = 0
    model   = "fixture-model"
    choices = [{ index = 0, message = { role = "assistant", content = var.reply }, finish_reason = "stop" }]
    usage   = { prompt_tokens = 1, completion_tokens = 1, total_tokens = 2 }
  })
  chunks = [
    { delta = { role = "assistant", content = var.reply }, finish = null, usage = null },
    { delta = {}, finish = "stop", usage = { prompt_tokens = 1, completion_tokens = 1, total_tokens = 2 } },
  ]
  stream = join("", concat([
    for chunk in local.chunks : "data: ${jsonencode(merge({
      id      = "chatcmpl-nemoclaw-stub"
      object  = "chat.completion.chunk"
      created = 0
      model   = "fixture-model"
      choices = [{ index = 0, delta = chunk.delta, finish_reason = chunk.finish }]
    }, chunk.usage == null ? {} : { usage = chunk.usage }))}\\n\\n"
  ], ["data: [DONE]\\n\\n"]))
  # The request body selects a streamed reply. nginx reads the body before it
  # sends the proxied request, so the second server sees the choice as a header.
  config = <<-EOT
    worker_processes 1;
    pid /tmp/nginx.pid;
    error_log /dev/stderr warn;
    events { worker_connections 1024; }
    http {
        access_log /dev/stdout;
        client_body_temp_path /tmp/client_temp;
        proxy_temp_path /tmp/proxy_temp;
        fastcgi_temp_path /tmp/fastcgi_temp;
        uwsgi_temp_path /tmp/uwsgi_temp;
        scgi_temp_path /tmp/scgi_temp;
        map $request_body $reply_kind {
            "~\"stream\"\s*:\s*true" stream;
            default plain;
        }
        server {
            listen ${local.port};
            if ($http_authorization != "Bearer ${var.key}") { return 401; }
            location = /v1/models {
                default_type application/json;
                return 200 '${local.models}';
            }
            location = /v1/chat/completions {
                client_body_buffer_size 1m;
                client_body_in_single_buffer on;
                proxy_set_header X-Reply-Kind $reply_kind;
                proxy_pass http://unix:/tmp/stub.sock:/completion;
            }
            location / { return 404; }
        }
        server {
            listen unix:/tmp/stub.sock;
            location = /completion {
                if ($http_x_reply_kind = stream) { rewrite ^ /stream last; }
                default_type application/json;
                return 200 '${local.completion}';
            }
            location = /stream {
                default_type text/event-stream;
                return 200 '${local.stream}';
            }
        }
    }
  EOT
}

provider "docker" {
  host = local.document.spec.gateway.engine
}

resource "docker_image" "model" {
  name         = local.image
  keep_locally = true
}

resource "docker_container" "model" {
  name         = "nc-hcl-model-${substr(sha256(local.document.metadata.uid), 0, 12)}"
  image        = docker_image.model.image_id
  network_mode = "host"
  must_run     = true
  command      = ["nginx", "-c", "/tmp/stub.conf", "-g", "daemon off;"]
  upload {
    content = local.config
    file    = "/tmp/stub.conf"
  }
  # live-docker removes anything left with the deployment's UID label.
  labels {
    label = "nemoclaw.nvidia.com/uid"
    value = local.document.metadata.uid
  }
}
