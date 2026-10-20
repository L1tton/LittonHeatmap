import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'web');
const output = path.join(root, 'dist', 'wallpaper');
const manifestPath = path.join(source, 'data', 'manifest.json');

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function main() {
  let manifest;
  try {
    manifest = await readJson(manifestPath);
  } catch {
    throw new Error(
      `缺少 ${path.relative(root, manifestPath)}。请先在网页版同步/导入数据，再运行本脚本。`,
    );
  }

  const years = (manifest.years || []).filter((entry) => entry.file && entry.count > 0);
  if (!years.length) throw new Error('manifest.json 里没有可用的轨迹年份');

  const features = [];
  for (const entry of years) {
    const file = path.join(source, 'data', entry.file);
    let collection;
    try {
      collection = await readJson(file);
    } catch {
      throw new Error(`缺少轨迹文件 ${path.relative(root, file)}`);
    }
    if (!Array.isArray(collection.features)) {
      throw new Error(`${entry.file} 不是有效的 GeoJSON FeatureCollection`);
    }
    features.push(...collection.features);
  }
  if (!features.length) throw new Error('轨迹数据为空，无法生成壁纸');

  const dataset = {
    manifest,
    features,
    user: manifest.user || { name: 'L1tton' },
  };

  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  await fs.cp(path.join(source, 'assets'), path.join(output, 'assets'), { recursive: true });

  // Bundle the ES modules into one classic script so local file:// loading
  // does not depend on Chromium's module CORS rules.
  await build({
    entryPoints: [path.join(source, 'assets', 'app.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome100'],
    outfile: path.join(output, 'assets', 'app.js'),
    logLevel: 'silent',
  });

  let html = await fs.readFile(path.join(source, 'index.html'), 'utf8');
  const appTag = '<script src="assets/app.js" type="module"></script>';
  if (!html.includes(appTag)) throw new Error('index.html 中找不到 app.js 入口');
  html = html.replace(appTag, '<script src="assets/app.js"></script>');
  html = html.replace(
    '<script src="assets/app.js"></script>',
    `    <script src="wallpaper-data.js"></script>\n    <script src="assets/app.js"></script>`,
  );

  await fs.writeFile(
    path.join(output, 'wallpaper-data.js'),
    `window.__WALLPAPER_DATA__ = ${JSON.stringify(dataset)};\n`,
    'utf8',
  );
  await fs.writeFile(path.join(output, 'index.html'), html, 'utf8');

  console.log(`已生成 ${path.relative(root, output)}`);
  console.log(`轨迹 ${features.length} 条，${manifest.stats?.distanceKm ?? '?'} km`);
  console.log('Wallpaper Engine：把 dist/wallpaper/index.html 拖入 Create Wallpaper');
}

main().catch((err) => {
  console.error(`构建失败：${err.message}`);
  process.exitCode = 1;
});
