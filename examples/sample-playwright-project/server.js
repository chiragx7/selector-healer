import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');

const PAGES = {
  '/': 'index.html',
  '/login': 'index.html',
  '/dashboard': 'dashboard.html',
  '/profile': 'profile.html',
  '/settings': 'settings.html',
  '/signup': 'signup.html',
};

function serve(res, file, status = 200) {
  try {
    const content = readFileSync(join(PUBLIC, file), 'utf8');
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const page = PAGES[url.pathname];

  if (page) {
    serve(res, page);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

const port = process.env.PORT ?? 3456;
server.listen(port, () => {
  process.stdout.write(`Sample app running at http://localhost:${port}\n`);
});
