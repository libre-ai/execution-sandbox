/// Test-only echo worker: the descendant retains the transport until the
/// leader is a zombie. EOF therefore cannot race the leader's native exit.
/// This is a controlled success fixture, not a production worker protocol.
pub fn echo_after_leader_exit_args(exit_code: u8) -> Vec<String> {
    let observe = if cfg!(target_os = "linux") {
        r#"IFS= read -r record < "/proc/$leader/stat" || exit 1
        state=${record##*) }"#
    } else {
        r#"state=$(/bin/ps -o stat= -p "$leader") || exit 1"#
    };
    let script = format!(
        r#"leader=$$
exec 3<&0
(
    while :; do
        {observe}
        case "$state" in Z*) break ;; esac
    done
    exec /bin/cat <&3 3<&-
) <&3 &
exit {exit_code}
"#
    );
    vec!["-c".to_owned(), script]
}
