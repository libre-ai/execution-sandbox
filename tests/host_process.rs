mod support;

use libre_ai_harness::{
    ConfinementPlan, ProcessPrescription, RunBinding, SpawnLimits, WrapperChain,
    plan_wrapper_chain, spawn_confined,
};
use std::path::Path;
use std::time::Duration;

fn limits(max_output: u64, timeout_ms: u64) -> SpawnLimits {
    SpawnLimits::new(max_output, Duration::from_millis(timeout_ms))
}

/// These tests exercise the host primitive itself, so they prescribe nothing:
/// the chain is empty and the program runs directly. A real run always goes
/// through a profile, whose const-locked prescription the chain must apply.
fn bare_chain() -> WrapperChain {
    plan_wrapper_chain(
        &ProcessPrescription::new(false, false, false, false, 0),
        &ConfinementPlan::unprivileged(),
    )
    .expect("an empty prescription needs no mechanism")
}

#[test]
fn the_payload_travels_the_private_pair_and_comes_back_bound_to_the_run() {
    let outcome = spawn_confined(
        Path::new("/bin/sh"),
        &support::echo_after_leader_exit_args(0),
        b"run-token-42:payload",
        Path::new("/tmp"),
        &limits(4_096, 5_000),
        &ConfinementPlan::unprivileged(),
        &bare_chain(),
        &RunBinding::fresh().expect("the host must provide entropy"),
    )
    .expect("the controlled worker echoes the payload");
    assert!(outcome.exit_ok());
    assert!(!outcome.truncated());
    assert_eq!(outcome.output(), b"run-token-42:payload");
}

#[test]
fn a_worker_flooding_its_output_is_truncated_and_marked() {
    let outcome = spawn_confined(
        Path::new("/bin/sh"),
        &["-c".to_owned(), "yes flood | head -c 5000".to_owned()],
        b"",
        Path::new("/tmp"),
        &limits(1_000, 5_000),
        &ConfinementPlan::unprivileged(),
        &bare_chain(),
        &RunBinding::fresh().expect("the host must provide entropy"),
    )
    .expect("the flooding worker still runs");
    assert!(outcome.truncated(), "the capture must stop at its bound");
    // The worker never returns the token, so the frame cannot be stripped and
    // the caller sees the raw capture: bounded by the content limit plus the
    // transport frame the profile's bound does not have to pay for.
    assert!(outcome.output().len() <= 1_044);
    assert!(!outcome.run_binding_proved());
}

#[test]
fn the_worker_inherits_no_environment() {
    let outcome = spawn_confined(
        Path::new("/bin/sh"),
        &["-c".to_owned(), "env".to_owned()],
        b"",
        Path::new("/tmp"),
        &limits(4_096, 5_000),
        &ConfinementPlan::unprivileged(),
        &bare_chain(),
        &RunBinding::fresh().expect("the host must provide entropy"),
    )
    .expect("the env worker runs");
    let printed = String::from_utf8_lossy(outcome.output()).to_string();
    assert!(
        !printed.contains("PATH=") && !printed.contains("HOME="),
        "no host environment may reach the worker"
    );
}

#[test]
fn a_worker_outliving_its_duration_bound_is_killed() {
    let outcome = spawn_confined(
        Path::new("/bin/sleep"),
        &["5".to_owned()],
        b"",
        Path::new("/tmp"),
        &limits(4_096, 300),
        &ConfinementPlan::unprivileged(),
        &bare_chain(),
        &RunBinding::fresh().expect("the host must provide entropy"),
    )
    .expect("the sleeping worker is reaped");
    assert!(outcome.timed_out(), "the duration bound must kill the run");
    assert!(!outcome.exit_ok());
}

/// `maxDurationSeconds` must bound the RUN, not merely the read phase: a
/// worker that never drains stdin used to block write_all before the clock
/// started (round 2 security verdict, blocking finding 2).
#[test]
fn a_worker_that_never_reads_its_input_cannot_stall_the_harness() {
    let started = std::time::Instant::now();
    let big = vec![b'x'; 1_048_576];
    let outcome = spawn_confined(
        // Exits at once without reading a byte of stdin.
        Path::new("/bin/echo"),
        &["done".to_owned()],
        &big,
        Path::new("/tmp"),
        &limits(4_096, 1_000),
        &ConfinementPlan::unprivileged(),
        &bare_chain(),
        &RunBinding::fresh().expect("entropy"),
    )
    .expect("the harness returns rather than blocking on the write");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "a payload the worker never reads must not hold the harness open"
    );
    assert!(!outcome.exit_ok());
}

