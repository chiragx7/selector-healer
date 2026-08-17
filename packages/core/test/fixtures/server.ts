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

const AUTH_GATED_PAGE = `<!DOCTYPE html>
<html>
<head><title>Auth Gate</title></head>
<body>
  <div id="root" role="main" class="app">
    <div id="login-gate">
      <input id="token" type="text" placeholder="Enter token" data-testid="token-input" />
      <button id="unlock" type="button" data-testid="unlock-btn">Unlock</button>
    </div>
    <div id="protected" style="display:none">
      <h1 data-testid="secret-content" class="secret">Secret Dashboard</h1>
      <p class="auth-info" role="status">Authenticated content visible</p>
    </div>
  </div>
  <script>
    document.getElementById('unlock').addEventListener('click', function() {
      document.getElementById('protected').style.display = 'block';
      document.getElementById('login-gate').style.display = 'none';
    });
  </script>
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
      } else if (req.url === '/home-redirect') {
        // A canonical redirect: '/home-redirect' 302s to '/dashboard'. Used to prove
        // capture stores the FINAL url and heal's same-page check tolerates it.
        res.statusCode = 302;
        res.setHeader('Location', '/dashboard');
        res.end();
      } else if (req.url === '/auth-gate') {
        res.end(AUTH_GATED_PAGE);
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
