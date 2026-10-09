use libre_ai_harness::{
    ConfinementPlan, ProcessPrescription, RunBinding, SpawnLimits, plan_wrapper_chain,
    spawn_confined,
};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

/// A read that a signal interrupts is not a transport failure.
///
/// Linux never restarts a socket read that carries `SO_RCVTIMEO` once the
/// process has been stopped and continued: the call returns `EINTR`. The
/// capture used to read that as a dead transport, so a run was reported as
/// `capture_failed` instead of reaching its output bound or its duration
/// bound. It lives in its own test binary because stopping the process
/// stops every other test sharing it.
#[test]
fn an_interrupted_read_does_not_end_the_capture() {
    let pid = std::process::id();
    // Ten stop/continue cycles across the run, so at least one lands while
    // the capture is blocked in its read, whatever the scheduler does.
    let script = format!(
        "i=0; while [ $i -lt 10 ]; do sleep 0.1; kill -STOP {pid}; sleep 0.05; kill -CONT {pid}; i=$((i+1)); done"
    );
    let mut stopper = Command::new("/bin/sh")
        .args(["-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the stop/continue driver starts");

    let chain = plan_wrapper_chain(
        &ProcessPrescription::new(false, false, false, false, 0),
        &ConfinementPlan::unprivileged(),
    )
    .expect("an empty prescription needs no mechanism");
    let outcome = spawn_confined(
        Path::new("/bin/sleep"),
        &["5".to_owned()],
        b"",
        Path::new("/tmp"),
        &SpawnLimits::new(4_096, Duration::from_millis(1_500)),
        &ConfinementPlan::unprivileged(),
        &chain,
        &RunBinding::fresh().expect("the host must provide entropy"),
    )
    .expect("the sleeping worker is reaped");
    stopper.wait().expect("the driver ends");

    assert!(
        !outcome.capture_failed(),
        "a signal is not a transport error: {outcome:?}"
    );
    assert!(
        outcome.timed_out(),
        "the duration bound must still kill the run: {outcome:?}"
    );
}
