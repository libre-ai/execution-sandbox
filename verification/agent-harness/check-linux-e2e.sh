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
        # Passing refusal tests must never qualify a positive attestation.
        # Reopening this mode requires an enforced worker network boundary.
        printf '%s\n' 'Attestation qualification unavailable: worker network isolation is not enforced' >&2
        exit 1
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
