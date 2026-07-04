// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { ISSUE_4462_WATCHER_QUIESCENCE_PY } from "../fixtures/issue-4462-watcher-quiescence.ts";

const BEHAVIOR_HARNESS_PY = String.raw`
import os
import shutil
import tempfile
from pathlib import Path


def write_process(proc_root, pid, start_identity, *, state='S', ppid=1, watcher_log=None):
    process_root = proc_root / str(pid)
    (process_root / 'fd').mkdir(parents=True)
    (process_root / 'cmdline').write_bytes(b'/usr/bin/python3\x00-u\x00-\x00')
    stat_fields = [state, str(ppid)] + (['0'] * 17) + [str(start_identity)]
    (process_root / 'stat').write_text(
        f'{pid} (python3) ' + ' '.join(stat_fields) + '\n',
        encoding='utf-8',
    )
    if watcher_log is not None:
        os.symlink(watcher_log, process_root / 'fd' / '1')
        os.symlink(watcher_log, process_root / 'fd' / '2')
    return process_root


def set_process_state(process_root, state):
    raw = (process_root / 'stat').read_text(encoding='utf-8')
    close = raw.rfind(')')
    fields = raw[close + 1:].split()
    fields[0] = state
    (process_root / 'stat').write_text(
        raw[:close + 1] + ' ' + ' '.join(fields) + '\n',
        encoding='utf-8',
    )


def expect_error(label, expected, callback):
    try:
        callback()
    except WatcherQuiescenceError as error:
        assert expected in str(error), (label, str(error))
    else:
        raise AssertionError(f'{label}: expected WatcherQuiescenceError')


with tempfile.TemporaryDirectory(prefix='nemoclaw-4462-watcher-') as tmp:
    root = Path(tmp)
    auto_pair_log = root / 'auto-pair.log'
    auto_pair_log.write_text('[auto-pair] watcher started\n', encoding='utf-8')

    success_proc = root / 'success-proc'
    success_proc.mkdir()
    success_watcher = write_process(
        success_proc, 4242, 111, watcher_log=auto_pair_log,
    )
    success_child = write_process(success_proc, 5001, 201, ppid=4242)
    stopped = []
    slept = []
    def idle_sleep(_seconds):
        slept.append(True)
        shutil.rmtree(success_child, ignore_errors=True)
    def stop_success(pid, revalidate):
        revalidate()
        stopped.append(pid)
        set_process_state(success_watcher, 'T')
    record = quiesce_watcher(
        auto_pair_log,
        success_proc,
        stopper=stop_success,
        wait_seconds=0.5,
        sleep=idle_sleep,
    )
    assert record_identity(record) == (4242, '111', os.geteuid())
    assert record['state'] == 'T'
    assert stopped == [4242]
    assert slept
    resumed = []
    def resume_success(pid, revalidate):
        revalidate()
        resumed.append(pid)
        set_process_state(success_watcher, 'S')
    resumed_record = resume_watcher(
        auto_pair_log,
        success_proc,
        4242,
        '111',
        resumer=resume_success,
        wait_seconds=0.1,
    )
    assert resumed_record['state'] == 'S'
    assert resumed == [4242]

    missing_start_log = root / 'missing-start.log'
    missing_start_log.write_text('', encoding='utf-8')
    missing_start_proc = root / 'missing-start-proc'
    missing_start_proc.mkdir()
    write_process(missing_start_proc, 4243, 112, watcher_log=missing_start_log)
    expect_error(
        'missing start',
        'start marker not observed',
        lambda: quiesce_watcher(missing_start_log, missing_start_proc, stopper=stop_success),
    )

    zero_proc = root / 'zero-proc'
    zero_proc.mkdir()
    expect_error(
        'zero watchers',
        'found 0',
        lambda: quiesce_watcher(auto_pair_log, zero_proc, stopper=stop_success),
    )

    multiple_proc = root / 'multiple-proc'
    multiple_proc.mkdir()
    write_process(multiple_proc, 4244, 113, watcher_log=auto_pair_log)
    write_process(multiple_proc, 4245, 114, watcher_log=auto_pair_log)
    expect_error(
        'multiple watchers',
        'found 2',
        lambda: quiesce_watcher(auto_pair_log, multiple_proc, stopper=stop_success),
    )

    already_stopped_proc = root / 'already-stopped-proc'
    already_stopped_proc.mkdir()
    write_process(
        already_stopped_proc, 4252, 122, state='T', watcher_log=auto_pair_log,
    )
    expect_error(
        'already stopped',
        'already stopped before quiescence',
        lambda: quiesce_watcher(
            auto_pair_log,
            already_stopped_proc,
            stopper=stop_success,
        ),
    )

    unreadable_proc = root / 'missing-proc'
    expect_error(
        'unreadable proc',
        'process table is not readable',
        lambda: quiesce_watcher(auto_pair_log, unreadable_proc, stopper=stop_success),
    )

    race_proc = root / 'race-proc'
    race_proc.mkdir()
    race_watcher = write_process(race_proc, 4246, 115, watcher_log=auto_pair_log)
    def stop_with_child_race(pid, revalidate):
        revalidate()
        write_process(race_proc, 5002, 202, ppid=pid)
        set_process_state(race_watcher, 'T')
    race_rollbacks = []
    def rollback_child_race(pid, revalidate):
        revalidate()
        race_rollbacks.append(pid)
        set_process_state(race_watcher, 'S')
    expect_error(
        'child race',
        'gained descendants during pidfd stop=5002',
        lambda: quiesce_watcher(
            auto_pair_log,
            race_proc,
            stopper=stop_with_child_race,
            rollback_resumer=rollback_child_race,
            wait_seconds=0.1,
        ),
    )
    assert process_record(race_watcher)['state'] == 'S'
    assert race_rollbacks == [4246]

    running_proc = root / 'running-proc'
    running_proc.mkdir()
    write_process(running_proc, 4247, 116, watcher_log=auto_pair_log)
    expect_error(
        'not stopped',
        'did not enter stopped state pid=4247 state=S',
        lambda: quiesce_watcher(
            auto_pair_log,
            running_proc,
            stopper=lambda _pid, revalidate: revalidate(),
            wait_seconds=0.01,
        ),
    )

    changed_proc = root / 'changed-proc'
    changed_proc.mkdir()
    changed_watcher = write_process(changed_proc, 4248, 117, watcher_log=auto_pair_log)
    def replace_identity(_pid, revalidate):
        revalidate()
        shutil.rmtree(changed_watcher)
        write_process(changed_proc, 4248, 118, watcher_log=auto_pair_log)
    expect_error(
        'changed identity',
        'identity changed after pidfd stop',
        lambda: quiesce_watcher(
            auto_pair_log,
            changed_proc,
            stopper=replace_identity,
            wait_seconds=0.1,
        ),
    )

    resume_child_proc = root / 'resume-child-proc'
    resume_child_proc.mkdir()
    write_process(
        resume_child_proc, 4249, 119, state='T', watcher_log=auto_pair_log,
    )
    write_process(resume_child_proc, 5003, 203, ppid=4249)
    expect_error(
        'resume child',
        'has descendants before resume=5003',
        lambda: resume_watcher(
            auto_pair_log,
            resume_child_proc,
            4249,
            '119',
            resumer=resume_success,
        ),
    )

    resume_running_proc = root / 'resume-running-proc'
    resume_running_proc.mkdir()
    write_process(
        resume_running_proc, 4250, 120, state='S', watcher_log=auto_pair_log,
    )
    expect_error(
        'resume running',
        'is not stopped before resume pid=4250 state=S',
        lambda: resume_watcher(
            auto_pair_log,
            resume_running_proc,
            4250,
            '120',
            resumer=resume_success,
        ),
    )

    resume_changed_proc = root / 'resume-changed-proc'
    resume_changed_proc.mkdir()
    write_process(
        resume_changed_proc, 4251, 121, state='T', watcher_log=auto_pair_log,
    )
    expect_error(
        'resume identity',
        'stopped auto-pair watcher identity is not unique',
        lambda: resume_watcher(
            auto_pair_log,
            resume_changed_proc,
            4251,
            '999',
            resumer=resume_success,
        ),
    )

print('ISSUE_4462_WATCHER_QUIESCENCE_BEHAVIOR_OK')
`;

describe("auto-pair watcher quiescence proof (#4462)", () => {
  it("executes idle pidfd stop/resume semantics and all fail-closed boundaries", () => {
    const result = spawnSync("python3", ["-"], {
      encoding: "utf8",
      input: `${ISSUE_4462_WATCHER_QUIESCENCE_PY}\n${BEHAVIOR_HARNESS_PY}`,
      timeout: 10_000,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("ISSUE_4462_WATCHER_QUIESCENCE_BEHAVIOR_OK");
  });
});
