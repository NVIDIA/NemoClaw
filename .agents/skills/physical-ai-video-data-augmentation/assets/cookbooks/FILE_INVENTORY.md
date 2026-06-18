# Shared Cookbook Layout

Every cookbook scene directory follows the same file layout. This shared reference
documents the common roles so individual scene READMEs only need to call out their
scene-specific values (variables, event-type count, question-bank size).

| File | Role |
|------|------|
| `README.md` | Scene overview, tuning notes, and the link back to this layout reference |
| `workflow_config.yaml` | `--config` entry point; defines augmentation variables and weights |
| `augmentation/augmentation.yaml` | Full augmentation pipeline config (captioning, template generation, cosmos, verification) |
| `augmentation/prompts/template_generation_system_prompt.md` | LLM prompt for extracting the scene's augmentation-variable words from captions |
| `augmentation/prompts/prompt_polishing_system_prompt.md` | LLM prompt for polishing raw augmentation prompts for photorealism |
| `auto_labeling/auto_labeling_config.yaml` | Auto-labeling pipeline config (detection, tracking, VLM event analysis, MCQ) |
| `auto_labeling/prompts/event_analysis.md` | VLM prompt for two-JSON event annotation |
| `auto_labeling/question_bank.json` | MCQ question bank for the scene |

Scene-specific deltas (augmentation variables, number of event types, question count)
are documented inline in each scene `README.md`.
