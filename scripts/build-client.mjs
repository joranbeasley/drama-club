// Bundles client/main.ts (and mobile-nodemap) into public/app.js. --watch rebuilds on change.
import { context } from 'esbuild';

const watch = process.argv.includes('--watch');
const ctx = await context({
  entryPoints: ['client/main.ts'],
  outfile: 'public/app.js',
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: !watch,
  sourcemap: true,
  logLevel: 'info',
});
if (watch) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}
