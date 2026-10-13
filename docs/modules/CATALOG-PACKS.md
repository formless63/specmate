# Catalog pack adoption

Catalog packs are inert, versioned project content. A typed manifest records package
identity, publisher and capability claims, contract compatibility, declared rights,
signature claims, exact dependency versions and up to 100 entries. Entries identify
content, workshop profiles, rule/model files or recipe references. Engineering pins
include an exact revision and snapshot hash; registered files include exact bundle
revision, path, hash and declared rights. Labels, paths and rights preserve whitespace.

`catalog_pack.register` stores canonical manifest bytes and their hash, with immutable
normalized entry/dependency pins. Optional manifest-file provenance is checked against
registered bytes, hash and typed manifest content. The intrinsic manifest is authored
through structured fields; external JSON preparation is optional. Publisher, capability
and signature claims are unverified metadata. An absent signature is `unsigned`.
Hash agreement identifies bytes, not publisher trust or redistribution permission.
Executable entry types and requested authority are rejected; recipe IDs/digests are
inert references and never modify the approved-recipe registry.

`catalog_pack.install` explicitly chooses an exact registered version. Registration
does not update an installed version. Install decisions can upgrade or downgrade;
they preserve every previous manifest and decision. Unsupported contract versions are
inspectable but cannot be installed/adopted. A disable decision stops new adoption
until an explicit install selects an enabled version again.

`catalog_pack.adopt` requires the exact enabled version, explicit entry selection,
review basis and expected state. Exact dependency versions must already be enabled in
the owning project. Content/profile entries create distinct new local definitions and
editable drafts through the shared design service. All selected entries, full source
closure and owning-type/project copy rules are checked before any materialization;
the whole batch rolls back on an unsupported copy. Source UUIDs are never remapped to
bypass constraints. Cross-project workshop profiles whose stock belongs to another
project therefore cannot be copied. Same-project typed profiles preserve their rules.
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
actor/project/operation. Current authority covers all retained manifest versions,
dependency versions and source files before reads, replay or conflict diagnostics.
Dependency inspection has a declared 2,000-version closure bound. Inaccessible packs
are skipped in lists without private counts; cursors must remain authorized in the same
project query. Adoption consumers are separately filtered by their current complete
draft closure, so a private edited consumer cannot poison an authorized source-version
read or reveal its identity through history.

The browser exposes structured registration, exact revision/file/dependency selectors,
version inspection, explicit install/downgrade/adoption/disable review forms and retained
decision/provenance history. Current access is refreshed before continuing retained
selections after denial. Capability acceptance still requires the integrated browser
checkpoint. External catalog-format converters, signature verification, model/rule
interpretation engines, executable extension/tool-pack installation and cross-project
dependency installation are further supported-format work, not implied by registration.
