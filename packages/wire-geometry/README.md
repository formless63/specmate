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

`src/scene.ts` adapts the AGPL WireHub annular sweep: parallel-transport frames, inward
bore walls, outward shells, and separately normaled ring/disk caps. Resource disposal is
idempotent. It is imported only by the lazy viewport and geometry tests; the pure model
does not import Three.js. See the repository NOTICE for precise provenance.

The stock panel's current preview profile is browser-local. Persisted versioned workshop
profiles are a separate record boundary. The viewport loads on request, renders on
interaction/resize/model changes, and disposes meshes, materials, controls and WebGL on
close. No animation loop, textures, external model assets or fonts are required.
