# Hindsight CLI Reference

Command-line reference for Hindsight memory operations in the sandbox.

## Installation

```bash
# Inside the sandbox
pip install hindsight
# or
npm install -g hindsight
```

## Commands

### recall

Query past context from memory.

```bash
hindsight recall --query "<search term>" [flags]
```

**Flags:**
- `--query, -q` (string): Search query (required)
- `--limit, -l` (int): Number of results (default: 5)
- `--bank` (string): Specific memory bank to search
- `--format` (string): Output format (json, text)

**Example:**
```bash
hindsight recall --query "authentication bug" --limit 3
hindsight recall -q "preferences" --bank user-profile
```

### retain

Store new learnings in memory.

```bash
hindsight retain --content "<text>" [flags]
```

**Flags:**
- `--content, -c` (string): Content to store (required)
- `--tags, -t` (string): Comma-separated tags
- `--bank` (string): Target memory bank (default: default)
- `--metadata` (string): JSON metadata

**Example:**
```bash
hindsight retain --content "Fixed bug by updating auth middleware" --tags bugfix,auth
hindsight retain -c "User prefers dark mode" -t preferences
```

### reflect

Synthesize answers from multiple memories.

```bash
hindsight reflect --question "<question>" [flags]
```

**Flags:**
- `--question, -q` (string): Question to reflect on (required)
- `--bank` (string): Memory bank to query

**Example:**
```bash
hindsight reflect --question "What bugs has the user reported recently?"
```

### banks

Manage memory banks.

```bash
hindsight banks <subcommand> [flags]
```

**Subcommands:**
- `list` — List all memory banks
- `create <name>` — Create a new bank
- `delete <name>` — Delete a bank
- `info <name>` — Show bank details

**Example:**
```bash
hindsight banks list
hindsight banks create user-profile
hindsight banks info session-notes
```

### observations

Manage synthesized observations.

```bash
hindsight observations <subcommand> [flags]
```

**Subcommands:**
- `list` — List observations
- `clear` — Clear all observations

**Example:**
```bash
hindsight observations list
```

### mental-models

Manage mental models (curated summaries).

```bash
hindsight mental-models <subcommand> [flags]
```

**Subcommands:**
- `list` — List mental models
- `create <name>` — Create a mental model
- `get <name>` — Get mental model content

**Example:**
```bash
hindsight mental-models list
hindsight mental-models create user-preferences --content "User preferences summary"
```

### health

Check Hindsight server health.

```bash
hindsight health
```

### version

Show Hindsight version.

```bash
hindsight version
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HINDSIGHT_URL` | Server URL | `http://localhost:8080` |
| `HINDSIGHT_API_KEY` | API key for auth | None |
| `HINDSIGHT_BANK` | Default bank | `default` |

## Exit Codes

- `0` — Success
- `1` — Error (invalid args, server unreachable, etc.)
- `2` — Usage error

## Output Formats

Most commands support `--format json` for programmatic output:

```bash
hindsight recall --query "auth" --format json | jq '.memories[].content'
```