/// EOF says every holder of the worker end is gone. That is the moment the
/// group is cleared — while the leader is still unreaped, so its pgid cannot
/// have been recycled. A worker that closes its transport and lingers gets no
/// grace period: the previous ordering waited first, reaped the leader, and
/// only then signalled a pgid the kernel was free to hand to a stranger
/// (round 4 security verdict on 0b5204f, major 1).
#[test]
fn a_worker_that_closes_its_transport_and_lingers_is_cleared_at_eof_not_after_a_grace_period() {
    let started = std::time::Instant::now();
    let outcome = spawn_confined(
        Path::new("/bin/sh"),
        // Both descriptors hold the same socket end: close both, then linger.
        &["-c".to_owned(), "exec <&- >&-; sleep 3; exit 0".to_owned()],
        b"",
        Path::new("/tmp"),
        &limits(4_096, 10_000),
        &ConfinementPlan::unprivileged(),
        &bare_chain(),
        &RunBinding::fresh().expect("the host must provide entropy"),
    )
    .expect("the lingering worker is cleared");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "EOF ends the run at once; the worker's lingering must not extend it"
    );
    assert!(!outcome.timed_out(), "the bound was never reached");
    assert!(!outcome.exit_ok());
}

/// EOF ends execution even if the complete bound output arrived and the
/// worker would otherwise finish with exit zero after its cleanup.
#[test]
fn a_worker_that_closes_before_native_exit_is_not_reported_as_successful() {
    let outcome = spawn_confined(
        Path::new("/bin/sh"),
        &[
            "-c".to_owned(),
            "cat; exec <&- >&-; kill -STOP $$; exit 0".to_owned(),
        ],
        b"clean-exit",
        Path::new("/tmp"),
        &limits(4_096, 5_000),
        &ConfinementPlan::unprivileged(),
        &bare_chain(),
        &RunBinding::fresh().expect("entropy"),
    )
    .expect("the stopped worker is cleared at EOF");
    assert_eq!(outcome.output(), b"clean-exit");
    assert!(outcome.run_binding_proved());
    assert!(!outcome.truncated());
    assert!(!outcome.capture_failed());
    assert!(!outcome.timed_out());
    assert!(
        !outcome.exit_ok(),
        "bound output cannot substitute for native success"
    );
}

#[test]
fn a_bound_response_does_not_hide_a_nonzero_native_exit() {
    let outcome = spawn_confined(
        Path::new("/bin/sh"),
        &support::echo_after_leader_exit_args(7),
        b"failed-worker-payload",
        Path::new("/tmp"),
        &limits(4_096, 5_000),
        &ConfinementPlan::unprivileged(),
        &bare_chain(),
        &RunBinding::fresh().expect("entropy"),
    )
    .expect("the failed worker is reaped");
    assert_eq!(outcome.output(), b"failed-worker-payload");
    assert!(outcome.run_binding_proved());
    assert!(!outcome.truncated());
    assert!(!outcome.capture_failed());
    assert!(!outcome.timed_out());
    assert!(!outcome.exit_ok());
}

/// The fixture must establish native exit before releasing EOF. Merely
/// closing descriptors while planning to exit zero is insufficient.
#[test]
fn the_success_fixture_releases_eof_only_after_native_exit() {
    use std::io::{Read, Write};
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;
    use std::process::{Command, Stdio};

    let (mut host, worker) = UnixStream::pair().expect("private transport");
    let stdout = worker.try_clone().expect("second worker descriptor");
    let mut command = Command::new("/bin/sh");
    command
        .args(support::echo_after_leader_exit_args(0))
        .env_clear()
        .stdin(Stdio::from(OwnedFd::from(worker)))
        .stdout(Stdio::from(OwnedFd::from(stdout)))
        .stderr(Stdio::null());
    let mut child = command.spawn().expect("fixture starts");
    drop(command);
    host.set_read_timeout(Some(Duration::from_secs(5)))
        .expect("bounded oracle");
    host.write_all(b"oracle-payload").expect("oracle input");
    let mut output = [0u8; 14];
    let capture = host.read_exact(&mut output);
    // The descendant is blocked on further input while the oracle observes
    // native success. Only afterwards does the oracle allow transport EOF.
    let status_before_eof = child.try_wait().expect("native status probe");
    host.set_nonblocking(true).expect("nonblocking EOF probe");
    let pending = host.read(&mut [0u8; 1]);
    host.set_nonblocking(false)
        .expect("restore bounded capture");
    host.shutdown(std::net::Shutdown::Write).expect("input EOF");
    let mut trailing = Vec::new();
    let drain = host.read_to_end(&mut trailing);
    // No process-group signal follows this oracle's reap. Only an unreaped
    // leader from a failing fixture is killed, using its Child handle.
    if status_before_eof.is_none() {
        child.kill().expect("clear a fixture with no native status");
    }
    child.wait().expect("reap fixture");
    capture.expect("fixture echoes while input remains open");
    assert_eq!(&output, b"oracle-payload");
    assert!(
        status_before_eof.is_some_and(|status| status.success()),
        "native zero status must be observed before transport EOF is allowed"
    );
    assert!(
        matches!(pending, Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "the descendant must still hold the transport after native exit"
    );
    drain.expect("fixture delivers EOF once input closes");
    assert!(trailing.is_empty());
}
