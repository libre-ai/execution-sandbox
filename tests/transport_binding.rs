mod support;

use libre_ai_harness::{
    ConfinementPlan, ProcessPrescription, RunBinding, SpawnLimits, WrapperChain,
    plan_wrapper_chain, spawn_confined,
};
use std::path::Path;
use std::time::Duration;

fn bare_chain() -> WrapperChain {
    plan_wrapper_chain(
        &ProcessPrescription::new(false, false, false, false, 0),
        &ConfinementPlan::unprivileged(),
    )
    .expect("an empty prescription needs no mechanism")
}

fn limits() -> SpawnLimits {
    SpawnLimits::new(4_096, Duration::from_millis(5_000))
}

/// `runBoundToken` is const true in the locked profile. A token that is
/// generated but never checked is the prescription the K4 rounds rejected as
/// inert: the response must prove it belongs to this run.
#[test]
fn a_fresh_token_is_generated_per_run_and_never_repeats() {
    let first = RunBinding::fresh().expect("the host must provide entropy");
    let second = RunBinding::fresh().expect("the host must provide entropy");
    assert_ne!(first.token(), second.token());
    assert_eq!(first.token().len(), 43, "32 bytes, unpadded base64url");
}

#[test]
fn a_worker_returning_the_token_has_its_response_admitted() {
    let binding = RunBinding::fresh().expect("entropy");
    let outcome = spawn_confined(
        Path::new("/bin/sh"),
        &support::echo_after_leader_exit_args(0),
        b"payload-bytes",
        Path::new("/tmp"),
        &limits(),
        &ConfinementPlan::unprivileged(),
        &bare_chain(),
        &binding,
    )
    .expect("the controlled worker echoes the framed payload, token included");
    assert!(outcome.exit_ok());
    assert!(outcome.run_binding_proved());
    assert_eq!(
        outcome.output(),
        b"payload-bytes",
        "the binding frame is consumed, never handed to the caller"
    );
}

/// A response that does not carry this run's token is not this run's
/// response, whatever else is true of it.
#[test]
fn a_response_without_this_runs_token_is_not_accepted() {
    let binding = RunBinding::fresh().expect("entropy");
    let outcome = spawn_confined(
        // Drain the request before closing the socket so this case tests
        // missing binding independently of interrupted capture.
        Path::new("/bin/sh"),
        &[
            "-c".to_owned(),
            "/bin/cat >/dev/null && printf unbound-output".to_owned(),
        ],
        b"payload-bytes",
        Path::new("/tmp"),
        &limits(),
        &ConfinementPlan::unprivileged(),
        &bare_chain(),
        &binding,
    )
    .expect("the worker runs; its answer is what fails");
    assert!(
        !outcome.capture_failed(),
        "the complete response was captured"
    );
    assert!(!outcome.truncated());
    assert!(!outcome.timed_out());
    assert_eq!(outcome.output(), b"unbound-output");
    assert!(!outcome.run_binding_proved());
    assert!(
        !outcome.exit_ok(),
        "an unbound response cannot close a run successfully"
    );
}
