<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configuration Diagnostics

A configuration that NemoClaw cannot read fails with one message.
The message names the reason and its source position, and never repeats a value from the document, because a value can be a credential.
Every example below uses `PRIVATE_SENTINEL` where a secret could appear; no message contains it.

## YAML Syntax

Reading this configuration:

```yaml
metadata:
  name: PRIVATE_SENTINEL
   uid: invalid
```

fails with:

```text
invalid YAML syntax at line 3, column 7
```

---

Reading this configuration:

```yaml
metadata:
  name: PRIVATE_SENTINEL
  name: repeated
```

fails with:

```text
duplicate mapping key at line 3, column 3
```

---

Reading this configuration:

```yaml
---
metadata: {}
---
metadata: {}
```

fails with:

```text
multiple YAML documents are not allowed at line 3, column 1
```

## Empty Input

Input without a value is an empty document, which differs from a value of the wrong type.
Each input, written as a JSON string, fails with its message:

| input                | message                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| ""                   | empty document; provide a NemoClaw configuration                                |
| " \n"                | empty document; provide a NemoClaw configuration                                |
| "# only a comment\n" | empty document; provide a NemoClaw configuration                                |
| "---\n"              | empty document; provide a NemoClaw configuration                                |
| "[]"                 | configuration violates schema at document root (line 1, column 1): must be object |

## Explicit Tags

An explicit YAML tag can change how a value is read, so a configuration must not contain one.
Replacing each original in `examples/fabric-openclaw.yaml` with its replacement fails with the message:

| original              | replacement                                  | message                                                   |
| --------------------- | -------------------------------------------- | --------------------------------------------------------- |
| name: fabric-openclaw | name: !!binary ZXhwbG9yZS10MTA=              | explicit YAML tags are not allowed at line 8, column 9    |
| name: fabric-openclaw | name: !!str explore-t10                      | explicit YAML tags are not allowed at line 8, column 9    |
| name: fabric-openclaw | name: !<tag:yaml.org,2002:str> explore-t10   | explicit YAML tags are not allowed at line 8, column 9    |
| metadata:             | metadata: !!map                              | explicit YAML tags are not allowed at line 7, column 11   |
| sandboxes:            | sandboxes: !!seq                             | explicit YAML tags are not allowed at line 20, column 14  |

Tag text inside a string is a value, not a tag.
Reading this configuration:

```yaml
apiVersion: nemoclaw.nvidia.com/v1alpha1
kind: NemoClawConfig
metadata:
  name: literal-tags
  uid: c892587f-6439-44b5-9a70-a43e8936461f
spec:
  gateway:
    management: external
    runtime:
      provider: docker
    endpoint: http://127.0.0.1:17681
  inferenceProviders:
    - name: local
      provider: openai
      endpoint: http://172.20.0.1:11446/v1
  sandboxes:
    - name: assistant
      harness:
        kind: nvidia.fabric.openclaw
        settings:
          quoted: "!!binary literal text"
          block: |
            !!binary literal text
            !custom still text
      agent:
        name: main
        inference:
          routes:
            - name: primary
              providerRef: local
              overrides:
                model: qwen3:4b
```

keeps these harness settings:

```json
{
  "block": "!!binary literal text\n!custom still text\n",
  "quoted": "!!binary literal text"
}
```

## Schema Violations

A schema violation names the field path, with array indices, and the constraint it breaks.
Reading this configuration:

```yaml
apiVersion: nemoclaw.nvidia.com/v1alpha1
kind: NemoClawConfig
metadata:
  name: two-sandboxes
  uid: c892587f-6439-44b5-9a70-a43e8936461f
spec:
  gateway:
    management: external
    runtime:
      provider: docker
    endpoint: http://127.0.0.1:17681
  inferenceProviders:
    - name: local
      provider: openai
      endpoint: http://172.20.0.1:11446/v1
  sandboxes:
    - name: first
      harness:
        kind: nvidia.fabric.openclaw
      agent:
        name: main
        inference:
          routes:
            - name: primary
              providerRef: local
              overrides:
                model: qwen3:4b
    - name: second
      harness:
        kind: nvidia.fabric.openclaw
      agent:
        name: main
        inference:
          routes: PRIVATE_SENTINEL
```

fails with:

```text
configuration violates schema at spec.sandboxes[1].agent.inference.routes (line 34, column 19): must be array
```

---

Starting from `examples/spark/spark-inline.yaml`, changing `kvCacheGiB: 8` to `kvCacheGiB: 2` fails with:

```text
configuration violates schema at spec.services.qwen.memory.kvCacheGiB (line 37, column 21): must be 0 or between 4 and 12
```

---

A column counts characters, not bytes.
In this single-line document, `é` is two bytes but one column, so the column is 352 rather than 353.
Reading this configuration:

```json
{"apiVersion":"nemoclaw.nvidia.com/v1alpha1","kind":"NemoClawConfig","metadata":{"name":"flow","uid":"c892587f-6439-44b5-9a70-a43e8936461f"},"spec":{"gateway":{"management":"external","runtime":{"provider":"docker"},"endpoint":"http://é.example.com"},"sandboxes":[{"name":"a","harness":{"kind":"nvidia.fabric.openclaw"},"agent":{"inference":{"routes":"PRIVATE_SENTINEL"}}}]}}
```

fails with:

```text
configuration violates schema at spec.sandboxes[0].agent.inference.routes (line 1, column 352): must be array
```
