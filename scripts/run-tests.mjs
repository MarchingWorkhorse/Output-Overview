import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
run({
  files: [path.join(dir, 'stats-engine.test.js')],
  concurrency: false,
})
  .on('test:fail', () => process.exitCode = 1)
  .pipe(spec({}))
  .pipe(process.stdout);
