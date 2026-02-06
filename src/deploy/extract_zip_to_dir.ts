import { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createWriteStream, createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import zlib from 'node:zlib';
import { open } from 'node:fs/promises';

import { teeToSpool } from '../zip/spool.js';
import { ZipStreamReader } from '../zip/zip_stream.js';
import { readCentralDirectory } from '../zip/central_directory.js';
import { crc32Update } from '../zip/crc32.js';
import { decodeName, normalizeZipPath, getTopDir, stripTopDir } from '../zip/zip_name.js';
import { mkdirp, safeJoin } from '../util/fs.js';

export type UploadLimits = {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxZipBytes: number;
};

async function writeStreamToFile(rawStream: NodeJS.ReadableStream, outPath: string, limits: UploadLimits): Promise<{ size: number; crc32: number }> {
  await mkdirp(dirname(outPath));
  
  // Remove any existing file or directory at the target path
  try {
    const stat = await fsp.stat(outPath);
    if (stat.isDirectory()) {
      await fsp.rm(outPath, { recursive: true, force: true });
    } else {
      await fsp.rm(outPath, { force: true });
    }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  
  const tmpPath = outPath + `.part-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  let crc = 0;
  let size = 0;

  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      try {
        size += chunk.length;
        if (size > limits.maxFileBytes) throw new Error('File too large');
        crc = crc32Update(crc, chunk);
        cb(null, chunk);
      } catch (e: any) {
        cb(e);
      }
    }
  });

  await pipeline(rawStream as any, tap, createWriteStream(tmpPath, { flags: 'w' }));
  await fsp.rename(tmpPath, outPath);
  return { size, crc32: crc >>> 0 };
}

async function processEntryFromSpoolToStaging(opts: {
  zipPath: string;
  localHeaderOffset: bigint;
  method: number;
  compressedSize: bigint;
  outPath: string;
  limits: UploadLimits;
}): Promise<{ size: number; crc32: number }> {
  const { zipPath, localHeaderOffset, method, compressedSize, outPath, limits } = opts;
  const fh = await open(zipPath, 'r');
  try {
    const h = Buffer.alloc(30);
    await fh.read(h, 0, 30, Number(localHeaderOffset));
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('Local header signature mismatch');
    const nameLen = h.readUInt16LE(26);
    const extraLen = h.readUInt16LE(28);
    const dataStart = localHeaderOffset + 30n + BigInt(nameLen + extraLen);

    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (compressedSize < 0n || compressedSize > max) throw new Error('Entry too large');

    const start = Number(dataStart);
    const end = Number(dataStart + compressedSize - 1n);
    const rs = createReadStream(zipPath, { start, end });

    if (method === 0) return await writeStreamToFile(rs, outPath, limits);
    if (method === 8) return await writeStreamToFile(rs.pipe(zlib.createInflateRaw()), outPath, limits);
    throw new Error(`Unsupported method in fallback: ${method}`);
  } finally {
    await fh.close();
  }
}

export async function extractZipRequestToDirectory(opts: {
  req: IncomingMessage;
  stagingDir: string;
  limits: UploadLimits;
}): Promise<{ spoolPath: string; rootTopDir: string; warnings: string[] }> {
  const { req, stagingDir, limits } = opts;
  await mkdirp(stagingDir);

  const spoolPath = join(tmpdir(), `upload-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
  const { pass, spoolDone } = await teeToSpool(req, spoolPath, limits.maxZipBytes);

  const zr = new ZipStreamReader(pass as any);
  const processed = new Map<string, { size: number; crc32: number }>();

  let entryCount = 0;
  let totalBytes = 0;
  const warnings: string[] = [];
  let topDir: string | null = null;

  // Streaming phase — read as much as we can from the stream. If parsing
  // fails (for example, Unexpected EOF from a ZIP variant), fall back to
  // extracting everything from the spooled file via the central directory.
  try {
    for (;;) {
      const hdr = await zr.nextHeader();
      if (!hdr) break;

      entryCount += 1;
      if (entryCount > limits.maxEntries) throw new Error('Too many entries');

      const name = decodeName(hdr.fileNameBytes, hdr.flags, hdr.extra);
      const norm = normalizeZipPath(name);
      if (!norm) continue;

      if (!topDir) {
        topDir = getTopDir(norm);
        if (!topDir) throw new Error('ZIP must contain a top directory');
      }

      // directories are optional
      const rel = stripTopDir(norm, topDir);
      if (!rel) continue;

      const outPath = safeJoin(stagingDir, rel);

      const usesDD = (hdr.flags & 0x08) !== 0;
      const zip64Sizes = hdr.compressedSize > 0xFFFFFFFFn || hdr.uncompressedSize > 0xFFFFFFFFn;

      // STORE + DD defer
      if (usesDD && hdr.method === 0) {
        warnings.push(`Deferred STORE+DD at offset ${hdr.localHeaderOffset}`);
        continue;
      }

      // directory entry
      if (norm.endsWith('/')) {
        await mkdirp(outPath);
        continue;
      }

      let rawStream: NodeJS.ReadableStream;
      if (!usesDD) {
        const src = zr.streamCompressedKnown(hdr.compressedSize);
        rawStream = hdr.method === 0 ? src : src.pipe(zlib.createInflateRaw());
      } else {
        const src = zr.streamCompressedUnknown();
        rawStream = src.pipe(zlib.createInflateRaw());
      }

      const r = await writeStreamToFile(rawStream, outPath, limits);
      totalBytes += r.size;
      if (totalBytes > limits.maxTotalBytes) throw new Error('Total too large');

      if (!usesDD) {
        if (hdr.uncompressedSize !== 0n && hdr.uncompressedSize !== BigInt(r.size)) throw new Error('Size mismatch (local header)');
        if (hdr.crc32 !== 0 && hdr.crc32 !== r.crc32) throw new Error('CRC mismatch (local header)');
      } else {
        const dd = await zr.readDataDescriptor(zip64Sizes);
        if (dd.uncompressedSize !== BigInt(r.size)) throw new Error('Size mismatch (DD)');
        if (dd.crc32 !== r.crc32) throw new Error('CRC mismatch (DD)');
      }

      processed.set(hdr.localHeaderOffset.toString(), { size: r.size, crc32: r.crc32 });
    }
  } catch (e: any) {
    // Don't treat a streaming parse failure as a fatal upload error — we'll
    // attempt to finish extraction by reading the Central Directory from the
    // spooled file and performing a fallback extraction for entries that were
    // not fully processed during streaming.
    warnings.push(`Streaming parse failed: ${e?.message ?? String(e)}; falling back to central directory`);
  }

  await spoolDone;

  // Finalize using Central Directory
  const cd = await readCentralDirectory(spoolPath);
  warnings.push(...cd.warnings);

  if (!topDir) {
    const first = cd.entries.find(e => !!e.fileName && !e.isDirectory);
    if (!first) throw new Error('ZIP has no files');
    topDir = getTopDir(normalizeZipPath(first.fileName));
  }

  for (const e of cd.entries) {
    if (e.isDirectory) continue;
    if (e.method !== 0 && e.method !== 8) throw new Error(`Unsupported method in CD: ${e.method}`);

    const norm = normalizeZipPath(e.fileName);
    if (!norm) continue;
    const rel = stripTopDir(norm, topDir!);
    if (!rel) continue;

    const outPath = safeJoin(stagingDir, rel);

    const key = e.localHeaderOffset.toString();
    const already = processed.get(key);
    if (already) {
      if (BigInt(already.size) !== e.uncompressedSize) throw new Error(`Size mismatch vs CD for ${rel}`);
      if (already.crc32 !== e.crc32) throw new Error(`CRC mismatch vs CD for ${rel}`);
    } else {
      const r = await processEntryFromSpoolToStaging({
        zipPath: spoolPath,
        localHeaderOffset: e.localHeaderOffset,
        method: e.method,
        compressedSize: e.compressedSize,
        outPath,
        limits,
      });
      totalBytes += r.size;
      if (totalBytes > limits.maxTotalBytes) throw new Error('Total too large');
      if (BigInt(r.size) !== e.uncompressedSize) throw new Error(`Fallback size mismatch for ${rel}`);
      if (r.crc32 !== e.crc32) throw new Error(`Fallback CRC mismatch for ${rel}`);
      processed.set(key, { size: r.size, crc32: r.crc32 });
    }
  }

  return { spoolPath, rootTopDir: topDir!, warnings };
}
