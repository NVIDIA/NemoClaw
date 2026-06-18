# Common Calibration Steps

Shared snippets used by all three input-mode references (videos, RTSP,
sample-dataset). Each mode reference points here for the common create_project,
upload_videos, and handoff steps to avoid duplication.

## Create project

```
POST /v1/create_project
Content-Type: application/x-www-form-urlencoded

project_name=<your_project_name>
```

Save the returned `project_id` — every subsequent endpoint takes it.

Python equivalent:

```python
r = s.post(f"{BASE_URL}/create_project", data={"project_name": PROJECT_NAME})
r.raise_for_status()
project_id = r.json()["project_id"]
```

## Upload videos

Videos must be named `cam_00.mp4`, `cam_01.mp4`, … contiguous, no gaps.

```
POST /v1/upload_video_files/<project_id>
Content-Type: multipart/form-data

files=@cam_00.mp4
files=@cam_01.mp4
...
```

For the sample-dataset mode the bundled zip already contains the cameras in
the correct order; the mode reference just feeds them into this endpoint.

## Hand off to the shared calibration tail

Once the mode-specific reference has uploaded videos, alignment, and layout
(plus any optional GT zip / focal lengths), continue with the **Shared
Calibration Tail** — see [SKILL.md Step A onward](../SKILL.md#step-a--verify-project)
for the REST flow and [`calibration-tail.md`](calibration-tail.md) for the
shared Python snippet (verify → calibrate → poll → results).
