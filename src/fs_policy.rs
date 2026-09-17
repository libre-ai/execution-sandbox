use crate::profile::HarnessProfile;
use crate::refusal::HarnessRefusal;
use std::path::{Path, PathBuf};

/// How a path is about to be touched. Writes are held to the writable set;
/// reads are held to the workspace and the denied set.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathAccessKind {
    Read,
    Write,
}

/// A canonicalized path observation, produced by the host layer (which is the
/// only place canonicalization can physically happen) and judged here.
#[derive(Clone, Debug)]
pub struct PathAccess {
    canonical_path: PathBuf,
    traversed_symlink: bool,
    kind: PathAccessKind,
}

impl PathAccess {
    #[must_use]
    pub fn new(canonical_path: &Path, traversed_symlink: bool, kind: PathAccessKind) -> Self {
        Self {
            canonical_path: canonical_path.to_path_buf(),
            traversed_symlink,
            kind,
        }
    }

    #[must_use]
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }
}

/// Minimal glob over the locked `relativePath` alphabet: `**` spans any number
/// of segments, `*` spans within one segment, everything else is literal. The
/// schema forbids every other metacharacter, so this is the whole language.
fn glob_matches(pattern: &str, path: &str) -> bool {
    /// Match the segment sequence with a single backtrack point — the last
    /// `**` seen — rather than a recursive OR at every `**`.
    ///
    /// The recursion this replaces was exponential in the number of `**` a
    /// pattern carries: the same class of defect the round 3 fix closed for
    /// `*` inside a segment, one level up, found by the round 4 security pass
    /// on 0b5204f (4.9 s at eleven `**`). Resuming from the LAST `**` is
    /// complete: once a later `**` has been reached, letting an earlier one
    /// absorb more segments can only reproduce a position the later one
    /// already covers. Cost is bounded by pattern length times path length.
    fn segments_match(pattern: &[&str], path: &[&str]) -> bool {
        let (mut p, mut s) = (0usize, 0usize);
        let mut star: Option<usize> = None;
        let mut resume = 0usize;

        while s < path.len() {
            if p < pattern.len() && pattern[p] == "**" {
                star = Some(p);
                resume = s;
                p += 1;
            } else if p < pattern.len() && segment_matches(pattern[p], path[s]) {
                p += 1;
                s += 1;
            } else if let Some(last_star) = star {
                p = last_star + 1;
                resume += 1;
                s = resume;
            } else {
                return false;
            }
        }
        while p < pattern.len() && pattern[p] == "**" {
            p += 1;
        }
        p == pattern.len()
    }

    /// Match one segment, over characters rather than bytes, with a single
    /// backtrack point rather than a recursive split at every offset.
    ///
    /// The byte-offset recursion this replaces had two defects the xhigh
    /// review of f27b3c9 found: it sliced at arbitrary offsets, so a
    /// non-ASCII name panicked mid-decision instead of being judged; and it
    /// explored every split point for every star, so a profile pattern with
    /// a handful of stars turned a policy decision into 35 seconds of CPU.
    /// A panic and a hang are both refusals the caller never receives.
    fn segment_matches(pattern: &str, segment: &str) -> bool {
        let pattern: Vec<char> = pattern.chars().collect();
        let segment: Vec<char> = segment.chars().collect();
        let (mut p, mut s) = (0usize, 0usize);
        // The last star seen, and where the segment stood when it was seen:
        // the one place the match may resume from.
        let mut star: Option<usize> = None;
        let mut resume = 0usize;

        while s < segment.len() {
            // The wildcard is decided by the PATTERN, never by the subject:
            // `*` is a legal path character, so preferring the literal
            // comparison let a subject carrying a star consume the pattern's
            // wildcard and escape a match — fail-open in the denied set
            // (round 3 security verdict on 0ab2a20).
            if p < pattern.len() && pattern[p] == '*' {
                star = Some(p);
                resume = s;
                p += 1;
            } else if p < pattern.len() && pattern[p] == segment[s] {
                p += 1;
                s += 1;
            } else if let Some(last_star) = star {
                p = last_star + 1;
                resume += 1;
                s = resume;
            } else {
                return false;
            }
        }
        while p < pattern.len() && pattern[p] == '*' {
            p += 1;
        }
        p == pattern.len()
    }

    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    segments_match(&pattern, &path)
}

fn any_matches(patterns: &[String], relative: &str) -> bool {
    patterns
        .iter()
        .any(|pattern| glob_matches(pattern, relative))
}

/// Journey 2 of the specification, decided on canonical facts: escape before
/// policy, denial before write rights, and a symlink that leaves the
/// workspace is named as the symlink policy it violated.
pub fn evaluate_path_access(
    workspace_root: &Path,
    access: &PathAccess,
    profile: &HarnessProfile,
) -> Result<(), HarnessRefusal> {
    let Ok(relative) = access.canonical_path.strip_prefix(workspace_root) else {
        if access.traversed_symlink {
            return Err(HarnessRefusal::SymlinkPolicyViolation);
        }
        return Err(HarnessRefusal::PathEscapesWorkspace);
    };
    let relative = relative.to_string_lossy();

    if any_matches(profile.denied_paths(), &relative) {
        return Err(HarnessRefusal::DeniedPathTouched);
    }

    match access.kind {
        PathAccessKind::Read => Ok(()),
        PathAccessKind::Write => {
            if any_matches(profile.writable_paths(), &relative) {
                Ok(())
            } else {
                Err(HarnessRefusal::WriteOutsideWritableSet)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::glob_matches;

    /// The whole `**` language, decided by the single-backtrack matcher: zero
    /// or more segments, anywhere, adjacent, and never across a literal.
    #[test]
    fn double_star_spans_zero_or_more_whole_segments() {
        let table: &[(&str, &str, bool)] = &[
            ("**", "a", true),
            ("**", "a/b/c", true),
            ("**/b", "b", true),
            ("**/b", "a/b", true),
            ("**/b", "a/x/b", true),
            ("**/b", "a/b/c", false),
            ("a/**", "a", true),
            ("a/**", "a/b/c", true),
            ("a/**", "b/a", false),
            ("a/**/b", "a/b", true),
            ("a/**/b", "a/x/y/b", true),
            ("a/**/b", "a/b/c", false),
            ("a/**/**/b", "a/b", true),
            ("a/**/**/b", "a/x/b", true),
            ("**/a/**/b/**/c", "a/b/c", true),
            ("**/a/**/b/**/c", "x/a/y/b/z/c", true),
            ("**/a/**/b/**/c", "a/c/b", false),
            ("**/*.pem", "keys/server.pem", true),
            ("**/*.pem", "keys/server.pem/x", false),
            ("out/**/*.txt", "out/a/b/c.txt", true),
            ("out/**/*.txt", "out/c.txt", true),
            ("out/**/*.txt", "in/c.txt", false),
            // `**` is only a wildcard as a whole segment; inside a segment the
            // stars are the intra-segment wildcard, twice.
            ("a**b", "axxb", true),
            ("a**b", "a/b", false),
        ];
        for (pattern, path, expected) in table {
            assert_eq!(
                glob_matches(pattern, path),
                *expected,
                "pattern {pattern:?} against {path:?}"
            );
        }
    }
}
