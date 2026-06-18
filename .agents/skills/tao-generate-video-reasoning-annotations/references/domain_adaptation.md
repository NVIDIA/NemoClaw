# Video Reasoning Annotation — Domain Adaptation Guide

## Overview

The default prompts in `nvidia_tao_ds.auto_label.video_reasoning_annotation.prompts` work for general video content. For domain-specific datasets, customize the prompts via the template module to get significantly better caption accuracy, description quality, and QA relevance.

## Consultation Process

When a user needs domain-specific prompts, follow this structured consultation before writing any prompts. The goal is to understand **what the user wants their model to learn** so that prompts can be designed to capture the right information.

### Phase 1 — Understand the annotation goals

Ask the user: **"What types of questions do you want the trained model to be able to answer about these videos?"**

Walk through these general question categories. Not all will apply — help the user identify which matter for their use case:

- *Identification / What*: What is happening? What type of event? What objects, people, entities are involved?
- *Temporal / When*: When does the key event occur? What is the sequence? How does it evolve?
- *Causal / Why*: What caused this? What led up to it? What are the contributing factors?
- *Attribution / Who*: Who or what is responsible? Who initiated the action? What are the roles?
- *Consequence / Impact*: What are the results? What changes after the event? How severe?
- *Spatial / Where*: Where in the scene? What are the spatial relationships?
- *Behavioral / How*: How do actors behave before, during, and after?
- *Counterfactual / Prevention*: How could this have been prevented? What should have been done differently?
- *Classification / Category*: Is this normal or abnormal? What category?

Then ask: **"What are the most important elements you want captured in the annotations?"**

- What are the **key actors or entities** the model needs to track? (people, vehicles, equipment, etc.)
- What **identifying details** matter? (clothing, color, size, position, labels, etc.)
- What **actions or interactions** are most important?
- Are there **domain-specific details** a general caption would miss? (e.g., traffic signal states, safety equipment usage, specific maneuvers)
- How important are **bystander/environmental reactions**?

### Phase 2 — Infer caption requirements

Based on the user's answers, infer what the captions MUST capture for the QA to be answerable. Present as a two-tier checklist:

> **Must capture (directly needed for the questions):**
> - [ ] [Items derived from the user's question types]
>
> **Should capture (provides context for reasoning):**
> - [ ] [Supporting context — scene environment, timestamps, pre/post-event state, etc.]

For each question type the user selected, ask: "What would a captioner need to observe and write down for this question to be answerable from the caption alone?" Those become the "Must capture" items.

**Wait for user confirmation.** This checklist drives all prompt design.

### Phase 3 — Write prompts

Only after confirmation, fill in the `prompt_template.py` placeholders. The caption prompts should explicitly instruct the VLM to observe and report on each item in the confirmed checklist. The QA prompts should generate questions aligned with the user's stated question types.

**Coverage requirement for QA**: For every `qa_type` enabled in `workflow.qa_types` (default: `mcq`, `bcq`, `open_qa`, `causal_linkage`, `temporal_localization`, `temporal_event_desc`, `scene_description`, `event_summary`), `prompt_template.py` exposes a corresponding `[DOMAIN_<TYPE>_EXAMPLE_*]` group of placeholders (question / options / answer / reasoning) — and most types have both anomaly and normal variants. Fill these in for each type the user wants generated. If a `qa_type` is dropped from `workflow.qa_types`, its placeholders can be left untouched.

**Key principle**: Design is **top-down from questions to captions**, not bottom-up. Poor captions that miss critical information cannot be fixed by better QA prompts — the information simply won't be there.

## Placeholder Reference

The template module (`nvidia_tao_ds.auto_label.video_reasoning_annotation.prompt_template`) uses these placeholder patterns:

| Placeholder | What to fill in | Example (traffic) |
|-------------|----------------|-------------------|
| `[DOMAIN]` | Domain name | "traffic surveillance" |
| `[POSITIVE_CRITERION_N]` | What makes a video belong to this domain | "Fixed-angle view of road, intersection, or highway" |
| `[EXCLUSION_N]` | What is NOT this domain | "Dashcam or in-vehicle POV footage" |
| `[ANOMALY_DEFINITION]` | What counts as anomalous in this domain | "any event involving collision, near-miss, stalled vehicle, or traffic rule violation" |
| `[ANOMALY_EXAMPLE_N]` | Concrete anomaly examples | "Vehicle running a red light and colliding with cross-traffic" |
| `[NORMAL_EXAMPLE_N]` | Concrete normal examples | "Vehicles waiting at a red light and proceeding when green" |
| `[KEY_ASPECT_N]` | Caption focus areas (from checklist) | "Traffic Signal State", "Vehicle Movements", "The Collision" |
| `[DOMAIN_ACTOR_DETAILS]` | What to track about actors | "Vehicle Identification — color, type, lane position, direction" |
| `[DOMAIN_SPATIAL_CONTEXT]` | Spatial details to note | "Intersection Layout — lane markings, signal positions, crosswalks" |
| `[DOMAIN_ENVIRONMENTAL_FACTORS]` | Environmental conditions | "Lighting, weather, road surface condition, visibility" |
| `[DOMAIN_DYNAMICS]` | Micro-actions to describe in chunks | "Vehicle Dynamics — acceleration, braking, lane changes, turns" |
| `[DOMAIN_MCQ_EXAMPLE_*]` | Example QA for the domain | (see traffic/warehouse reference modules) |

This is a representative subset — open `prompt_template.py` for the complete placeholder list, including QA-example placeholders for every enabled `qa_type`.

## Iterative Prompt Tuning

After filling in placeholders:

1. Run the pipeline on 3-5 videos with the custom prompts
2. Inspect `step_1a_caption/captions.jsonl` — do captions capture the items in the "Must capture" checklist?
3. Inspect `step_2_description/descriptions.jsonl` — are descriptions accurate and complete?
4. Inspect `step_3_qa/qa_output.jsonl` — are QA pairs relevant to the user's stated question types?
5. Revise prompts and re-run until quality is satisfactory
6. Scale to full dataset

**Quality compounds downstream.** Caption quality is the most important — bad captions produce bad descriptions produce bad QA. Focus prompt iteration on Steps 1a/1b first.

## Reference Prompt Modules

Two complete domain-adapted prompt modules are provided as working examples. Each follows the same structure as the built-in prompts — a `PROMPT_TEMPLATES` dict with all 26 keys and a `get_prompt()` helper.

- **[prompts_traffic.py](prompts_traffic.py)** — Traffic CCTV (intersections, highways). Anomaly types: collisions, near-misses, stalled vehicles, red-light violations, illegal turns.

- **[prompts_warehouse.py](prompts_warehouse.py)** — Warehouse / industrial site CCTV. Anomaly subcategories: Safety-Liability, Operational Oversight, Criminal-Suspicious, Security Incidents.

**To use a reference module:**
1. Copy it into your project (e.g., `cp references/prompts_traffic.py my_package/prompts_traffic.py`)
2. Tune the prompts for your specific camera angles, layouts, and annotation goals
3. Set `prompts_module: "my_package.prompts_traffic"` in the YAML config

**To create a new domain module:**
1. Start from the template module (`nvidia_tao_ds.auto_label.video_reasoning_annotation.prompt_template`, placeholder-based) or from one of the reference modules
2. Use the consultation process above to determine what placeholders to fill in
3. Follow the same structure: `PROMPT_TEMPLATES` dict with all 26 keys + `get_prompt()` helper
