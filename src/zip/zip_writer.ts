import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { crc32Update } from './crc32.js';
import { Timing } from '../util/timing.js';

type CdEntry = { name: Buffer; crc32: number; csize: bigint; usize: bigint; lhoff: bigint; mtimeDate: { time: number; date: number } };

function dosTimeDate(mtime: Date): { time: number; date: number } {
  const d = mtime;
  let year = d.getFullYear();
  if (year < 1980) year = 1980;
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hour = d.getHours();
  const min = d.getMinutes();
  const sec = Math.floor(d.getSeconds() / 2);
  const time = (hour << 11) | (min << 5) | sec;
  const date = ((year - 1980) << 9) | (month << 5) | day;
  return { time, date };
}

async function writeAll(w: NodeJS.WritableStream, buf: Buffer): Promise<void> {
  if (buf.length === 0) return;
  const ok = w.write(buf);
  if (!ok) await new Promise<void>(r => w.once('drain', r));
}

function u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xFFFF, 0); return b; }
function u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }
function u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v, 0); return b; }

function zip64ExtraLocalPlaceholders(): Buffer {
  const b = Buffer.alloc(4 + 16);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(16, 2);
  return b;
}

function zip64ExtraCentral(usize: bigint, csize: bigint, lhoff: bigint): Buffer {
  const payload = Buffer.concat([u64(usize), u64(csize), u64(lhoff)]);
  const b = Buffer.alloc(4);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(payload.length, 2);
  return Buffer.concat([b, payload]);
}

async function* walkFiles(rootDir: string): AsyncGenerator<{ abs: string; rel: string; st: fs.Stats }> {
  const stack: Array<{ abs: string; rel: string }> = [{ abs: rootDir, rel: '' }];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = await fsp.readdir(cur.abs, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(cur.abs, ent.name);
      const rel = cur.rel ? `${cur.rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) stack.push({ abs, rel });
      else if (ent.isFile()) {
        const st = await fsp.stat(abs);
        yield { abs, rel, st };
      }
    }
  }
}

export async function collectFiles(dir: string, timing?: Timing) {
  const files: Array<{ abs: string; rel: string; st: fs.Stats }> = [];
  if (timing) timing.start('walk');
  for await (const f of walkFiles(dir)) files.push(f);
  if (timing) timing.end('walk', `files=${files.length}`);
  return files;
}

export async function streamZipOfFiles(opts: {
  files: Array<{ abs: string; rel: string; st: fs.Stats }>;
  out: NodeJS.WritableStream;
  topFolder: string;
  compressionLevel?: number;
  timing: Timing;
}): Promise<{ fileCount: number }>{
  const { files, out, topFolder, timing } = opts;
  const level = opts.compressionLevel ?? 6;

  const entries: CdEntry[] = [];
  let offset = 0n;
  let fileCount = 0;

  for (const f of files) {
    fileCount++;
    const nameStr = `${topFolder}/${f.rel}`.replace(/\\/g, '/');
    const name = Buffer.from(nameStr, 'utf8');
    const { time, date } = dosTimeDate(f.st.mtime);

    const lhoff = offset;
    const extraLocal = zip64ExtraLocalPlaceholders();

    const lfhStart = performance.now();
    const lfh = Buffer.concat([
      u32(0x04034b50), u16(45), u16(0x0008 | 0x0800), u16(8), u16(time), u16(date),
      u32(0), u32(0xFFFFFFFF), u32(0xFFFFFFFF), u16(name.length), u16(extraLocal.length),
      name, extraLocal
    ]);
    await writeAll(out, lfh);
    timing.addMs('lfh', performance.now() - lfhStart);

    offset += BigInt(lfh.length);

    let crc = 0;
    let usize = 0n;
    let csize = 0n;

    const defStart = performance.now();

    const tapU = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        try { crc = crc32Update(crc, chunk); usize += BigInt(chunk.length); cb(null, chunk); }
        catch (e: any) { cb(e); }
      }
    });

    const def = zlib.createDeflateRaw({ level });
    const tapC = new Transform({
      transform(chunk: Buffer, _enc, cb) { csize += BigInt(chunk.length); cb(null, chunk); }
    });

    const rs = fs.createReadStream(f.abs);
    rs.pipe(tapU).pipe(def).pipe(tapC);
    tapC.pipe(out, { end: false });
    await finished(tapC);

    timing.addMs('deflate', performance.now() - defStart);

    const ddStart = performance.now();
    const dd = Buffer.concat([u32(0x08074b50), u32(crc >>> 0), u64(csize), u64(usize)]);
    await writeAll(out, dd);
    timing.addMs('dd', performance.now() - ddStart);

    offset += csize + BigInt(dd.length);

    entries.push({ name, crc32: crc >>> 0, csize, usize, lhoff, mtimeDate: { time, date } });
  }

  timing.start('cd');
  const cdStart = offset;
  let cdSize = 0n;

  for (const e of entries) {
    const extra = zip64ExtraCentral(e.usize, e.csize, e.lhoff);
    const cdh = Buffer.concat([
      u32(0x02014b50), u16(45), u16(45), u16(0x0008 | 0x0800), u16(8), u16(e.mtimeDate.time), u16(e.mtimeDate.date),
      u32(e.crc32), u32(0xFFFFFFFF), u32(0xFFFFFFFF), u16(e.name.length), u16(extra.length),
      u16(0), u16(0), u16(0), u32(0), u32(0xFFFFFFFF), e.name, extra
    ]);
    await writeAll(out, cdh);
    cdSize += BigInt(cdh.length);
    offset += BigInt(cdh.length);
  }

  const zip64EocdOff = offset;
  const zip64Eocd = Buffer.concat([
    u32(0x06064b50), u64(44n), u16(45), u16(45), u32(0), u32(0),
    u64(BigInt(entries.length)), u64(BigInt(entries.length)), u64(cdSize), u64(cdStart)
  ]);
  await writeAll(out, zip64Eocd);
  offset += BigInt(zip64Eocd.length);

  const loc = Buffer.concat([u32(0x07064b50), u32(0), u64(zip64EocdOff), u32(1)]);
  await writeAll(out, loc);
  offset += BigInt(loc.length);

  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(0xFFFF), u16(0xFFFF), u32(0xFFFFFFFF), u32(0xFFFFFFFF), u16(0)]);
  await writeAll(out, eocd);

  timing.end('cd', `entries=${entries.length}`);
  return { fileCount };
}
