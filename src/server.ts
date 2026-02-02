import http from 'node:http';
import { URL } from 'node:url';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

import { extractZipRequestToDirectory, UploadLimits } from './deploy/extract_zip_to_dir.js';
import { atomicSwapDirs } from './deploy/atomic_swap.js';
import { collectFiles, streamZipOfFiles } from './zip/zip_writer.js';
import { isSafeName } from './util/fs.js';
import { Timing } from './util/timing.js';
import { encodePlan, downloadPlan, uploadPlan } from './util/pipeline_plan.js';

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

function sendJson(res: http.ServerResponse, status: number, body: any, headers: Record<string,string> = {}) {
  const data = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Timing-Allow-Origin': '*',
    ...headers,
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

async function serveStaticFile(res: http.ServerResponse, filePath: string, contentType: string) {
  const data = await fsp.readFile(filePath);
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length, 'Timing-Allow-Origin': '*' });
  res.end(data);
}

async function handleGetZipFromDir(res: http.ServerResponse, dir: string, filename: string, topFolder: string) {
  const t = new Timing();
  t.start('total');

  const files = await collectFiles(dir, t);
  const planHeader = encodePlan(downloadPlan(files.length));

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Timing-Allow-Origin': '*',
    'X-Pipeline-Plan': planHeader,
    'Trailer': 'Server-Timing',
  });

  try {
    const r = await streamZipOfFiles({ files, out: res, topFolder, timing: t });
    t.end('total', `files=${r.fileCount}`);
    res.addTrailers({ 'Server-Timing': t.toHeader() });
    res.end();
  } catch (e: any) {
    res.destroy(e);
  }
}

async function handlePostContent(req: http.IncomingMessage, res: http.ServerResponse) {
  await ensureDirs();

  const id = timestampId();
  const workDir = await fsp.mkdtemp(path.join(TMP_BASE, `work-${id}-`));
  const stagingDir = path.join(workDir, 'staging');

  const t = new Timing();
  t.start('total');

  const planHeader0 = encodePlan(uploadPlan(0));

  try {
    t.start('inflate');
    const r0 = await extractZipRequestToDirectory({ req, stagingDir, limits });
    t.end('inflate', `entries=${r0.entryCount};deferred_store_dd=${r0.spool.deferredStoreDD}`);

    t.addMs('spool_write', r0.spool.writeMs, `bytes=${r0.spool.bytes}`);
    if (r0.spool.readMs > 0) t.addMs('spool_read', r0.spool.readMs, `count=${r0.spool.readCount}`);

    t.start('swap');
    await atomicSwapDirs({ htmlDir: HTML_DIR, stagingDir, archiveDir: ARCHIVE_DIR, id });
    t.end('swap');

    t.start('cleanup');
    try { await fsp.rm(r0.spoolPath, { force: true }); } catch {}
    try { await fsp.rm(workDir, { recursive: true, force: true }); } catch {}
    t.end('cleanup');

    t.end('total');

    const planHeader = encodePlan(uploadPlan(r0.entryCount));

    return sendJson(res, 200, { ok: true, id, entries: r0.entryCount }, {
      'X-Pipeline-Plan': planHeader,
      'Server-Timing': t.toHeader(),
    });
  } catch (e: any) {
    try { await fsp.rm(workDir, { recursive: true, force: true }); } catch {}
    t.end('total');
    return sendJson(res, 400, { ok:false, error: e?.message ?? String(e) }, {
      'X-Pipeline-Plan': planHeader0,
      'Server-Timing': t.toHeader(),
    });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname;

    if (req.method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok:true });

    if (req.method === 'GET' && (p === '/' || p === '/ui' || p === '/ui/')) {
      return await serveStaticFile(res, path.join(process.cwd(), 'public', 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/ui/app.js') {
      return await serveStaticFile(res, path.join(process.cwd(), 'public', 'app.js'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/ui/style.css') {
      return await serveStaticFile(res, path.join(process.cwd(), 'public', 'style.css'), 'text/css; charset=utf-8');
    }

    if (req.method === 'GET' && p === '/content') {
      await ensureDirs();
      return await handleGetZipFromDir(res, HTML_DIR, `content-${Date.now()}.zip`, ZIP_OUT_ROOT);
    }
    if (req.method === 'POST' && p === '/content') {
      return await handlePostContent(req, res);
    }

    if (req.method === 'GET' && p === '/archive') {
      await ensureDirs();
      const dirs = await listArchiveDirs();
      return sendJson(res, 200, { ok:true, archives: dirs });
    }

    return sendJson(res, 404, { ok:false, error:'Not found' });
  } catch (e: any) {
    return sendJson(res, 500, { ok:false, error: e?.message ?? String(e) });
  }
});

await ensureDirs();
server.listen(PORT, HOST, () => {
  console.log(`deploy-zip-api listening on http://${HOST}:${PORT}`);
  console.log(`UI: http://${HOST}:${PORT}/ui`);
});
