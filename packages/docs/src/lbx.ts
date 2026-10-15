// SPDX-License-Identifier: AGPL-3.0-only
/** Adapted from WireHub packages/docs/src/exports/lbx.ts,
 * cbf919edf30a9d906a791971d3a40e22cb78b67e, formless63.
 * Explicit generic P-touch 80 × 12 mm text-only layout. Printer compatibility unverified. */
import { escapeXml, type Label } from "./model";
import { zipStored } from "./table";

const encoder = new TextEncoder();
const xmlns = "http://schemas.brother.info/ptouch/2007/lbx/";
/** One inert UTF-8 label, preserving authored Unicode. Fixed layout, no clocks or private fonts. */
export function labelLbx(label: Label): Uint8Array {
  const labelXml = `<?xml version="1.0" encoding="UTF-8"?><pt:document xmlns:pt="${xmlns}main" xmlns:style="${xmlns}style" xmlns:text="${xmlns}text" version="1.7" generator="Specmate"><pt:body currentSheet="Sheet 1" direction="LTR"><style:sheet name="Sheet 1"><style:paper media="0" width="34pt" height="226.8pt" marginLeft="5.6pt" marginTop="5.6pt" marginRight="5.6pt" marginBottom="5.6pt" orientation="landscape" autoLength="false" monochromeDisplay="true" paperColor="#FFFFFF" paperInk="#000000" printerID="0" printerName="Brother P-touch"/><pt:objects><text:text><pt:objectStyle x="5.6pt" y="5.6pt" width="215.6pt" height="22.8pt" angle="0" anchor="TOPLEFT" flip="NONE"/><text:ptFontInfo><text:logFont name="Arial" width="0" italic="false" weight="400" charSet="0" pitchAndFamily="2"/><text:fontExt effect="NOEFFECT" underline="0" strikeout="0" size="10pt" orgSize="10pt" textColor="#000000" textPrintColorNumber="1"/></text:ptFontInfo><text:textControl control="LONGTEXTFIXED" clipFrame="false" shrink="true" autoLF="false"/><text:textAlign horizontalAlignment="LEFT" verticalAlignment="CENTER"/><text:textStyle vertical="false" nullBlock="false" charSpace="0" lineSpace="0" orgPoint="10pt"/><pt:data>${escapeXml(label.text)}</pt:data></text:text></pt:objects></style:sheet></pt:body></pt:document>`;
  const props = `<?xml version="1.0" encoding="UTF-8"?><meta:properties xmlns:meta="${xmlns}meta" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><meta:appName>Specmate</meta:appName><dc:title>${escapeXml(label.text)}</dc:title><dc:subject>${escapeXml(label.id)}</dc:subject><dc:description>Authored label · ${escapeXml(label.context)} · ${escapeXml(label.at)}. Generic 80 × 12 mm layout; verify in P-touch Editor before printing.</dc:description><dcterms:created>2000-01-01T00:00:00Z</dcterms:created><dcterms:modified>2000-01-01T00:00:00Z</dcterms:modified></meta:properties>`;
  return zipStored([{ name: "label.xml", data: encoder.encode(labelXml) }, { name: "prop.xml", data: encoder.encode(props) }]);
}
/** Numeric archive names cannot collide or lose authored identifiers, which remain in XML. */
export function labelsLbx(labels: readonly Label[]): Uint8Array {
  if (labels.length > 1000 || !labels.length) throw new Error("Choose 1 to 1000 authored labels.");
  return zipStored(labels.map((label, index) => ({ name: `label-${index + 1}.lbx`, data: labelLbx(label) })));
}
