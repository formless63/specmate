# Selected assembly packages

`DOC-002` exports an exact frozen revision or a stable contextual occurrence as a
portable ZIP containing preserved engineering data and a static local review document.
A package can be inspected without the application or its private parent assembly.
Unknowns and unsupported semantics stay explicit. Export is not native execution,
connectivity evidence, compatibility assessment or physical qualification.

The shared `selected_package.review` and `selected_package.download` operations serve
browser, HTTP, MCP and trusted-job adapters. They require fresh evaluation without an
idempotency key. Download supplies the reviewed manifest SHA-256; a changed review returns
a conflict. No design/source state is changed and no export cache grants disclosure.
Exact immutable input pins and attributable rights declarations are retained in the
package manifest; this module does not create another mutable design or source catalog.

## Selection and authority

An empty occurrence path selects the root revision independently. A nonempty path resolves
stable local IDs within the exact frozen assembly snapshot. Display references, names and
part numbers never identify an occurrence. Addresses in the package are relative to the
selected boundary, and repeated descendants retain separate addresses and exact contextual
firmware assignments. Parent-owned placement of the selected root is not a local placement
claim; its rebased placement remains unknown.

A contextual request rechecks the complete current root design/source authority before
selection diagnostics. Hidden ancestors or siblings can therefore block contextual export;
this does not change existing assembly read policy. An independently authorized standalone
selected revision can still be exported separately. Both operations and the download adapter
refresh actor liveness and authority. An old review hash cannot restore revoked access.

Only the selected exact revision dependency closure and applicable contextual firmware are
embedded. Root/ancestor/sibling contents, parent display labels, external peer names and
unrelated source-bundle members are excluded. Minimal root IDs, snapshot hash and selected
occurrence address retain contextual provenance. A selected dependency that points to a context-external parent or sibling blocks
export as unsupported: frozen dependency pins can flatten that external record’s closure,
so omitting only its root would risk importing unrelated data. Canonical selected snapshots retain their exact original bytes and hashes.

## Boundary meaning

Cable packages carry both exact declared endpoints, body contacts, pinout declarations,
conductor terminal identities and applicable unknown values. Connector, pinout and interface
map declarations are preserved independently. Assembly relationships wholly inside the
selection use relative addresses. Relationships crossing its boundary retain the selected
side's exact feature and relationship kind; the external contract is unknown and omitted.
Ancestor-owned relationship labels are not exported. None of these declarations establishes
that a connector mates, a terminal is physically accessible, or continuity was measured.

Other generalized definition kinds remain exportable as exact inert canonical data with
explicitly limited boundary/native reconstruction support. A preserved native/extension
reference is not a reconstructed native output. Missing boundary interpreters and source
bundle references without an exact file boundary appear in `unresolved`. This delivery does
not replace the accepted generalized manufacturing/document scope with a cable-only format.

## Rights and source files

Private authorized review requires current read authority. Unknown design distribution
rights remain visible. A withheld required design blocks export. Required source bytes are
omitted pending an explicit permitted declaration for that exact file, producing a limited
package that still shows its digest, size, declared rights and minimal provenance.

A rights review identifies `design:<revision UUID>` or
`source:<source revision UUID>:<exact path>`, declares permitted/withheld/unknown, and supplies
a basis for a nonunknown decision. Reviews preserve original source rights metadata; the
application never infers legal permission from an arbitrary license string. Distribution
requires every selected design/file to have an explicit permitted declaration, separate
freeze authority in each owning project, and no unresolved required dependencies/boundaries.
Generation and download do not share, publish, release, or qualify anything.

Exact selected source files retain their original hashes and media types. Source authority
includes blob ownership, derivatives, edit baselines and archive ancestry. Ancestry identities
and manifest hashes provide provenance; entire source manifests and ancestor file lists are
excluded because they can contain unrelated material. Referenced catalog representations
select their exact file rather than every attachment of the design. Required bytes are
verified before inclusion; unavailable, changed or oversized bytes fail the operation.

## Portable format and verification

The `specmate.selected-assembly-package` format, schema version `0.1`, contains:

- `manifest.json`: scope/pins, relative occurrences, boundary declarations, rights reviews,
  exact required source files, unresolved items and the hash/byte inventory of other files.
