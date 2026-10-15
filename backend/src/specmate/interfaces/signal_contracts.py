"""Signal sets: a shared, versioned vocabulary of what travels through a contact.

A signal's identity is the exact signal set revision plus its key. Equal names in two
sets are different signals; nothing here merges or substitutes them. Electrical facts on
a signal are declarations with a basis; a missing fact stays explicitly unknown.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import StrictModel
from specmate.contracts import FiniteNumber

SignalKey = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9_.-]{0,79}$")]
Name = Annotated[str, Field(min_length=1, max_length=200)]
Note = Annotated[str, Field(min_length=1, max_length=2000)]

SignalType = Literal[
    "analog_video",
    "sync",
    "analog_audio",
    "digital_audio",
    "power",
    "ground_return",
    "shield",
    "chassis",
    "data",
    "control",
    "other",
    "unknown",
]
RETURN_TYPES = {"ground_return", "shield", "chassis"}


class DeclaredQuantity(StrictModel):
    """A declared value or envelope with its basis; ``unknown`` carries no numbers."""

    status: Literal["known", "unknown"] = "unknown"
    nominal: FiniteNumber | None = None
    minimum: FiniteNumber | None = None
    maximum: FiniteNumber | None = None
    basis: Note | None = None

    @model_validator(mode="after")
    def consistent(self):
        values = (self.nominal, self.minimum, self.maximum)
        if self.status == "unknown":
            if any(v is not None for v in values):
                raise ValueError("An unknown quantity cannot carry values.")
            return self
        if all(v is None for v in values):
            raise ValueError("A known quantity requires a nominal value or limits.")
        if not self.basis:
            raise ValueError("A known quantity requires its basis.")
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("Quantity limits are reversed.")
        if self.nominal is not None:
            if (self.minimum is not None and self.nominal < self.minimum) or (
                self.maximum is not None and self.nominal > self.maximum
            ):
                raise ValueError("Nominal value lies outside its limits.")
        return self


class SignalLevel(DeclaredQuantity):
    unit: Literal["V", "Vpp", "dBu", "dBV", "unknown"] = "unknown"

    @model_validator(mode="after")
    def unit_known(self):
        if self.status == "known" and self.unit == "unknown":
            raise ValueError("A known level requires its unit.")
        return self


class SignalImpedance(DeclaredQuantity):
    unit: Literal["ohm"] = "ohm"

    @model_validator(mode="after")
    def positive(self):
        if any(v is not None and v <= 0 for v in (self.nominal, self.minimum, self.maximum)):
            raise ValueError("Impedance must be positive.")
        return self


class Signal(StrictModel):
    key: SignalKey
    name: Name
    type: SignalType = "unknown"
    # For a return (ground, screen or chassis): the signals it is the return path of.
    return_for: list[SignalKey] = Field(default_factory=list, max_length=100)
    differential_with: SignalKey | None = None
    level: SignalLevel = Field(default_factory=SignalLevel)
    impedance: SignalImpedance = Field(default_factory=SignalImpedance)
    notes: Note | None = None
    basis: Note | None = None


class SignalSet(StrictModel):
    kind: Literal["signal_set"] = "signal_set"
    schema_version: Literal["0.1"] = "0.1"
    description: Note | None = None
    signals: list[Signal] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def consistent(self):
        keys = [s.key for s in self.signals]
        if len(keys) != len(set(keys)):
            raise ValueError("Duplicate signal key.")
        names = [s.name.strip().casefold() for s in self.signals]
        if len(names) != len(set(names)):
            raise ValueError("Signal names must be distinct within one set.")
        by_key = {s.key: s for s in self.signals}
        for signal in self.signals:
            if signal.return_for:
                if signal.type not in RETURN_TYPES:
                    raise ValueError("Only a ground, screen or chassis signal can be a return.")
                if len(set(signal.return_for)) != len(signal.return_for):
                    raise ValueError("Duplicate return relation.")
                for key in signal.return_for:
                    target = by_key.get(key)
                    if target is None or key == signal.key:
                        raise ValueError("A return must name other signals in the same set.")
                    if target.type in RETURN_TYPES:
                        raise ValueError("A return cannot be the return of another return.")
            partner = signal.differential_with
            if partner is not None:
                if partner == signal.key or partner not in by_key:
                    raise ValueError("A differential partner must be another signal in the set.")
                if by_key[partner].differential_with not in (None, signal.key):
                    raise ValueError("Differential partners must name each other.")
        return self


class SignalRef(StrictModel):
    """Exact signal identity: one frozen signal set revision and a key inside it."""

    signal_set_revision_id: UUID
    key: SignalKey


# Which declared signal types each pin role can carry. ``unknown`` and ``other`` never
# assert a role, so they fit anywhere a signal may be; ``unused`` carries none.
ROLE_TYPES = {
    "signal": {
        "analog_video",
        "sync",
        "analog_audio",
        "digital_audio",
        "data",
        "control",
        "other",
        "unknown",
    },
    "power": {"power", "other", "unknown"},
    "return": {"ground_return", "other", "unknown"},
    "shield": {"shield", "chassis", "ground_return", "other", "unknown"},
    "chassis": {"chassis", "shield", "ground_return", "other", "unknown"},
    "unused": set(),
    "unknown": None,
}


def role_accepts(role, signal_type):
    allowed = ROLE_TYPES.get(role)
    return allowed is None or signal_type in allowed
