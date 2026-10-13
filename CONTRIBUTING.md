# Contributing

Start with `AGENTS.md` and the [documentation map](docs/README.md). Keep the public
checkout independently usable. Private planning systems are not build dependencies.

A contribution identifies the affected capability/acceptance IDs, explains behavioral
changes, and includes relevant verification. Review original tests and reuse candidates
before rewriting a subsystem. When prior code is unavailable, identify that limitation;
do not invent findings or silently call a new implementation a port.

Use narrow commits and explicit file ownership for parallel work. A shared schema or
contract change requires integration coordination. Do not regenerate other contributors'
work, reformat unrelated files, or rewrite expected results merely to pass a test.

## Verification

Use change-focused checks as described in [TESTING](docs/TESTING.md). Broad suites run
at integration/release checkpoints or after changes with broad blast radius. Public
CI must neither load private fixtures nor require paid or personal external accounts.

## Public-safe history

Review staged files, commit messages, authorship, generated outputs, and license notices
before publishing. Configure the intended public Git identity before the first commit.
A `.gitignore` file is an exclusion convenience, not a confidentiality boundary.

## Licensing

Contribute only material you have permission to distribute under its declared terms.
Maintain notices and source provenance for imported code/assets. No blanket exemption
for in-process proprietary extensions is granted. See `LICENSING.md`.

## Releases

No pre-1.0 production compatibility is promised. Schema resets remain restricted to
explicitly disposable environments. Full product acceptance and a supported data baseline
are release decisions, not automatic consequences of a version bump.
