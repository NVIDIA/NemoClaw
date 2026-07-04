// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Python source shared by the live #4462 sandbox probe and its executable
 * support test. It finds the exact sandbox-owned auto-pair watcher, waits for
 * an idle boundary, stops it through a Linux pidfd, and proves that the same
 * process is stopped with no descendants before pairing state is mutated.
 */
export const ISSUE_4462_WATCHER_QUIESCENCE_PY = String.raw`
import os
import signal
import sys
import time
from pathlib import Path


START_MARKER = '[auto-pair] watcher started'
SUCCESS_MARKER = 'ISSUE_4462_AUTO_PAIR_WATCHER_QUIESCED'
MAX_LOG_BYTES = 131072


class WatcherQuiescenceError(Exception):
    pass


def tail_text(path):
    try:
        with path.open('rb') as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - MAX_LOG_BYTES))
            return handle.read().decode('utf-8', 'replace')
    except (FileNotFoundError, OSError):
        return ''


def process_record(process_root):
    if not process_root.name.isdigit():
        return None
    try:
        owner_uid = process_root.stat().st_uid
        raw = (process_root / 'stat').read_text(encoding='utf-8')
    except OSError:
        return None
    close = raw.rfind(')')
    if close < 0:
        return None
    fields = raw[close + 1:].split()
    if (
        len(fields) <= 19
        or len(fields[0]) != 1
        or not fields[1].isdigit()
        or not fields[19].isdigit()
    ):
        return None
    return {
        'pid': int(process_root.name),
        'state': fields[0],
        'ppid': int(fields[1]),
        'start': fields[19],
        'uid': owner_uid,
    }


def watcher_record(process_root, auto_pair_log, expected_uid):
    record = process_record(process_root)
    if record is None or record['uid'] != expected_uid:
        return None
    try:
        argv = (process_root / 'cmdline').read_bytes().split(b'\x00')
    except OSError:
        return None
    executable = Path(argv[0].decode('utf-8', 'replace')).name if argv and argv[0] else ''
    if executable != 'python3' and not executable.startswith('python3.'):
        return None
    targets = []
    for fd in ('1', '2'):
        try:
            targets.append(os.readlink(process_root / 'fd' / fd))
        except OSError:
            return None
    if targets != [str(auto_pair_log), str(auto_pair_log)]:
        return None
    return record


def proc_entries(proc_root):
    try:
        return list(proc_root.iterdir())
    except OSError as error:
        raise WatcherQuiescenceError('auto-pair process table is not readable') from error


def matching_watchers(proc_root, auto_pair_log, expected_uid):
    matches = []
    for entry in proc_entries(proc_root):
        record = watcher_record(entry, auto_pair_log, expected_uid)
        if record is not None:
            matches.append(record)
    return sorted(matches, key=lambda value: value['pid'])


def descendant_pids(proc_root, ancestor_pid):
    records = {}
    for entry in proc_entries(proc_root):
        record = process_record(entry)
        if record is not None:
            records[record['pid']] = record
    descendants = set()
    for pid, record in records.items():
        if pid == ancestor_pid:
            continue
        seen = {pid}
        parent = record['ppid']
        while parent > 0 and parent not in seen:
            if parent == ancestor_pid:
                descendants.add(pid)
                break
            seen.add(parent)
            parent_record = records.get(parent)
            if parent_record is None:
                break
            parent = parent_record['ppid']
    return sorted(descendants)


def record_identity(record):
    return (record['pid'], record['start'], record['uid'])


def default_pidfd_stopper(pid, revalidate):
    pidfd_open = getattr(os, 'pidfd_open', None)
    pidfd_send_signal = getattr(signal, 'pidfd_send_signal', None)
    if not callable(pidfd_open) or not callable(pidfd_send_signal):
        raise WatcherQuiescenceError('Linux pidfd stop APIs are unavailable')
    try:
        pidfd = pidfd_open(pid, 0)
    except OSError as error:
        raise WatcherQuiescenceError(f'could not open auto-pair watcher pidfd: {error}') from error
    try:
        revalidate()
        pidfd_send_signal(pidfd, signal.SIGSTOP, None, 0)
    except WatcherQuiescenceError:
        raise
    except OSError as error:
        raise WatcherQuiescenceError(f'could not stop auto-pair watcher: {error}') from error
    finally:
        try:
            os.close(pidfd)
        except OSError:
            pass


def default_pidfd_resumer(pid, revalidate):
    pidfd_open = getattr(os, 'pidfd_open', None)
    pidfd_send_signal = getattr(signal, 'pidfd_send_signal', None)
    if not callable(pidfd_open) or not callable(pidfd_send_signal):
        raise WatcherQuiescenceError('Linux pidfd resume APIs are unavailable')
    try:
        pidfd = pidfd_open(pid, 0)
    except OSError as error:
        raise WatcherQuiescenceError(f'could not open stopped auto-pair watcher pidfd: {error}') from error
    try:
        revalidate()
        pidfd_send_signal(pidfd, signal.SIGCONT, None, 0)
    except WatcherQuiescenceError:
        raise
    except OSError as error:
        raise WatcherQuiescenceError(f'could not resume auto-pair watcher: {error}') from error
    finally:
        try:
            os.close(pidfd)
        except OSError:
            pass


def quiesce_watcher(
    auto_pair_log,
    proc_root,
    *,
    expected_uid=None,
    stopper=default_pidfd_stopper,
    rollback_resumer=default_pidfd_resumer,
    wait_seconds=10.0,
    monotonic=time.monotonic,
    sleep=time.sleep,
):
    auto_pair_log = Path(auto_pair_log)
    proc_root = Path(proc_root)
    expected_uid = os.geteuid() if expected_uid is None else expected_uid
    if START_MARKER not in tail_text(auto_pair_log):
        raise WatcherQuiescenceError('auto-pair watcher start marker not observed')

    matches = matching_watchers(proc_root, auto_pair_log, expected_uid)
    if len(matches) != 1:
        raise WatcherQuiescenceError(
            f'expected exactly one sandbox-owned auto-pair watcher, found {len(matches)}'
        )
    selected = matches[0]
    selected_identity = record_identity(selected)
    pid = selected['pid']
    if selected['state'] in {'T', 't'}:
        raise WatcherQuiescenceError('auto-pair watcher is already stopped before quiescence')

    deadline = monotonic() + wait_seconds
    while True:
        current = watcher_record(proc_root / str(pid), auto_pair_log, expected_uid)
        if current is None or record_identity(current) != selected_identity:
            raise WatcherQuiescenceError('auto-pair watcher identity changed before stop')
        if current['state'] in {'T', 't'}:
            raise WatcherQuiescenceError('auto-pair watcher entered stopped state before pidfd stop')
        descendants = descendant_pids(proc_root, pid)
        if not descendants:
            break
        if monotonic() >= deadline:
            raise WatcherQuiescenceError(
                'auto-pair watcher did not become idle descendants=' + ','.join(map(str, descendants))
            )
        sleep(0.05)

    def revalidate_for_stop():
        current = watcher_record(proc_root / str(pid), auto_pair_log, expected_uid)
        if current is None or record_identity(current) != selected_identity:
            raise WatcherQuiescenceError('auto-pair watcher identity changed before pidfd stop')
        if current['state'] in {'T', 't'}:
            raise WatcherQuiescenceError('auto-pair watcher entered stopped state before pidfd stop')
        descendants = descendant_pids(proc_root, pid)
        if descendants:
            raise WatcherQuiescenceError(
                'auto-pair watcher gained descendants before pidfd stop=' +
                ','.join(map(str, descendants))
            )

    def rollback_failed_stop():
        current = watcher_record(proc_root / str(pid), auto_pair_log, expected_uid)
        if current is None or record_identity(current) != selected_identity:
            raise WatcherQuiescenceError('cannot roll back changed auto-pair watcher identity')
        if current['state'] not in {'T', 't'}:
            return

        def revalidate_for_rollback():
            current = watcher_record(proc_root / str(pid), auto_pair_log, expected_uid)
            if current is None or record_identity(current) != selected_identity:
                raise WatcherQuiescenceError(
                    'auto-pair watcher identity changed before pidfd rollback'
                )
            if current['state'] not in {'T', 't'}:
                raise WatcherQuiescenceError(
                    'auto-pair watcher left stopped state before pidfd rollback'
                )

        rollback_resumer(pid, revalidate_for_rollback)
        rollback_deadline = monotonic() + min(wait_seconds, 5.0)
        while True:
            current = watcher_record(proc_root / str(pid), auto_pair_log, expected_uid)
            if current is None or record_identity(current) != selected_identity:
                raise WatcherQuiescenceError(
                    'auto-pair watcher identity changed after pidfd rollback'
                )
            if current['state'] not in {'T', 't'}:
                return
            if monotonic() >= rollback_deadline:
                raise WatcherQuiescenceError(
                    f'auto-pair watcher did not resume during rollback pid={pid}'
                )
            sleep(0.05)

    try:
        stopper(pid, revalidate_for_stop)
    except WatcherQuiescenceError:
        raise
    except Exception as stop_error:
        raise WatcherQuiescenceError(f'auto-pair watcher stop failed: {stop_error}') from stop_error

    try:
        stop_deadline = monotonic() + min(wait_seconds, 5.0)
        while True:
            current = watcher_record(proc_root / str(pid), auto_pair_log, expected_uid)
            if current is None or record_identity(current) != selected_identity:
                raise WatcherQuiescenceError('auto-pair watcher identity changed after pidfd stop')
            descendants = descendant_pids(proc_root, pid)
            if descendants:
                raise WatcherQuiescenceError(
                    'auto-pair watcher gained descendants during pidfd stop=' +
                    ','.join(map(str, descendants))
                )
            if current['state'] in {'T', 't'}:
                return current
            if monotonic() >= stop_deadline:
                raise WatcherQuiescenceError(
                    f'auto-pair watcher did not enter stopped state pid={pid} state={current["state"]}'
                )
            sleep(0.05)
    except BaseException as stop_error:
        try:
            rollback_failed_stop()
        except BaseException as rollback_error:
            raise WatcherQuiescenceError(
                f'{stop_error}; pidfd rollback failed: {rollback_error}'
            ) from stop_error
        if isinstance(stop_error, WatcherQuiescenceError):
            raise
        raise WatcherQuiescenceError(
            f'auto-pair watcher post-stop verification failed: {stop_error}'
        ) from stop_error


def resume_watcher(
    auto_pair_log,
    proc_root,
    pid,
    start_identity,
    *,
    expected_uid=None,
    resumer=default_pidfd_resumer,
    wait_seconds=5.0,
    monotonic=time.monotonic,
    sleep=time.sleep,
):
    auto_pair_log = Path(auto_pair_log)
    proc_root = Path(proc_root)
    expected_uid = os.geteuid() if expected_uid is None else expected_uid
    selected_identity = (pid, start_identity, expected_uid)
    matches = matching_watchers(proc_root, auto_pair_log, expected_uid)
    if len(matches) != 1 or record_identity(matches[0]) != selected_identity:
        raise WatcherQuiescenceError('stopped auto-pair watcher identity is not unique')
    current = watcher_record(proc_root / str(pid), auto_pair_log, expected_uid)
    if current is None or record_identity(current) != selected_identity:
        raise WatcherQuiescenceError('auto-pair watcher identity changed before resume')
    if current['state'] not in {'T', 't'}:
        raise WatcherQuiescenceError(
            f'auto-pair watcher is not stopped before resume pid={pid} state={current["state"]}'
        )
    descendants = descendant_pids(proc_root, pid)
    if descendants:
        raise WatcherQuiescenceError(
            'stopped auto-pair watcher has descendants before resume=' +
            ','.join(map(str, descendants))
        )

    def revalidate_for_resume():
        current = watcher_record(proc_root / str(pid), auto_pair_log, expected_uid)
        if current is None or record_identity(current) != selected_identity:
            raise WatcherQuiescenceError('auto-pair watcher identity changed before pidfd resume')
        if current['state'] not in {'T', 't'}:
            raise WatcherQuiescenceError('auto-pair watcher left stopped state before pidfd resume')
        descendants = descendant_pids(proc_root, pid)
        if descendants:
            raise WatcherQuiescenceError(
                'stopped auto-pair watcher gained descendants before pidfd resume=' +
                ','.join(map(str, descendants))
            )

    resumer(pid, revalidate_for_resume)

    deadline = monotonic() + wait_seconds
    while True:
        current = watcher_record(proc_root / str(pid), auto_pair_log, expected_uid)
        if current is None or record_identity(current) != selected_identity:
            raise WatcherQuiescenceError('auto-pair watcher identity changed after pidfd resume')
        if current['state'] not in {'T', 't'}:
            return current
        if monotonic() >= deadline:
            raise WatcherQuiescenceError(
                f'auto-pair watcher did not leave stopped state pid={pid}'
            )
        sleep(0.05)


def run_cli(argv=None):
    argv = sys.argv if argv is None else argv
    if len(argv) != 4:
        raise SystemExit(
            'usage: issue-4462-watcher-quiescence '
            '<auto-pair-log> <proc-root> <wait-seconds>'
        )
    try:
        wait_seconds = float(argv[3])
    except ValueError:
        raise SystemExit('watcher quiescence wait must be numeric') from None
    if not 0 < wait_seconds <= 30:
        raise SystemExit('watcher quiescence wait must be within (0, 30] seconds')
    try:
        record = quiesce_watcher(argv[1], argv[2], wait_seconds=wait_seconds)
    except WatcherQuiescenceError as error:
        raise SystemExit(str(error)) from None
    print(f'{record["pid"]} {record["start"]}')


def run_resume_cli(argv=None):
    argv = sys.argv if argv is None else argv
    if len(argv) != 6:
        raise SystemExit(
            'usage: issue-4462-watcher-resume '
            '<auto-pair-log> <proc-root> <pid> <start-identity> <wait-seconds>'
        )
    try:
        pid = int(argv[3])
        wait_seconds = float(argv[5])
    except ValueError:
        raise SystemExit('watcher resume pid and wait must be numeric') from None
    start_identity = argv[4]
    if pid <= 0 or not start_identity.isdigit():
        raise SystemExit('watcher resume identity is malformed')
    if not 0 < wait_seconds <= 30:
        raise SystemExit('watcher resume wait must be within (0, 30] seconds')
    try:
        record = resume_watcher(
            argv[1], argv[2], pid, start_identity, wait_seconds=wait_seconds,
        )
    except WatcherQuiescenceError as error:
        raise SystemExit(str(error)) from None
    print(f'ISSUE_4462_AUTO_PAIR_WATCHER_RESUMED pid={record["pid"]}')
`;
