import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

async function copyStatic() {
  await cp('src/manifest.json', `${outdir}/manifest.json`);
}

const options = {
  entryPoints: {
    background: 'src/background.ts',
  },
  outdir,
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  plugins: [{ name: 'static', setup: (b) => b.onEnd(copyStatic) }],
};

if (watch) {
  await (await esbuild.context(options)).watch();
} else {
  await esbuild.build(options);
}
