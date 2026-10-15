import { expect, test } from "vitest";
import { toCsv, toXlsx, zipStored } from "../../../../packages/docs/src/table";

/** Inspect ZIP entry headers independently of the writer; no archive execution. */
function entries(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder();
  const result = new Map<string, string>(); let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    expect(view.getUint16(offset + 8, true)).toBe(0);
    const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    result.set(name, decoder.decode(bytes.subarray(start, start + length)));
    offset = start + length;
  }
  expect(view.getUint32(offset, true)).toBe(0x02014b50);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  expect(view.getUint16(end + 10, true)).toBe(result.size);
  expect(view.getUint32(end + 16, true)).toBe(offset);
  return result;
}

test("CSV preserves nullable quantities and escapes formula-like authored text and RFC4180 fields", () => {
  expect(toCsv({ headers: ["Description", "Quantity"], rows: [
    ["Red, white", 2], ['A "quoted" part', null], ["=SUM(1)", 0], [" -SUM(1)", -2], ["one\ntwo", 1],
  ] })).toBe('Description,Quantity\r\n"Red, white",2\r\n"A ""quoted"" part",unknown\r\n\'=SUM(1),0\r\n\' -SUM(1),-2\r\n"one\ntwo",1\r\n');
});

test("XLSX carries explicit unknowns and formula-like text as inert strings with deterministic sheets", () => {
  const terminal = "端子/β:07 🎛";
  const table = { name: 'Landings/one', headers: ["Target", "Quantity"], rows: [["<pad>&", null], ["=SUM(9)", 0], [terminal, 2]] };
  const first = toXlsx([table, { ...table, name: 'Landings:one' }]);
  expect(first).toEqual(toXlsx([table, { ...table, name: 'Landings:one' }]));
  const files = entries(first), sheet = files.get("xl/worksheets/sheet1.xml")!;
  expect(files.size).toBe(6);
  expect(files.get("xl/workbook.xml")).toContain('name="Landings-one"');
  expect(files.get("xl/workbook.xml")).toContain('name="Landings-one 2"');
  expect(sheet).toContain("&lt;pad&gt;&amp;");
  expect(sheet).toContain(terminal);
  expect(toCsv({ headers: ["Exact terminal ID"], rows: [[terminal]] })).toBe(`Exact terminal ID\r\n${terminal}\r\n`);
  expect(sheet).toContain('r="B2" t="inlineStr"><is><t xml:space="preserve">unknown</t>');
  expect(sheet).toContain('r="B3"><v>0</v>');
  expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">=SUM(9)</t>');
  expect(sheet).not.toContain("<f>");
  expect([...files.values()].join("")).not.toContain("externalLink");
});

test("stored archives have standard CRC32 and fixed timestamps, and unsupported workbook sizes fail explicitly", () => {
  const zipped = zipStored([{ name: "original.txt", data: new TextEncoder().encode("123456789") }]);
  const view = new DataView(zipped.buffer);
  expect(view.getUint32(14, true)).toBe(0xcbf43926);
  expect(view.getUint16(10, true)).toBe(0);
  expect(view.getUint16(12, true)).toBe(33);
  expect(entries(zipped).get("original.txt")).toBe("123456789");
  expect(() => toXlsx([])).toThrow("table limits");
  expect(() => toXlsx([{ name: "Too large", headers: ["row"], rows: Array.from({ length: 10001 }, () => [1]) }])).toThrow("table limits");
});
