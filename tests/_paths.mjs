// Path resolution so the suite runs from anywhere.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const web = (f) => path.join(ROOT, 'web', f);