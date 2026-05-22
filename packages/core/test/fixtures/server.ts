import { createServer } from 'node:http';
import type { Server } from 'node:http';

const LOGIN_PAGE = `<!DOCTYPE html>
<html>
<head><title>Login</title></head>
<body>
  <div id="root" role="main" class="app">
    <form id="login-form" role="form" class="auth-form">
      <label for="email">Email address</label>
      <input id="email" type="email" placeholder="Enter email" data-testid="email-input" />
      <label for="password">Password</label>
      <input id="password" type="password" placeholder="Enter password" data-testid="password-input" />
      <button id="submit" type="submit" class="btn primary" role="button" data-testid="submit-btn">Log in</button>
    </form>
  </div>
</body>
</html>`;

const DASHBOARD_PAGE = `<!DOCTYPE html>
<html>
<head><title>Dashboard</title></head>
<body>
  <div id="root" role="main" class="app">
    <h1 data-testid="dashboard" class="greeting">Welcome back</h1>
    <nav role="navigation">
      <a href="/login" data-testid="logout-link">Log out</a>
    </nav>
  </div>
</body>
</html>`;

const MUTATED_LOGIN_PAGE = `<!DOCTYPE html>
<html>
<head><title>Login</title></head>
<body>
  <div id="root" role="main" class="app">
    <form id="signin-form" role="form" class="auth-form-v2">
      <label for="email">Email</label>
      <input id="email-field" type="email" placeholder="Your email" data-testid="email-input" />
      <label for="password">Password</label>
      <input id="password-field" type="password" placeholder="Your password" data-testid="password-input" />
      <button id="signin" type="submit" class="btn-new primary-v2" role="button" data-testid="signin-btn">Sign in</button>
    </form>
  </div>
</body>
</html>`;

export function startFixtureServer(
  options: { mutated?: boolean } = {},
): Promise<{ server: Server; port: number; baseUrl: string }> {
  return new Promise((resolve) => {
    const loginHtml = options.mutated ? MUTATED_LOGIN_PAGE : LOGIN_PAGE;

    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');

      if (req.url === '/login' || req.url === '/') {
        res.end(loginHtml);
      } else if (req.url === '/dashboard') {
        res.end(DASHBOARD_PAGE);
      } else {
        res.statusCode = 404;
        res.end('<h1>Not Found</h1>');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
      }
    });
  });
}
