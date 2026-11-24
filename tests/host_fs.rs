use libre_ai_contract_types::ContractRegistry;
use libre_ai_harness::{PathAccessKind, WorkspaceObserver, parse_profile};
use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;

const CANONICAL_PROFILE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/profiles/local-process.v2.json"
));

/// A throwaway real workspace with an `out/` writable dir, an outside file
/// and a symlink escaping the root — the adversarial fixtures of the spec.
struct Fixture {
    base: PathBuf,
    workspace: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let base =
            std::env::temp_dir().join(format!("harness-host-fs-{label}-{}", std::process::id()));
        let workspace = base.join("ws");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(workspace.join("out")).expect("the workspace fixture must build");
        fs::write(base.join("secret.txt"), b"outside").expect("the outside file must build");
        symlink(base.join("secret.txt"), workspace.join("link-out"))
            .expect("the escaping symlink must build");
        Self { base, workspace }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn profile() -> libre_ai_harness::HarnessProfile {
    let registry = ContractRegistry::embedded().expect("embedded contracts must compile");
    let document = serde_json::from_str(CANONICAL_PROFILE).expect("the fixture must parse");
    parse_profile(&registry, &document).expect("the canonical profile must parse")
}

#[test]
fn a_symlink_escaping_the_workspace_is_named_as_the_symlink_policy() {
    let fixture = Fixture::new("symlink");
    let observer =
        WorkspaceObserver::new(&fixture.workspace).expect("the workspace root must canonicalize");
    let refusal = observer
        .judge(
            &fixture.workspace.join("link-out"),
            PathAccessKind::Read,
            &profile(),
        )
        .expect_err("a symlink resolving outside the workspace violates the policy");
    assert_eq!(refusal.code(), "harness.symlink_policy_violation");
}

#[test]
fn a_dotdot_traversal_surviving_naive_normalization_is_an_escape() {
    let fixture = Fixture::new("dotdot");
    let observer =
        WorkspaceObserver::new(&fixture.workspace).expect("the workspace root must canonicalize");
    let raw = fixture.workspace.join("out/../../secret.txt");
    let refusal = observer
        .judge(&raw, PathAccessKind::Read, &profile())
        .expect_err("a canonical path outside the root is refused");
    assert_eq!(refusal.code(), "harness.path_escapes_workspace");
}

#[test]
fn a_write_to_a_denied_path_produces_its_code_never_a_warning() {
    let fixture = Fixture::new("denied");
    let observer =
        WorkspaceObserver::new(&fixture.workspace).expect("the workspace root must canonicalize");
    let refusal = observer
        .judge(
            &fixture.workspace.join(".env"),
            PathAccessKind::Write,
            &profile(),
        )
        .expect_err("the denied set blocks the write");
    assert_eq!(refusal.code(), "harness.denied_path_touched");
}

/// On a real workspace: a file exists and sits inside the root, and is still
/// not readable unless the profile lists it.
#[test]
fn a_read_is_held_to_the_read_only_and_writable_sets_on_a_real_workspace() {
    let fixture = Fixture::new("read");
    fs::create_dir_all(fixture.workspace.join("in")).expect("the input directory must build");
    fs::write(fixture.workspace.join("in/data.txt"), b"input").expect("the input must build");
    fs::write(fixture.workspace.join("scratch.txt"), b"unlisted").expect("the file must build");
    let observer =
        WorkspaceObserver::new(&fixture.workspace).expect("the workspace root must canonicalize");

    let canonical = observer
        .judge(
            &fixture.workspace.join("in/data.txt"),
            PathAccessKind::Read,
            &profile(),
        )
        .expect("a read inside the read-only set passes");
    assert!(canonical.ends_with("in/data.txt"));

    let refusal = observer
        .judge(
            &fixture.workspace.join("scratch.txt"),
            PathAccessKind::Read,
            &profile(),
        )
        .expect_err("an existing file the profile lists nowhere is not readable");
    assert_eq!(refusal.code(), "harness.denied_path_touched");
}

#[test]
fn a_legitimate_write_target_resolves_to_its_canonical_path() {
    let fixture = Fixture::new("write");
    let observer =
        WorkspaceObserver::new(&fixture.workspace).expect("the workspace root must canonicalize");
    let canonical = observer
        .judge(
            &fixture.workspace.join("out/result.txt"),
            PathAccessKind::Write,
            &profile(),
        )
        .expect("a write inside the writable set passes");
    assert!(canonical.ends_with("out/result.txt"));
}
