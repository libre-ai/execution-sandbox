mod support;

use libre_ai_contract_types::ContractRegistry;
use libre_ai_harness::{
    HarnessRefusal, RunError, RunIdentity, profile_digest, run_confined_attested,
};
use serde_json::Value;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

const CANONICAL_PROFILE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/profiles/local-process.v2.json"
));
const PROFILE_ID: &str = "urn:libre-ai:profile:local-process-1";
const SIGNING_SEED: [u8; 32] = [11; 32];

fn run_identity() -> RunIdentity {
    RunIdentity {
        attestation_id: "urn:libre-ai:attestation:harness-run-e2e-1".to_owned(),
        tenant_id: "ten_1234567890abcdef".to_owned(),
        mission_id: "urn:libre-ai:mission:bootstrap-e2e".to_owned(),
        run_id: "urn:libre-ai:run:bootstrap-e2e-1".to_owned(),
        plan_digest: "a".repeat(64),
        signing_key_id: "harness_bootstrap_key_1".to_owned(),
    }
}

/// The dedicated worker identity is arranged by CI (useradd) and looked up
/// here; the harness resolves its own tools, the test only nominates the id.
fn dedicated_identity() -> Option<(u32, u32)> {
    let uid = Command::new("/usr/bin/id")
        .args(["-u", "harness-worker"])
        .output()
        .ok()
        .filter(|probe| probe.status.success())
        .and_then(|probe| {
            String::from_utf8_lossy(&probe.stdout)
                .trim()
                .parse::<u32>()
                .ok()
        })?;
    Some((uid, uid))
}

#[test]
fn an_attested_run_is_refused_before_the_worker_can_start() {
    let registry = ContractRegistry::embedded().expect("embedded contracts must compile");
    let document: Value =
        serde_json::from_str(CANONICAL_PROFILE).expect("the canonical profile must parse");
    let digest = profile_digest(&document).expect("the canonical profile must digest");

    let workspace = std::env::temp_dir().join(format!("harness-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&workspace);
    std::fs::create_dir_all(workspace.join("out")).expect("the workspace must build");

    // A dedicated worker could write this synthetic sentinel on an equipped
    // host; absent output must establish admission, not a DAC write failure.
    std::fs::set_permissions(&workspace, std::fs::Permissions::from_mode(0o755))
        .expect("make the owned workspace traversable by the dedicated identity");
    let marker_directory = workspace.join("out");
    std::fs::set_permissions(&marker_directory, std::fs::Permissions::from_mode(0o777))
        .expect("make the owned synthetic marker directory writable");
    let identity = dedicated_identity();
    let marker = marker_directory.join("worker-started");
    let result = run_confined_attested(
        &registry,
        &document,
        PROFILE_ID,
        &digest,
        &workspace,
        Path::new("/bin/sh"),
        &[
            "-c".to_owned(),
            "printf started > \"$1\"".to_owned(),
            "worker-probe".to_owned(),
            marker.to_string_lossy().into_owned(),
        ],
        b"bootstrap-payload",
        identity.map(|(uid, _)| uid),
        identity.map(|(_, gid)| gid),
        &run_identity(),
        &SIGNING_SEED,
        "2026-08-05T12:00:00Z",
    );

    if cfg!(target_os = "linux") {
        assert_eq!(
            result.expect_err("identity and process limits do not establish network isolation"),
            RunError::Refused(HarnessRefusal::ControlNotEnforceable)
        );
    } else {
        assert_eq!(
            result.expect_err("a platform outside the profile must refuse"),
            RunError::Refused(HarnessRefusal::PlatformUnsupported)
        );
    }
    assert!(
        !marker.exists(),
        "refused admission must not start the worker"
    );

    let _ = std::fs::remove_dir_all(&workspace);
}

/// These public API journeys now stop at network admission. The lower-level
/// host_process suite retains native-failure and run-binding assertions; these
/// refusals must not be represented as evidence that either worker ran.
fn assert_worker_error(program: &Path, args: &[String], case: &str) {
    let registry = ContractRegistry::embedded().expect("embedded contracts must compile");
    let document: Value =
        serde_json::from_str(CANONICAL_PROFILE).expect("the canonical profile must parse");
    let digest = profile_digest(&document).expect("the canonical profile must digest");
    let workspace = std::env::temp_dir().join(format!("harness-e2e-{}-{case}", std::process::id()));
    std::fs::create_dir_all(workspace.join("out")).expect("the workspace must build");
    let identity = dedicated_identity();
    let result = run_confined_attested(
        &registry,
        &document,
        PROFILE_ID,
        &digest,
        &workspace,
        program,
        args,
        b"negative-journey-payload",
        identity.map(|(uid, _)| uid),
        identity.map(|(_, gid)| gid),
        &run_identity(),
        &SIGNING_SEED,
        "2026-08-05T12:00:00Z",
    );
    std::fs::remove_dir_all(&workspace).expect("remove the owned test workspace");
    let actual = result.expect_err("a failed or unbound worker cannot produce an attestation");
    if cfg!(target_os = "linux") {
        assert_eq!(
            actual,
            RunError::Refused(HarnessRefusal::ControlNotEnforceable)
        );
    } else {
        assert_eq!(
            actual,
            RunError::Refused(HarnessRefusal::PlatformUnsupported)
        );
    }
}

#[test]
fn a_complete_bound_response_from_a_failed_worker_is_not_attested() {
    assert_worker_error(
        Path::new("/bin/sh"),
        &support::echo_after_leader_exit_args(7),
        "native-failure",
    );
}

#[test]
fn an_unbound_worker_response_is_not_attested() {
    assert_worker_error(
        Path::new("/bin/sh"),
        &[
            "-c".to_owned(),
            "/bin/cat >/dev/null && printf unbound-response".to_owned(),
        ],
        "unbound-response",
    );
}
