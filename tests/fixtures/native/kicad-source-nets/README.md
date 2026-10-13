# Original source-net fixture

`original.kicad_sch` is a newly authored standalone schematic with self-contained
one-pin ports and a passive two-pin symbol. It contains no imported library symbol,
predecessor design or external sheet. It is covered by this repository's license.
The independent `expectations.json` describes two distinct reported memberships;
no conduction through the passive symbol is implied.

The isolated KiCad 10.0.6 amd64 CLI probe exported XML version E and matched this
oracle. Moving J2 from the right connection to the left in an independently authored
variant changed its membership as expected. A malformed schematic exited nonzero
without XML. The trusted extraction program matched the same oracle, retained the
original bytes and exact source/XML hashes, and parsed the preserved XML separately.
These are native process checks, not approved runner transport or physical acceptance.

The format is deliberately the observed standalone schematic version 20250114.
Hierarchy, variants and other schematic/XML versions remain unsupported. XML provides
component UUIDs and explicit sheet/unit/pin fields, but no terminal UUID. Composite
terminal IDs include the exact source hash. Repeated references or multiunit pin labels
cannot resolve ambiguous net nodes and remain unknown. No reference-label heuristic
establishes correspondence to board pad UUIDs.
