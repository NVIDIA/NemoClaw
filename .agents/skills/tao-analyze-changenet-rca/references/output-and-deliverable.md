# Output Location and Deliverable Layout

Always save into a timestamped folder:
```
<experiment_result_dir>/rca_results/YYYY-MM-DD_HHMMSS/
├── RCA_Report.md          # The full report
├── rca_images/            # All thumbnails embedded in the report
├── rca_config/            # Auto-copied by hook: skill, commands, hooks, settings
│   ├── skills/
│   ├── commands/
│   ├── hooks/
│   └── settings.local.json
└── claude_session.jsonl   # Auto-copied by hook: conversation log
```

1. At the start of the investigation, get the real current timestamp by running `date +%Y-%m-%d_%H%M%S` in Bash, then create the output folder: `<experiment_dir>/rca_results/<timestamp>/`. Do NOT hardcode or guess the time — always use the shell command.
2. Write `rca_images/` thumbnails into that folder
3. Write `RCA_Report.md` into that folder (this triggers the packaging hook to copy config + logs)

If the user specifies a custom path, use that instead but maintain the same structure.
