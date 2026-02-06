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
    if (e?.code === 'EEXIST') {
      // Directory already exists
      return;
    }
    if (e?.code === 'ENOTDIR') {
      // A file exists in the path where we need a directory
      // Check each component of the path and remove files if necessary
      const parts = dir.split(path.sep);
      let currentPath = parts[0] === '' ? '/' : parts[0];
      
      for (let i = 1; i < parts.length; i++) {
        try {
          const stat = await fsp.stat(currentPath);
          if (!stat.isDirectory()) {
            // It's a file, remove it
            await fsp.rm(currentPath, { force: true });
          }
        } catch (statErr: any) {
          if (statErr?.code !== 'ENOENT') throw statErr;
        }
        currentPath = path.join(currentPath, parts[i]);
      }
      
      // Now try to create the directory again
      await fsp.mkdir(dir, { recursive: true });
      return;
    }
    throw e;
  }
}

export function isSafeName(name: string): boolean {
  return !!name && !name.includes('..') && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}
