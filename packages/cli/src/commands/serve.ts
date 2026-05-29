import { watch } from 'node:fs';
import { createServer } from 'node:http';
import { loadFingerprints, parseDirectory } from '@selector-healer/core';
import type { HealerConfig, SelectorUsage } from '@selector-healer/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { loadConfig } from '../config.js';

const DEFAULT_PORT = 7400;
const DEBOUNCE_MS = 300;

interface ServerMessage {
  type: 'selectors' | 'fingerprints' | 'update';
  // biome-ignore lint/suspicious/noExplicitAny: JSON serialized data varies by message type
  data: any;
}

export function registerServe(program: Command): void {
  program
    .command('serve')
    .description('Start a WebSocket server for the Chrome extension')
    .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_PORT))
    .option('--no-watch', 'Disable file watching')
    .action(async (opts: { port: string; watch: boolean }) => {
      const cwd = process.cwd();
      const port = Number.parseInt(opts.port, 10);

      let config: HealerConfig;
      try {
        config = await loadConfig(cwd);
      } catch (e) {
        process.stderr.write(`${pc.red('Error:')} ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
        return;
      }

      const clients = new Set<WebSocket>();

      // Initial parse
      let selectors = parseSelectors(config);

      // Load fingerprints
      let fingerprints = loadFingerprintsAsObject(cwd);

      // HTTP + WebSocket server
      const httpServer = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', selectors: selectors.length }));
      });

      const wss = new WebSocketServer({ server: httpServer });

      wss.on('connection', (ws) => {
        clients.add(ws);
        process.stdout.write(`  ${pc.green('+')} Client connected (${clients.size} total)\n`);

        // Send initial data
        send(ws, { type: 'selectors', data: selectors });
        send(ws, { type: 'fingerprints', data: fingerprints });

        ws.on('close', () => {
          clients.delete(ws);
          process.stdout.write(`  ${pc.dim('-')} Client disconnected (${clients.size} total)\n`);
        });

        ws.on('error', () => {
          clients.delete(ws);
        });
      });

      httpServer.listen(port, () => {
        process.stdout.write(
          `\n${pc.bold('Selector Healer')} server running\n\n` +
            `  ${pc.cyan('WebSocket:')} ws://localhost:${port}\n` +
            `  ${pc.cyan('HTTP:')}      http://localhost:${port}\n` +
            `  ${pc.cyan('Selectors:')} ${selectors.length}\n` +
            `  ${pc.cyan('Watching:')}  ${opts.watch ? config.testDir : 'disabled'}\n\n` +
            `  ${pc.dim('Waiting for Chrome extension to connect...')}\n\n`,
        );
      });

      // File watcher
      if (opts.watch) {
        let debounceTimer: ReturnType<typeof setTimeout> | undefined;

        watch(config.testDir, { recursive: true }, (_event, filename) => {
          if (!filename?.endsWith('.ts') && !filename?.endsWith('.tsx')) return;

          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            process.stdout.write(`  ${pc.dim('File changed:')} ${filename}\n`);

            selectors = parseSelectors(config);
            fingerprints = loadFingerprintsAsObject(cwd);

            const msg: ServerMessage = {
              type: 'update',
              data: { selectors, fingerprints },
            };

            for (const client of clients) {
              send(client, msg);
            }

            process.stdout.write(
              `  ${pc.green('Pushed')} ${selectors.length} selectors to ${clients.size} client(s)\n`,
            );
          }, DEBOUNCE_MS);
        });
      }

      // Graceful shutdown
      const shutdown = () => {
        process.stdout.write(`\n  ${pc.dim('Shutting down...')}\n`);
        for (const client of clients) {
          client.close();
        }
        wss.close();
        httpServer.close();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function parseSelectors(config: HealerConfig): SelectorUsage[] {
  const result = parseDirectory(config.testDir, config.testGlob);
  if (result.isErr()) return [];
  return result.value.selectors;
}

function loadFingerprintsAsObject(projectRoot: string): Record<string, unknown> {
  const result = loadFingerprints(projectRoot);
  if (result.isErr()) return {};

  const obj: Record<string, unknown> = {};
  for (const [key, value] of result.value) {
    obj[key] = value;
  }
  return obj;
}
