---
name: hindsight-memory
description: Teach sandboxed agents how to use Hindsight for persistent memory across ephemeral sandbox sessions. Trigger keywords - add memory, persistent memory, remember, recall, hindsight, retain context, memory skill.
---

# Hindsight Memory Skill

This skill teaches sandboxed OpenClaw agents how to use [Hindsight](https://github.com/vectorize-io/hindsight) for persistent memory across ephemeral sandbox sessions.

## Why This Matters

Sandboxes are isolated and disposable. When a sandbox is destroyed, everything the agent learned is lost. Hindsight solves this by providing a structured memory API that agents can call from inside the sandbox to recall past context and store new learnings.

## Prerequisites

- Hindsight server running (either locally via `hindsight-embed` or externally)
- Network policy allows egress to Hindsight endpoint
- `HINDSIGHT_URL` environment variable set in the sandbox

## Workflows

### 1. Recall Before Work

Before starting any task, query past context to understand what has already been discussed or learned:

```bash
hindsight recall --query "<task description or topic>"
```

Example: If the user asks to "fix the authentication bug", first recall what previous work has been done on authentication.

### 2. Retain After Work

After completing work, immediately store learnings. Sandboxes can be destroyed anytime:

```bash
hindsight retain --content "<what was learned>" --tags "<relevant tags>"
```

Example: After fixing a bug, retain the root cause and solution approach.

### 3. Reflect for Synthesis

Get synthesized answers from multiple memories:

```bash
hindsight reflect --question "<question about past context>"
```

### 4. Bulk File Ingestion

Retain logs, reports, and investigation notes:

```bash
hindsight retain --file /path/to/file.txt --tags "logs,investigation"
```

### 5. Cross-Sandbox Continuity

Pick up where previous sessions left off. The agent should always:
1. On session start, recall the user's preferences and ongoing projects
2. On session end, retain any new learnings

## NemoClaw Integration

### Setup

1. Add Hindsight to network policy (see `example-policy.yaml`)
2. During onboard or migrate, ensure `HINDSIGHT_URL` is set
3. Optionally set `HINDSIGHT_API_KEY` if using external Hindsight service

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `HINDSIGHT_URL` | Hindsight server URL (e.g., `http://hindsight:8080`) | Yes |
| `HINDSIGHT_API_KEY` | API key for external Hindsight service | No |

### Commands in NemoClaw

Inside the sandbox, use the Hindsight CLI directly:

```bash
# Recall past context
hindsight recall --query "authentication"

# Retain a learning
hindsight retain --content "User prefers dark mode UI" --tags preferences

# Reflect on multiple memories
hindsight reflect --question "What bugs has the user reported?"

# List memory banks
hindsight banks list
```

## Memory Bank Strategy

For OpenClaw agents, consider these memory banks:

- **user-profile**: User preferences, communication style, project context
- **session-notes**: Ongoing work, pending tasks, recent discoveries
- **knowledge-base**: Technical learnings, bug resolutions, architectural decisions

## Best Practices

1. **Recall early** — Query memory at the start of each user interaction
2. **Retain often** — Store learnings immediately after any significant work
3. **Use tags** — Organize memories with consistent tags for better recall
4. **Reflect before major decisions** — Synthesize past context before suggesting changes
5. **Retention triggers** — Retain after: bug fixes, architecture decisions, user preferences expressed, configuration changes

## Example Scenarios

### Scenario: User Asks About Previous Work

```
User: Can you help me with the API?
Agent: [calls hindsight recall --query "API development"]
Agent: I see you worked on the REST API last week. You added rate limiting and fixed the authentication endpoint. Would you like me to continue from there?
```

### Scenario: Learning User Preference

```
User: I prefer using TypeScript over JavaScript
Agent: [calls hindsight retain --content "User prefers TypeScript over JavaScript" --tags preferences,typescript]
Agent: Got it! I'll keep that in mind for any code recommendations.
```

### Scenario: Cross-Session Continuity

```
User: Continue where we left off yesterday
Agent: [calls hindsight recall --query "unfinished work"]
Agent: Yesterday we were working on the database migration. You had migrated 3 of 5 tables. Shall I continue with table 4?
```