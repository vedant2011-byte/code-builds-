import { build } from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['worker/src/index.ts'],
  outfile: 'worker/dist/index.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'],
  sourcemap: false,
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(options);
  await ctx.watch();
  console.log('Worker build watching…');
} else {
  await build(options);
  console.log('Worker bundled to worker/dist/index.js');
}
