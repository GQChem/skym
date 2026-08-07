import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dataPointsFromFile } from "../dist/data.js";

const temp = (name, body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skym-data-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
};

test("reads CSV columns without putting the dataset in tool arguments", () => {
  const file = temp("bench.csv", "build,p99\nbefore,840\nafter,190\n");
  const out = dataPointsFromFile(file, { kind: "bar", labelColumn: "build", valueColumn: "p99" });
  assert.deepEqual(out.points, [{ label: "before", value: 840 }, { label: "after", value: 190 }]);
  assert.equal(out.totalRows, 2);
});

test("reads a JSON label-to-value mapping", () => {
  const file = temp("counts.json", JSON.stringify({ alpha: 3, beta: 7 }));
  assert.deepEqual(dataPointsFromFile(file, { kind: "bar" }).points, [
    { label: "alpha", value: 3 }, { label: "beta", value: 7 },
  ]);
});

test("line data is sampled with both endpoints", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ step: `s${i}`, value: i }));
  const out = dataPointsFromFile(temp("trend.json", JSON.stringify(rows)), { kind: "line", maxPoints: 5 });
  assert.equal(out.points.length, 5);
  assert.equal(out.points[0].label, "s0");
  assert.equal(out.points.at(-1).label, "s19");
});

test("bar reduction keeps the largest magnitudes", () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ name: `n${i}`, value: i }));
  const out = dataPointsFromFile(temp("bars.json", JSON.stringify(rows)), { kind: "bar", maxPoints: 3 });
  assert.deepEqual(out.points.map((point) => point.value), [12, 13, 14]);
});
