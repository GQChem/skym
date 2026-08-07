import fs from "node:fs";
import path from "node:path";
import type { ChartKind, ChartPoint } from "./chart.js";

export interface DataSelection {
  points: ChartPoint[];
  labelColumn: string;
  valueColumn: string;
  totalRows: number;
}

type Row = Record<string, unknown>;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

function csvRows(text: string, delimiter: string): Row[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); records.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); records.push(row); }
  const headers = records.shift()?.map((value, i) => value.trim() || `column_${i + 1}`) ?? [];
  return records
    .filter((values) => values.some((value) => value.trim()))
    .map((values) => Object.fromEntries(headers.map((header, i) => [header, values[i]?.trim() ?? ""])));
}

function readRows(file: string): Row[] {
  const stat = fs.statSync(file);
  if (stat.size > MAX_SOURCE_BYTES) throw new Error("Data source exceeds 10 MB; aggregate it before charting.");
  const text = fs.readFileSync(file, "utf8");
  if (path.extname(file).toLowerCase() === ".json") {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      if (!parsed.every((value) => value && typeof value === "object" && !Array.isArray(value))) {
        throw new Error("JSON data must be an array of objects.");
      }
      return parsed as Row[];
    }
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed as Record<string, unknown>).map(([label, value]) => ({ label, value }));
    }
    throw new Error("JSON data must be an array of objects or an object mapping labels to values.");
  }
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", "\t", ";"].sort((a, b) => first.split(b).length - first.split(a).length)[0]!;
  return csvRows(text, delimiter);
}

const numeric = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function reducePoints(points: ChartPoint[], kind: ChartKind, limit: number): ChartPoint[] {
  if (kind === "stat") return [points[points.length - 1]!];
  if (points.length <= limit) return points;
  if (kind === "bar") {
    const selected = new Set(points
      .map((point, index) => ({ index, magnitude: Math.abs(point.value) }))
      .sort((a, b) => b.magnitude - a.magnitude)
      .slice(0, limit)
      .map(({ index }) => index));
    return points.filter((_, index) => selected.has(index));
  }
  const indices = Array.from({ length: limit }, (_, i) => Math.round((i * (points.length - 1)) / (limit - 1)));
  return indices.map((index) => points[index]!);
}

/** Read local tabular data and return only the small visual projection uploaded to skym. */
export function dataPointsFromFile(
  file: string,
  options: { labelColumn?: string; valueColumn?: string; kind: ChartKind; maxPoints?: number },
): DataSelection {
  const ext = path.extname(file).toLowerCase();
  if (![".csv", ".tsv", ".json"].includes(ext)) throw new Error("Data source must be CSV, TSV, or JSON.");
  const rows = readRows(file);
  if (!rows.length) throw new Error("Data source contains no rows.");
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const valueColumn = options.valueColumn ?? columns.find((column) => rows.some((row) => numeric(row[column]) !== null));
  if (!valueColumn || !columns.includes(valueColumn)) throw new Error("Could not find the requested numeric value column.");
  const labelColumn = options.labelColumn ?? columns.find((column) => column !== valueColumn) ?? valueColumn;
  if (!columns.includes(labelColumn)) throw new Error("Could not find the requested label column.");

  const points = rows.flatMap((row, index) => {
    const value = numeric(row[valueColumn]);
    if (value === null) return [];
    const rawLabel = row[labelColumn];
    return [{ label: String(rawLabel ?? index + 1), value }];
  });
  if (!points.length) throw new Error(`Column "${valueColumn}" contains no numeric values.`);
  const limit = Math.max(2, Math.min(12, options.maxPoints ?? 12));
  return { points: reducePoints(points, options.kind, limit), labelColumn, valueColumn, totalRows: rows.length };
}
