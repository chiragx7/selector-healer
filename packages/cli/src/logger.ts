import pino from 'pino';

export function createLogger(verbose: boolean): pino.Logger {
  return pino({
    name: 'selector-healer',
    level: verbose ? 'debug' : 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}
