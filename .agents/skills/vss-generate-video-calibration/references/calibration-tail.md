## Shared Calibration Tail (Python)

The verify → calibrate → poll → results sequence is identical across all
three input modes (videos, RTSP, sample-dataset). The mode-specific
references stop after their last upload step and reference this snippet.

Assumes `s`, `BASE_URL`, `project_id`, and `DETECTOR_TYPE` are already
bound from the preceding mode-specific Python.

```python
import os
import time
from urllib.parse import urlparse

# Verify the project before calibration
s.post(f"{BASE_URL}/verify_project/{project_id}").raise_for_status()

# Step B — Start calibration (detector_type is a /calibrate argument; not consumed by /v1/config)
s.post(f"{BASE_URL}/calibrate/{project_id}",
       json={"detector_type": DETECTOR_TYPE}).raise_for_status()

# Surface where to watch progress before the long poll begins.
_host = urlparse(BASE_URL).hostname or "<HOST_IP>"
_ui_port = os.environ.get("VSS_AUTO_CALIBRATION_UI_PORT", "5000")
_root = BASE_URL.rsplit("/v1", 1)[0]
print("[B] Calibration started")
print(f"    Project:  {project_id}")
print(f"    Detector: {DETECTOR_TYPE}")
print(f"    UI:       http://{_host}:{_ui_port}")
print(f"    Logs:     GET {BASE_URL}/amc/calibrate/{project_id}/log   (Swagger UI: {_root}/docs)")

# Step C — Poll until COMPLETED (10–60 min typical). Poll every 10s, and print a
# heartbeat at least once a minute so a long RUNNING state still shows progress.
start, last_state, last_beat = time.time(), "", 0.0
while time.time() - start < 5400:
    info = s.get(f"{BASE_URL}/get_project_info/{project_id}").json()
    st = info["project_info"]["project_state"]
    mins, secs = divmod(int(time.time() - start), 60)
    if st != last_state or time.time() - last_beat >= 60:
        print(f"    [{mins:>3}m {secs:02d}s] {st}", flush=True)
        last_state, last_beat = st, time.time()
    if st == "COMPLETED":
        print(f"[C] Completed in {mins}m {secs:02d}s"); break
    if st == "ERROR":
        # Surface the tail of the calibration log so the failure is actionable.
        try:
            log_lines = s.get(f"{BASE_URL}/amc/calibrate/{project_id}/log").text.splitlines()
            print("    --- last calibration log lines ---")
            for line in log_lines[-20:]:
                print(f"    {line}")
        except Exception:
            pass
        raise RuntimeError(f"Calibration ERROR — full log: GET {BASE_URL}/amc/calibrate/{project_id}/log")
    time.sleep(10)
else:
    raise RuntimeError(
        f"Calibration still running after {int((time.time() - start) // 60)} min — "
        f"inspect GET {BASE_URL}/amc/calibrate/{project_id}/log or the UI at http://{_host}:{_ui_port}"
    )

# Step D — Results + review
print("\n=== Calibration complete ===")
print(f"Project:  {project_id}")
print(f"Detector: {DETECTOR_TYPE}")

# Evaluation metrics are only produced when a ground-truth GT.zip was uploaded.
# A missing result here is normal (no GT) — it is not the end of result reporting.
r = s.get(f"{BASE_URL}/result/{project_id}/evaluation_statistics")
_stats = r.json().get("statistics") if r.status_code == 200 else None
if _stats:
    print("Evaluation metrics:")
    for k, v in _stats.items():
        print(f"    {k}: {v}")
else:
    print("Evaluation metrics: not available — upload a ground-truth GT.zip before calibrating to get L2 / reprojection metrics.")

# Always point to the visual overlay so the user can validate calibration quality.
_projects_dir = os.environ.get(
    "PROJECTS_DIR",
    f"{os.environ.get('VSS_APPS_DIR', '<VSS_APPS_DIR>')}/services/auto-calibration/projects",
)
_proj_path = f"{_projects_dir}/project_{project_id}"
print("\nReview the calibration:")
print(f"    UI:            http://{_host}:{_ui_port}  — open project {project_id}, then the Results page to view the overlay")
print(f"    Overlay image: {_proj_path}/output/multi_view_results/BA_output/results_ba_scaled_world/overlay_img_*.png")
print(f"    Project files: {_proj_path}")
```

See [SKILL.md Shared Calibration Tail](../SKILL.md#shared-calibration-tail) for
the REST equivalents and the meaning of each project state.
