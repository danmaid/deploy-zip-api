import http from 'node:http';
import { URL } from 'node:url';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

import { extractZipRequestToDirectory, UploadLimits } from './deploy/extract_zip_to_dir.js';
import { atomicSwapDirs } from './deploy/atomic_swap.js';
import { streamZipOfDirectory } from './zip/zip_writer.js';
import { isSafeName } from './util/fs.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const HTML_DIR = process.env.HTML_DIR ?? '/var/www/html';
const ARCHIVE_DIR = process.env.ARCHIVE_DIR ?? '/var/www/archive';
const TMP_BASE = process.env.TMP_BASE ?? '/var/www/.tmp-deploy';

const ZIP_OUT_ROOT = process.env.ZIP_OUT_ROOT ?? 'site';

const limits: UploadLimits = {
  maxEntries: Number(process.env.MAX_ENTRIES ?? 20000),
  maxFileBytes: Number(process.env.MAX_FILE_BYTES ?? (512 * 1024 * 1024)),
  maxTotalBytes: Number(process.env.MAX_TOTAL_BYTES ?? (2 * 1024 * 1024 * 1024)),
  maxZipBytes: Number(process.env.MAX_ZIP_BYTES ?? (1 * 1024 * 1024 * 1024)),
};

function sendJson(res: http.ServerResponse, status: number, body: any) {
  const data = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
  });
  res.end(data);
}

function timestampId() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${crypto.randomBytes(3).toString('hex')}`;
}

async function ensureDirs() {
  await fsp.mkdir(ARCHIVE_DIR, { recursive: true });
  await fsp.mkdir(TMP_BASE, { recursive: true });
  await fsp.mkdir(HTML_DIR, { recursive: true });
}

async function listArchiveDirs() {
  await fsp.mkdir(ARCHIVE_DIR, { recursive: true });
  const ents = await fsp.readdir(ARCHIVE_DIR, { withFileTypes: true });
  const dirs: Array<{ id: string; mtime: string }>=[];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const full = path.join(ARCHIVE_DIR, e.name);
    const st = await fsp.stat(full);
    dirs.push({ id: e.name, mtime: st.mtime.toISOString() });
  }
  dirs.sort((a,b)=> a.mtime < b.mtime ? 1 : -1);
  return dirs;
}

async function handleGetZipFromDir(res: http.ServerResponse, dir: string, filename: string, topFolder: string) {
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  try {
    await streamZipOfDirectory({ dir, out: res, topFolder });
    res.end();
  } catch (e: any) {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e?.message ?? String(e) });
    else res.destroy(e);
  }
}

async function handleGetContent(_req: http.IncomingMessage, res: http.ServerResponse) {
  await ensureDirs();
  const filename = `content-${Date.now()}.zip`;
  return handleGetZipFromDir(res, HTML_DIR, filename, ZIP_OUT_ROOT);
}

async function handlePostContent(req: http.IncomingMessage, res: http.ServerResponse) {
  await ensureDirs();

  const id = timestampId();
  const workDir = await fsp.mkdtemp(path.join(TMP_BASE, `work-${id}-`));
  const stagingDir = path.join(workDir, 'staging');

  try {
    const { spoolPath, rootTopDir, warnings } = await extractZipRequestToDirectory({ req, stagingDir, limits });

    const r = await atomicSwapDirs({ htmlDir: HTML_DIR, stagingDir, archiveDir: ARCHIVE_DIR, id });

    try { await fsp.rm(spoolPath, { force: true }); } catch {}
    try { await fsp.rm(workDir, { recursive: true, force: true }); } catch {}

    return sendJson(res, 200, { ok: true, id, topDir: rootTopDir, archived: path.basename(r.archivedPath), warnings });
  } catch (e: any) {
    try { await fsp.rm(workDir, { recursive: true, force: true }); } catch {}
    return sendJson(res, 400, { ok: false, error: e?.message ?? String(e) });
  }
}

async function handleGetArchiveList(_req: http.IncomingMessage, res: http.ServerResponse) {
  await ensureDirs();
  const dirs = await listArchiveDirs();
  return sendJson(res, 200, { ok: true, archives: dirs });
}

async function handleGetArchive(_req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  await ensureDirs();
  if (!isSafeName(id)) return sendJson(res, 400, { ok:false, error: 'Invalid id' });

  const dir = path.join(ARCHIVE_DIR, id);
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) throw new Error('Not a directory');
  } catch {
    return sendJson(res, 404, { ok:false, error: 'Not found' });
  }

  const filename = `archive-${id}.zip`;
  return handleGetZipFromDir(res, dir, filename, ZIP_OUT_ROOT);
}

async function serveStaticFile(res: http.ServerResponse, filePath: string, contentType: string) {
  const data = await fsp.readFile(filePath);
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname;

    if (req.method === 'GET' && p === '/v1/deploy/healthz') return sendJson(res, 200, { ok:true });

    if (req.method === 'GET' && p === '/v1/deploy/openapi.yaml') {
      return await serveStaticFile(res, path.join(process.cwd(), 'openapi.yaml'), 'text/yaml; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/v1/deploy/openapi.json') {
      return await serveStaticFile(res, path.join(process.cwd(), 'openapi.json'), 'application/json; charset=utf-8');
    }


// Web UI (static)
if (req.method === 'GET' && (p === '/v1/deploy/' || p === '/v1/deploy/ui' || p === '/v1/deploy/ui/')) {
  return await serveStaticFile(res, path.join(process.cwd(), 'public', 'index.html'), 'text/html; charset=utf-8');
}
if (req.method === 'GET' && p === '/v1/deploy/ui/app.js') {
  return await serveStaticFile(res, path.join(process.cwd(), 'public', 'app.js'), 'application/javascript; charset=utf-8');
}
if (req.method === 'GET' && p === '/v1/deploy/ui/style.css') {
  return await serveStaticFile(res, path.join(process.cwd(), 'public', 'style.css'), 'text/css; charset=utf-8');
}

    if (req.method === 'GET' && p === '/v1/deploy/content') return await handleGetContent(req, res);
    if (req.method === 'POST' && p === '/v1/deploy/content') return await handlePostContent(req, res);

    if (req.method === 'GET' && p === '/v1/deploy/archive') return await handleGetArchiveList(req, res);
    if (req.method === 'GET' && p.startsWith('/v1/deploy/archive/')) {
      const id = decodeURIComponent(p.slice('/v1/deploy/archive/'.length));
      return await handleGetArchive(req, res, id);
    }

    return sendJson(res, 404, { ok:false, error: 'Not found' });
  } catch (e: any) {
    return sendJson(res, 500, { ok:false, error: e?.message ?? String(e) });
  }
});

await ensureDirs();
server.listen(PORT, HOST, () => {
  console.log(`deploy-zip-api listening on http://${HOST}:${PORT}`);
  console.log(`HTML_DIR=${HTML_DIR}`);
  console.log(`ARCHIVE_DIR=${ARCHIVE_DIR}`);
  console.log(`TMP_BASE=${TMP_BASE}`);
  console.log(`Docs: http://${HOST}:${PORT}/v1/deploy/docs`);
});
