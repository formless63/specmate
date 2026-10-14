# Sharing record (KNW-004)

Workspaces are private: nothing is public by default and there are no public links.
Handing an output out of the workspace is an explicit download, and each successful
`export_package.download`, `selected_package.download` and `release.download` appends one
`ShareRecord` row (kind, exact root revision, release id if any, archive and manifest
SHA-256, actor, time, entry point). Reviews and failed downloads record nothing. Rows are
append-only (database trigger) and grant nothing. `share.list` shows every row to any member. Content scoping (no parent data, no automatic
dependency inclusion) is enforced by the selected-package builder; see selected-packages.md.
