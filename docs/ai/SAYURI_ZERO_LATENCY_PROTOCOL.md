# SAYURI ZERO-LATENCY DEVELOPMENT PROTOCOL v6.1

## Objective

Minimize repeated repository discovery for MICRO/SMALL changes without weakening release gates.
The fast path is local-first, delta-only, batch-first, and targeted-test-first.

## Start

Run `python tools/dev.py recover --json`.

Use the returned `task`, `next_action`, live `HEAD`, dirty files, and blockers as the working context. Do not perform a full repository audit when that context is sufficient.

## Fast path

1. `recover` — restore live state.
2. Read only task targets, direct contracts, and related tests.
3. Apply one coordinated patch.
4. `python tools/dev.py check` — run the minimum checks inferred from the diff.
5. `python tools/dev.py finish` — checkpoint a passing task.
6. Take `next_action` immediately when it is safe.

For a guarded one-commit finish on a non-main feature branch:

`python tools/dev.py finish --commit-message "feat(...): ..." --push`

Automatic finish refuses `main`, `master`, detached HEAD, unrelated dirty files, and changes outside `task.owned_paths`.

## Task manifest

Update the current task before autonomous work with `python tools/dev.py task` and explicit `--path`, `--accept`, and `--next-action` arguments.
The task manifest is the scope boundary for automated commits.

## Repository index

Run `python tools/dev.py reindex` after structural changes.
The generated `.sayuri/dev_index.json` maps modules, tests, package scripts, and impact rules. This replaces repeated manual repository discovery.

## Escalation

The fast path is not a release gate. Escalate to full checks for changes to security boundaries, permissions, storage, migrations, shared runtime contracts, package metadata, or CI configuration. Merge/release still requires the repository's required CI checks.

## Working rule

`RECOVER → DELTA → BATCH PATCH → TARGET CHECK → GUARDED FINISH → NEXT`

Do not use `FULL AUDIT → READ EVERYTHING → PATCH → FULL SUITE` for routine MICRO/SMALL changes.