- `designs/<revision UUID>.json`: unchanged canonical snapshots.
- `sources/<source revision UUID>/<exact path>`: only deliberately permitted required files.
- `review.html`: escaped static HTML with no scripts or remote resources.
- `README.txt`: local inspection and integrity instructions.

The ZIP uses fixed timestamps and sorted entries. The review operation returns a manifest
hash; the download returns an archive digest. The manifest does not attempt to hash itself.
The standard-library-only `verify_files` helper checks file inventory/hashes, canonical
identities, exact required design pins, contextual firmware and source bytes without an
application installation or database. It reports
missing required dependencies and declared limitations, including intentionally omitted
files. A trusted separately retained manifest hash is needed to detect replacement of the
manifest itself; this is byte integrity, not a digital signature or rights certification.

Package preparation is bounded to 2,000 revisions, 4,000 files and 16 MiB of uncompressed
content. Inputs remain inert data; packaging never parses native sources or executes them.
The browser component supplies structured revision/occurrence selection, rights review,
explicit rereview after changes, and a freshly authorized POST download. Denial clears its
retained package/projection until an explicit full authority refresh succeeds.


### Verify an offline ZIP

Obtain the verifier from a trusted Specmate source checkout, separately from the engineering
package being checked. Retain the manifest SHA-256 returned by the authorized package review
through an independent channel. A hash copied from the same untrusted package cannot identify
that reviewed package: an attacker can replace both bytes and their declared hashes.

With Python 3.11 or later and the trusted checkout, run:

```bash
python3 -I -S scripts/verify_selected_package.py selected.zip --manifest-sha256 <retained-manifest-sha256>
```

For a computer without the source checkout, copy the trusted
`backend/src/specmate/selected_packages/verification.py` file separately, then run:

```bash
python3 -I -S verification.py selected.zip --manifest-sha256 <retained-manifest-sha256>
```

Both entry points use only Python's standard library. They require no Specmate, Django,
server, network, native tool, database or third-party Python package. Never execute a
verifier or source obtained from the engineering package under inspection. The verifier
reads ZIP entries into bounded memory; it never extracts files or executes included data.

The command prints one JSON result. Exit `0` means the retained manifest digest matches,
all declared file bytes and supported identity/pin relationships agree, and no declared
required limitation remains. Exit `2` with a JSON result means byte integrity agrees but
required dependencies or supported semantics remain explicitly limited. Exit `1` means
integrity, identity, format or safety verification failed; completeness is then unverified.
Missing CLI arguments also return `2`, accompanied by usage text rather than a JSON result.
`manifest_identity` reports whether the independently supplied digest matched. The internal
`verify_files` compatibility helper still allows an omitted digest for consistency checks;
that mode cannot identify a previously reviewed package.

ZIP verification rejects duplicate or case-colliding paths, traversal, absolute/drive or
unnormalized paths, file/directory collisions, symlinks and other special entries, directories,
encryption, unsupported compression and malformed metadata. Only stored or deflated,
single-disk ZIPs within 20 MiB compressed, 16 MiB uncompressed and 4,000 files are supported;
ZIP64 and excessive JSON nesting are rejected. Hash/size checks cover the exact inventory,
canonical snapshots, dependency closure, relative occurrences, recognized declarative source
pins and source ancestry identities/digests. Missing source bytes remain visible even when
intentionally omitted for rights. Included sources require attributable permitted declarations;
this checks the declaration's consistency, not legal permission.

Verification covers this versioned selected-package family. Context-external parent data is
not reconstructed: retained root/context pins and assignment declarations are manifest
provenance. An omitted root/context record cannot be reconstructed or authenticated offline;
its retained identity and digest are pins only, relative to the independently retained
manifest hash. Unknown geometry, boundary meaning, extension formats and unavailable native
interpretation remain explicit. Passing verification authenticates no publisher, certifies
no distribution rights, compiles or flashes no firmware, and provides no manufacturing,
compatibility, continuity or physical qualification. General portable output and release
qualification retain their accepted broader scope.

The standalone adversarial and isolated-Python CLI tests can run without an application:

```bash
python3 -I -S tests/portable/test_verification.py
```
