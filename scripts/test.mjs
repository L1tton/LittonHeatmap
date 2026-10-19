#!/usr/bin/env node
/** Small assertion suite for the geo/GPX helpers: npm test */
import assert from 'node:assert/strict';
import FitParser from '../web/assets/vendor/fit-parser.js';
import { parseGpx, GpxParseError } from './lib/gpx.mjs';
import {
  haversineMeters,
  pathLengthMeters,
  simplifyLine,
  wgs84ToGcj02,
  gcj02ToWgs84,
} from './lib/geo.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>晨骑</name><trkseg>
    <trkpt lat="31.23040" lon="121.47370"><ele>10</ele></trkpt>
    <trkpt lon="121.47470" lat="31.23050"><ele>11</ele></trkpt>
    <trkpt lat="31.23100" lon="121.47600"><ele>12</ele></trkpt>
  </trkseg></trk>
</gpx>`;

console.log('GPX 解析');
test('解析两种属性顺序', () => {  const { points } = parseGpx(SAMPLE_GPX);
  assert.equal(points.length, 3);
  assert.deepEqual(points[0], [121.4737, 31.2304]);
  assert.deepEqual(points[1], [121.4747, 31.2305]);
});
test('过滤重复点', () => {
  const xml = SAMPLE_GPX.replace(
    '</trkseg>',
    '<trkpt lat="31.23100" lon="121.47600"></trkpt><trkpt lat="31.23100" lon="121.47600"></trkpt></trkseg>',
  );
  assert.equal(parseGpx(xml).points.length, 3);
});
test('登录页/HTML 明确报错', () => {
  assert.throws(() => parseGpx('<!DOCTYPE html><html><body>登录以后才能导出</body></html>'), GpxParseError);
});
test('空内容报错', () => {
  assert.throws(() => parseGpx(''), GpxParseError);
});

console.log('几何计算');
test('haversine 上海 1km 左右', () => {
  const d = haversineMeters([121.4737, 31.2304], [121.4837, 31.2304]);
  assert.ok(d > 900 && d < 1000, `实际 ${d.toFixed(1)}m`);
});
test('折线长度', () => {
  const pts = [
    [121.4737, 31.2304],
    [121.4837, 31.2304],
    [121.4837, 31.2404],
  ];
  assert.ok(pathLengthMeters(pts) > 1900 && pathLengthMeters(pts) < 2100);
});
test('简化保留端点并减少点数', () => {
  const pts = [];
  for (let i = 0; i < 200; i++) pts.push([121.4 + i * 0.00005, 31.2 + Math.sin(i / 8) * 0.0005]);
  const out = simplifyLine(pts, 5, 1200);
  assert.ok(out.length < pts.length, `简化后 ${out.length}`);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
});
test('maxPoints 硬上限', () => {
  const pts = [];
  for (let i = 0; i < 5000; i++) pts.push([121.4 + i * 0.00001, 31.2 + (i % 7) * 0.0001]);
  const out = simplifyLine(pts, 0.5, 300);
  assert.ok(out.length <= 300, `实际 ${out.length}`);
});

console.log('坐标纠偏');
test('WGS84→GCJ02 北京偏移在合理范围', () => {
  const [lng, lat] = wgs84ToGcj02(116.3913, 39.9075);
  assert.ok(lng > 116.39 && lng < 116.405, `lng=${lng}`);
  assert.ok(lat > 39.9 && lat < 39.915, `lat=${lat}`);
  assert.ok(haversineMeters([116.3913, 39.9075], [lng, lat]) < 800);
});
test('GCJ02→WGS84 往返误差小于 2m', () => {
  const [gLng, gLat] = wgs84ToGcj02(121.4737, 31.2304);
  const [wLng, wLat] = gcj02ToWgs84(gLng, gLat);
  const err = haversineMeters([121.4737, 31.2304], [wLng, wLat]);
  assert.ok(err < 2, `误差 ${err.toFixed(2)}m`);
});
test('境外坐标不纠偏', () => {
  assert.deepEqual(wgs84ToGcj02(2.3522, 48.8566), [2.3522, 48.8566]);
});

console.log('FIT 解析器');
test('浏览器 bundle 可加载', () => {
  assert.equal(typeof FitParser, 'function');
});

console.log(`\n${passed} 项通过`);
