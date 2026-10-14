# Catalog pack adoption

Catalog packs are inert, versioned workspace library content. A typed manifest records package
identity, publisher and capability claims, contract compatibility, declared rights,
signature claims, exact dependency versions and up to 100 entries. Entries identify
content, workshop profiles, rule/model files or recipe references. Engineering pins
include an exact revision and snapshot hash; registered files include exact bundle
revision, path, hash and declared rights. Labels, paths and rights preserve whitespace.
Content/profile entries may cite supplementary registered files. Rule/model entries
may also associate an exact engineering revision; recipe references may cite an exact
supporting file. These supplementary references remain part of retained authorized
closure even when their category does not materialize a draft. Every supplied pin is
checked at registration, inspection and adoption; an inert classification is not an
authorization exception and never turns a cited recipe file into executable authority.
Every pin (entry revision, file, manifest file and dependency version) must belong to the
pack's workspace: a foreign record is reported as `Not found.` at registration, exactly
like a missing one, and a database guard rejects such entries independently.

`catalog_pack.register` is an import (`item.create`, contributors may register); the
optional `workspace_id` defaults to the actor's workspace. It stores canonical manifest bytes and their hash, with immutable
normalized entry/dependency pins. Optional manifest-file provenance is checked against
registered bytes, hash and typed manifest content. The intrinsic manifest is authored
through structured fields; external JSON preparation is optional. Publisher, capability
and signature claims are unverified metadata. An absent signature is `unsigned`.
Hash agreement identifies bytes, not publisher trust or redistribution permission.
Executable entry types and requested authority are rejected; recipe IDs/digests are
inert references and never modify the approved-recipe registry.

Install, adopt and disable require `design.edit`. `catalog_pack.install` explicitly chooses an exact registered version. Registration
does not update an installed version. Install decisions can upgrade or downgrade;
they preserve every previous manifest and decision. Unsupported contract versions are
inspectable but cannot be installed/adopted. A disable decision stops new adoption
until an explicit install selects an enabled version again.

`catalog_pack.adopt` requires the exact enabled version, explicit entry selection,
review basis and expected state. Exact dependency versions must already be enabled in
this workspace. Content/profile entries create distinct new workspace definitions and
editable drafts through the shared design service. All selected entries, full source
closure and typed copy rules are checked before any materialization;
the whole batch rolls back on an unsupported copy. Source UUIDs are never remapped to
bypass constraints. Profiles created from any project of the workspace are ordinary
library items and copy with their typed rules.
Rule/model files and recipe references can be adopted as inert, unparsed, unexecuted
references; this does not implement their discipline-specific interpretation engines.

Immutable adoption rows retain the exact originating version, entry, source revision,
local identity/draft and initial content. Provenance lives outside engineering content,
so strict typed payloads remain valid. The shared design hooks authorize origin closure
and add source revision/dependency pins after validating normal typed capture inputs.
Copying does not freeze or qualify a new draft. User review/freezing remains explicit.
Later edits, updates, downgrade and disable do not rewrite old consumers or adoption
history. Disabling a pack does not revoke legitimate access to prior adopted state.

Pack decisions are append-only with a database sequential-version guard and row-lock
compare-and-set (`pack-v0`, `pack-v1`, …). Shared executor idempotency is scoped by
actor/workspace/operation. Current authority covers all retained manifest versions,
dependency versions and source files before reads, replay or conflict diagnostics.
Dependency inserts are serialized and checked for cycles at the database boundary.
Each materialized definition and draft has a unique retained adoption origin; content
and profiles require a draft result while rule/model/recipe entries remain inert.
Dependency inspection has a declared 2,000-version closure bound. Adoption origins
have a 32-record recursive-depth and 2,000-unique-record bound; cycle/depth failures
reset their traversal context before the next request. `GET
/api/v0/catalog-packs/packs` and `/source-files` list the workspace's packs and registered
files; cursors must be rows of the same workspace query. Later edits of an adopted draft
never change the version read or its retained initial content.

The browser exposes structured registration, exact revision/file/dependency selectors,
version inspection, explicit install/downgrade/adoption/disable review forms and retained
decision/provenance history. Current access is refreshed before continuing retained
selections after denial. Capability acceptance still requires the integrated browser
checkpoint. External catalog-format converters, signature verification, model/rule
interpretation engines, executable extension/tool-pack installation and cross-workspace
import are further supported-format work, not implied by registration.
