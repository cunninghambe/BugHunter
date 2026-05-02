# bisect-demo fixture

Integration test fixture for `bughunter bisect` (v0.35).

## Structure

This fixture describes a 12-commit Express + React app where commit 7 introduces a
`dom_error_text` bug ("Something went wrong") on the `/products` route.

- Commits 1–6: clean (bug absent)
- Commit 7: introduces the bug (deliberate regression)
- Commits 8–12: carry the bug (HEAD)

The fixture metadata below enables integration tests to set up a git repo with
seeded commits and verify that `bughunter bisect <bug-id>` identifies commit 7.

## Fixture metadata

See `fixture.json` for the exact commit configuration used by integration tests.
