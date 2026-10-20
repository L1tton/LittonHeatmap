import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/wallpaper');
const port = Number(process.env.PORT || 5180);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
    const target = path.resolve(root, `.${urlPath === '/' ? '/index.html' : urlPath}`);
    if (!target.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(target, (err, data) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': types[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`Wallpaper preview: http://127.0.0.1:${port}/`);
  });
