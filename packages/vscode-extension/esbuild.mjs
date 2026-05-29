import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode', 'playwright', 'playwright-core', 'chromium-bidi', 'cosmiconfig'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  treeShaking: true,
};

await esbuild.build(config);
