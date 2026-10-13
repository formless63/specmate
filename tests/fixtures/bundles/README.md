# Synthetic source packages

Each package contains a `manifest.json` conforming to the source-bundle contract,
and a `files/` directory whose relative paths, byte counts and hashes match it.
The manifest's synthetic IDs identify this checked-in example; registration assigns
new application bundle and revision IDs without changing the original file bytes.

`original-package` is original synthetic material under AGPL-3.0-only. It exercises
multiple files, nested paths, text and Python source preserved as data. Its script
raises immediately if executed; importing the package grants no execution authority.

`backend/tests/test_fixture_bundles.py` verifies manifest integrity, real PostgreSQL
registration, exact reconstruction, derivative ancestry, replay and failed intake
recovery through shared operations. These are source-contract and persistence tests,
not native-tool compatibility, archive extraction or physical qualification checks.
