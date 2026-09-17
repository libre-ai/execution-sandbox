#!/bin/sh
set -eu
test "$#" = 1
test "$(uname -s)" = Linux
case "$1" in
    refusal)
        if id harness-worker >/dev/null 2>&1; then
            printf '%s\n' 'Refusal evidence requires an absent worker identity' >&2
            exit 1
        fi
        ;;
    attestation)
        test "$(id -u)" = 0
        worker_uid=$(id -u harness-worker)
        worker_gid=$(id -g harness-worker)
        case "$worker_uid:$worker_gid" in *[!0-9:]*|:*) exit 1 ;; esac
        test "$worker_uid" -gt 0
        test "$worker_gid" -gt 0
        # Exercise the actual identity/capability transition before accepting
        # the test's equipped-host branch as attestation evidence.
        actual_uid=$(setpriv --no-new-privs --reuid="$worker_uid" --regid="$worker_gid" --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all /usr/bin/id -u)
        test "$actual_uid" = "$worker_uid"
        ;;
    *) exit 2 ;;
esac
report=$(mktemp)
trap 'rm -f "$report"' EXIT HUP INT TERM
if cargo test --locked --all-features --test confined_execution -- --test-threads=1 > "$report" 2>&1; then
    cat "$report"
else
    status=$?
    cat "$report" >&2
    exit "$status"
fi
# A zero exit from an empty, filtered or skipped test binary is not proof.
grep -E '^test result: ok\. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;([[:space:]].*)?$' "$report" >/dev/null
