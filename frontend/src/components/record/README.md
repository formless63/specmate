# RecordPage

A shared drawing-first frame. The domain controller owns the selected exact
revision or draft, unsaved buffers, concurrency tokens, authority, operations and
exports. This component has no data reads or writes.

Pass compact `identity` and a `RecordState` (`new`, `draft` with version/dirty, or
`revision` with exact ID/number). `actions`, `revisions`, `facts` and `notice` are
optional slots; facts need not become a second full-width header.

`views` are controlled by `view`/`onView`. Panels stay mounted: expensive renderers
must receive their own visibility guard and dispose contexts when inactive.
`inspector` entries have lazy `content` functions; visited entries stay mounted so
local form buffers survive tab changes. Optional controlled inspector selection is
available. `RecordSections` discloses secondary information inside that bounded
inspector instead of adding a mandatory page stack.

`active` is required. It closes the phone inspector portal when a retained record
is hidden. It does not authorize data: controllers must withdraw current content
after read denial and recheck authority when revealed. Reset controller instances
at principal/workspace authority boundaries.
