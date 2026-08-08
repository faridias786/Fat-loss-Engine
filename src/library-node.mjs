/** Node-only disk loader. Never imported by browser code. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setLibrary } from './library.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function loadLibraryFromDisk(path) {
  const target = path ?? join(here, '..', 'data', 'exercises.json');
  return setLibrary(JSON.parse(readFileSync(target, 'utf8')));
}
