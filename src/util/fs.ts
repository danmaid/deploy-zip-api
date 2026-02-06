import path from 'node:path';
import fsp from 'node:fs/promises';

export function safeJoin(root: string, rel: string): string {
  if (rel.includes('\0')) throw new Error('Invalid path');
  const p = rel.replace(/\\/g, '/');
  if (p.startsWith('/')) throw new Error('Absolute paths not allowed');
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error('Parent paths not allowed');
    out.push(part);
  }
  const joined = path.join(root, ...out);
  const rel2 = path.relative(root, joined);
  if (rel2.startsWith('..') || path.isAbsolute(rel2)) throw new Error('Path escapes root');
  return joined;
}

export async function mkdirp(dir: string) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e: any) {
    // Ignore EEXIST errors — directory already exists
    if (e?.code !== 'EEXIST') throw e;
  }
}

export function isSafeName(name: string): boolean {
  return !!name && !name.includes('..') && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}
