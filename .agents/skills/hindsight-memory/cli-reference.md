<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hindsight CLI Reference

## Installation

```console
$ curl -fsSL https://hindsight.vectorize.io/get-cli | bash
```

## Configuration

```console
# Interactive configuration
$ hindsight configure

# Or set directly
$ hindsight configure --api-url https://api.hindsight.vectorize.io

# Or use environment variables (highest priority)
$ export HINDSIGHT_API_URL=https://api.hindsight.vectorize.io
$ export HINDSIGHT_API_KEY=hs-your-api-key
```

Config file location: `~/.hindsight/config`

## Memory Commands

### retain — Store a Memory

```console
$ hindsight memory retain <bank_id> "<text>"
$ hindsight memory retain <bank_id> "<text>" --context "<description>"
$ hindsight memory retain <bank_id> "<text>" --async
```

| Flag | Description |
|------|-------------|
| `--context <text>` | Freeform context describing the memory (e.g., "learnings from debugging auth") |
| `--async` | Queue for background processing instead of waiting |

### retain-files — Bulk Import from Files

```console
$ hindsight memory retain-files <bank_id> <file_or_directory>
$ hindsight memory retain-files <bank_id> <path> --context "<description>"
$ hindsight memory retain-files <bank_id> <path> --async
```

| Flag | Description |
|------|-------------|
| `--context <text>` | Freeform context applied to all retained content |
| `--async` | Queue for background processing |

Directories are processed recursively by default.

### recall — Search Memories

```console
$ hindsight memory recall <bank_id> "<query>"
$ hindsight memory recall <bank_id> "<query>" --budget high
$ hindsight memory recall <bank_id> "<query>" --max-tokens 8192
$ hindsight memory recall <bank_id> "<query>" --fact-type world,experience
$ hindsight memory recall <bank_id> "<query>" --trace
```

| Flag | Description |
|------|-------------|
| `--budget <level>` | Search thoroughness: low, mid, high (default: mid) |
| `--max-tokens <n>` | Maximum tokens in response (default: 4096) |
| `--fact-type <types>` | Comma-separated: world, experience, opinion (default: all three) |
| `--trace` | Show trace information for debugging |
| `--include-chunks` | Include source chunks in results |
| `--chunk-max-tokens <n>` | Maximum tokens for chunks (default: 8192, requires --include-chunks) |

### reflect — Synthesized Response

```console
$ hindsight memory reflect <bank_id> "<question>"
$ hindsight memory reflect <bank_id> "<question>" --context "<additional context>"
$ hindsight memory reflect <bank_id> "<question>" --budget high
```

| Flag | Description |
|------|-------------|
| `--context <text>` | Additional context for the reflection |
| `--budget <level>` | Search thoroughness: low, mid, high (default: mid) |
| `--max-tokens <n>` | Maximum tokens for the response |
| `--schema <path>` | Path to JSON schema file for structured output |

## Bank Management

```console
$ hindsight bank list                           # List all banks
$ hindsight bank stats <bank_id>                # View bank statistics
$ hindsight bank disposition <bank_id>          # View personality traits
$ hindsight bank name <bank_id> "<name>"        # Set bank display name
$ hindsight bank mission <bank_id> "<text>"     # Set bank mission statement
```

## Document Management

```console
$ hindsight document list <bank_id>                       # List documents
$ hindsight document get <bank_id> <document_id>          # Get document details
$ hindsight document delete <bank_id> <document_id>       # Delete document and memories
```

## Entity Management

```console
$ hindsight entity list <bank_id>                              # List entities
$ hindsight entity get <bank_id> <entity_id>                   # Get entity details
$ hindsight entity regenerate <bank_id> <entity_id>            # Regenerate observations
```

## Output Formats

```console
$ hindsight memory recall <bank_id> "query"              # Pretty (default)
$ hindsight memory recall <bank_id> "query" -o json      # JSON
$ hindsight memory recall <bank_id> "query" -o yaml      # YAML
```

## Global Flags

| Flag | Description |
|------|-------------|
| `-v, --verbose` | Show detailed output including request/response |
| `-o, --output <format>` | Output format: pretty, json, yaml |
| `--help` | Show help |
| `--version` | Show version |

## API Endpoints

The Hindsight API exposes these endpoints (relevant for network policy authoring):

| Method | Path | Operation |
|--------|------|-----------|
| POST | `/v1/default/banks/{bank_id}/memories` | Retain memories |
| POST | `/v1/default/banks/{bank_id}/files/retain` | Retain files |
| POST | `/v1/default/banks/{bank_id}/memories/recall` | Recall memories |
| POST | `/v1/default/banks/{bank_id}/reflect` | Reflect on memories |
| GET | `/v1/default/banks` | List banks |
| GET | `/v1/default/banks/{bank_id}/stats` | Bank statistics |
| GET | `/v1/default/banks/{bank_id}/entities` | List entities |
| GET | `/v1/default/banks/{bank_id}/memories/list` | List memories |
| GET | `/v1/default/banks/{bank_id}/documents` | List documents |
