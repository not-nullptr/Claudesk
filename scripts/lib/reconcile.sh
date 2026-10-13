#!/bin/sh
#
# Bounded-parallel reconciler, shared by converge-users.sh and refresh-users.sh.
# Sourced, not executed.
#
#   reconcile_list PROJECT_DIR LIST_FILE
#
# Runs scripts/provision-user.sh once per non-empty line of LIST_FILE, at most
# CLAUDESK_RECONCILE_JOBS (default 4) at a time. Each account's output is
# captured and printed only if it fails, so a parallel run stays readable. The
# counts are left in RECONCILE_OK and RECONCILE_FAIL, and the function returns
# non-zero when any account failed.
#
# The list is read from a file rather than a pipe: the jobs are started from the
# loop, so a piped loop would run in a subshell and lose its counters. The same
# reason keeps the callers passing a temp file in.

provision_one() {
    project_dir="$1"
    results="$2"
    index="$3"
    email="$4"
    if "$project_dir/scripts/provision-user.sh" "$email" > "$results/log.$index" 2>&1; then
        : > "$results/ok.$index"
    else
        : > "$results/fail.$index"
        printf 'reconcile: %s failed:\n' "$email" >&2
        sed 's/^/  /' "$results/log.$index" >&2
    fi
}

reconcile_list() {
    project_dir="$1"
    list_file="$2"
    jobs="${CLAUDESK_RECONCILE_JOBS:-4}"
    case "$jobs" in
        ''|*[!0-9]*) jobs=4 ;;
    esac
    [ "$jobs" -ge 1 ] || jobs=4

    results="$(mktemp -d)"
    running=0
    index=0
    while IFS= read -r email; do
        [ -n "$email" ] || continue
        index=$((index + 1))
        provision_one "$project_dir" "$results" "$index" "$email" &
        running=$((running + 1))
        # Drain the pool once it fills, then keep starting the next batch. `wait`
        # returns the last job's status, which is a failure we have already
        # recorded — so it must not trip the callers' `set -e`.
        if [ "$running" -ge "$jobs" ]; then
            wait || true
            running=0
        fi
    done < "$list_file"
    wait || true

    # shellcheck disable=SC2034  # both are read by the sourcing script
    RECONCILE_OK=$(find "$results" -name 'ok.*' | wc -l | tr -d ' ')
    RECONCILE_FAIL=$(find "$results" -name 'fail.*' | wc -l | tr -d ' ')
    rm -rf "$results"
    [ "$RECONCILE_FAIL" -eq 0 ]
}
