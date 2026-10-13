# Layered wire display geometry

The pure `src/model.ts` consumes the existing section projection, an explicit preview
length, and a separate display profile. Every piece retains its material element path.
Cuts are per element and end, measured back from each tip. Missing configured cuts or
lead dimensions remain unresolved; absent element rules mean an unprepared element.
Profile targets absent from stock are reported rather than silently remapped.

Screen and drain leads remain separate. Their diameter, axial reach, radial reach and
angle are explicit illustration parameters, not derived metallic area or physical lead
length. This geometry creates no electrical bonds and asserts no clearance, fit,
manufacturing validity, stock quantity or physical qualification. Unknown construction
remains in the section table; the renderer does not manufacture dimensions for it.

Known enclosing opaque layers can suppress hidden interior mesh spans. The cut faces
remain and artificial interior clipping faces have no caps. Explicit hidden paths affect
only the display and do not delete stock. Flat webs retain rectangular extrusion.

An optional `illustrationLay` uses a positive axial period and an independently declared
`positive` or `negative` rotation. Positive follows the right-hand rule about display +x
as x increases; phase is zero at end A, including when end material is cut away. Stock
ring placement direction is never interpreted as twist handedness. This first projection
supports round pair/bundle constructions only, with a single global rotation about the
display axis. It does not model nested engineering lays, ribbons, figure-eight sections
or webs. Unknown construction, period or direction retains the straight depiction with
an explicit status. Existing frozen profiles without direction remain unknown.

Sampling uses 24 segments per turn, at most 256 segments per displayed piece and 16,384
total centerline segments. A period requiring more samples is refused before allocating
curves, not clamped to an aliased coarse helix. More than one million turns over the full
preview is also refused to bound phase arithmetic. Unresolved, invalid and over-budget
requests retain the entire straight model. Cut intervals, identities and occlusion caps
are retained; screen lead anchors lie on their rotated annular cap plane, preserving the
lip radius. Entirely occluded body anchors use the known centerline tangent. Lead display
extent remains an illustration parameter, not a physical length or a manufacturing claim.

`prepend_cut_mm` remains a stored, inspectable suggestion that this renderer does not
apply: its manufacturing meaning is not defined by this geometry contract. It is not
silently treated as strip-back, slid insulation or an additional material allowance.

`src/scene.ts` adapts the AGPL WireHub annular sweep: parallel-transport frames, inward
bore walls, outward shells, and separately normaled ring/disk caps. Resource disposal is
idempotent. It is imported only by the lazy viewport and geometry tests; the pure model
does not import Three.js. See the repository NOTICE for precise provenance.

The stock panel's current preview profile is browser-local. Persisted versioned workshop
profiles are a separate record boundary. The viewport loads on request, renders on
interaction/resize/model changes, and disposes meshes, materials, controls and WebGL on
close. No animation loop, textures, external model assets or fonts are required.
