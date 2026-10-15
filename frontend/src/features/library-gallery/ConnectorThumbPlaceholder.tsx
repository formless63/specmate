/**
 * Stand-in for `ConnectorFace` from the connector-art package until it lands: same intent
 * (a connector seen from its mating face, contacts marked by role), deliberately plain.
 * It draws only recorded contacts on a neutral grid or ring; it never guesses a real
 * connector's physical layout. Replace the import with `ConnectorFace` when available.
 */
export type ContactMark = "signal" | "return" | "must-not-connect" | "unknown" | "shell" | "plain";
export type ConnectorThumbContact = { contactId: string; label: string; mark: ContactMark };

export function ConnectorThumbPlaceholder({ family, contacts, title }: {
  /** Recorded family or standard, shown as text only. */
  family: string | null;
  contacts: ConnectorThumbContact[];
  title: string;
}) {
  const pins = contacts.filter((contact) => contact.mark !== "shell").slice(0, 40);
  const shell = contacts.some((contact) => contact.mark === "shell");
  const ring = pins.length > 0 && pins.length <= 12;
  const cols = ring ? 0 : Math.min(Math.ceil(Math.sqrt(pins.length * 2)), 14);
  const rows = ring || cols === 0 ? 0 : Math.ceil(pins.length / cols);
  const place = (index: number): [number, number] => {
    if (ring) {
      const angle = (index / pins.length) * Math.PI * 2 - Math.PI / 2;
      return [120 + Math.cos(angle) * 34, 60 + Math.sin(angle) * 34];
    }
    const col = index % cols, row = Math.floor(index / cols);
    const pitch = Math.min(150 / Math.max(cols, 1), 16);
    return [120 - ((cols - 1) * pitch) / 2 + col * pitch, 60 - ((rows - 1) * pitch) / 2 + row * pitch];
  };
  return <svg viewBox="0 0 240 120" role="img" aria-label={title} className="lg-thumb-svg">
    {ring
      ? <circle cx={120} cy={60} r={48} className={`lg-conn-body${shell ? " lg-conn-shell" : ""}`} />
      : <rect x={30} y={18} width={180} height={84} rx={8} className={`lg-conn-body${shell ? " lg-conn-shell" : ""}`} />}
    {pins.map((pin, index) => {
      const [x, y] = place(index);
      return <g key={pin.contactId} data-contact={pin.contactId} data-mark={pin.mark}>
        <circle cx={x} cy={y} r={ring ? 6 : 4.5} className={`lg-pin lg-pin-${pin.mark}`} />
        {ring && <text x={x} y={y + 2.5} textAnchor="middle" className="lg-pin-label">{pin.label.slice(0, 3)}</text>}
      </g>;
    })}
    {pins.length === 0 && <text x={120} y={64} textAnchor="middle" className="lg-thumb-note">no contacts recorded</text>}
    {family && <text x={120} y={114} textAnchor="middle" className="lg-thumb-caption">{family.slice(0, 32)}</text>}
  </svg>;
}
