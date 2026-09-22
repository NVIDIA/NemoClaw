# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import subprocess
import threading
import unittest
from unittest.mock import patch

import image_fixtures


class FixtureScheduling(unittest.TestCase):
    def test_independent_fixtures_overlap_with_bounded_concurrency(self):
        barrier = threading.Barrier(2, timeout=5)
        lock = threading.Lock()
        active = 0
        peak = 0
        completed = []

        def execute(command, **kwargs):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            barrier.wait()
            with lock:
                completed.append(command)
                active -= 1
            return subprocess.CompletedProcess(command, 0, "passed")

        jobs = [[str(n)] for n in range(6)]
        with patch.object(image_fixtures.subprocess, "run", side_effect=execute):
            self.assertEqual(image_fixtures.run(jobs, workers=2), 0)
        self.assertEqual(peak, 2)
        self.assertCountEqual(completed, jobs)

    def test_a_failed_fixture_fails_the_job_after_all_results_are_collected(self):
        completed = []

        def execute(command, **kwargs):
            completed.append(command)
            return subprocess.CompletedProcess(command, int(command[0]), "result")

        jobs = [["0"], ["1"], ["0"]]
        with patch.object(image_fixtures.subprocess, "run", side_effect=execute):
            self.assertEqual(image_fixtures.run(jobs, workers=2), 1)
        self.assertCountEqual(completed, jobs)


if __name__ == "__main__":
    unittest.main()
