import { open } from 'node:fs/promises';
import { decodeName } from './zip_name.js';

export type CentralEntry = {
  fileName: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: bigint;
  uncompressedSize: bigint;
  localHeaderOffset: bigint;
  isDirectory: boolean;
};

const EOCD_SIG = 0x06054b50;
const Z64_LOC_SIG = 0x07064b50;
const Z64_EOCD_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;

function u16(buf: Buffer, off: number) { return buf.readUInt16LE(off); }
function u32(buf: Buffer, off: number) { return buf.readUInt32LE(off); }
function u64(buf: Buffer, off: number) { return buf.readBigUInt64LE(off); }

function parseExtraZip64(extra: Buffer, wantU: boolean, wantC: boolean, wantOff: boolean) {
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off);
    const sz = extra.readUInt16LE(off + 2);
    off += 4;
    if (off + sz > extra.length) break;
    if (id === 0x0001) {
      let p = off;
      const out: any = {};
      if (wantU) { out.usize = extra.readBigUInt64LE(p); p += 8; }
      if (wantC) { out.csize = extra.readBigUInt64LE(p); p += 8; }
      if (wantOff) { out.offset = extra.readBigUInt64LE(p); p += 8; }
      return out;
    }
    off += sz;
  }
  return {};
}

export async function readCentralDirectory(zipPath: string) {
  const warnings: string[] = [];
  const fh = await open(zipPath, 'r');
  try {
    const st = await fh.stat();
    const size = BigInt(st.size);

    const maxSearch = 0x10000n + 22n;
    const start = size > maxSearch ? size - maxSearch : 0n;
    const len = Number(size - start);
    const tail = Buffer.alloc(len);
    await fh.read(tail, 0, len, Number(start));

    let eocdOff = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocdOff = i; break; }
    }
    if (eocdOff < 0) throw new Error('EOCD not found');

    const eocd = tail.subarray(eocdOff);
    const cdSize32 = u32(eocd, 12);
    const cdOff32 = u32(eocd, 16);
    const totalEntries16 = u16(eocd, 10);

    let cdSize = BigInt(cdSize32);
    let cdOff = BigInt(cdOff32);

    const needsZip64 = (cdSize32 === 0xFFFFFFFF) || (cdOff32 === 0xFFFFFFFF) || (totalEntries16 === 0xFFFF);
    if (needsZip64) {
      const locPos = eocdOff - 20;
      if (locPos >= 0 && tail.readUInt32LE(locPos) === Z64_LOC_SIG) {
        const loc = tail.subarray(locPos, locPos + 20);
        const z64eocdOff = u64(loc, 8);
        const zbuf = Buffer.alloc(56);
        await fh.read(zbuf, 0, 56, Number(z64eocdOff));
        if (zbuf.readUInt32LE(0) !== Z64_EOCD_SIG) throw new Error('Zip64 EOCD not found');
        cdSize = u64(zbuf, 40);
        cdOff = u64(zbuf, 48);
      } else {
        warnings.push('Zip64 needed but Zip64 locator not found; using 32-bit CD fields');
      }
    }

    const cdBuf = Buffer.alloc(Number(cdSize));
    await fh.read(cdBuf, 0, Number(cdSize), Number(cdOff));

    const entries: CentralEntry[] = [];
    let p = 0;
    while (p + 46 <= cdBuf.length) {
      const sig = cdBuf.readUInt32LE(p);
      if (sig !== CEN_SIG) break;

      const flags = cdBuf.readUInt16LE(p + 8);
      const method = cdBuf.readUInt16LE(p + 10);
      const crc32 = cdBuf.readUInt32LE(p + 16) >>> 0;
      const csize32e = cdBuf.readUInt32LE(p + 20);
      const usize32e = cdBuf.readUInt32LE(p + 24);
      const nameLen = cdBuf.readUInt16LE(p + 28);
      const extraLen = cdBuf.readUInt16LE(p + 30);
      const commentLen = cdBuf.readUInt16LE(p + 32);
      const lhoff32 = cdBuf.readUInt32LE(p + 42);

      const nameBytes = cdBuf.subarray(p + 46, p + 46 + nameLen);
      const extra = cdBuf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

      let csize = BigInt(csize32e);
      let usize = BigInt(usize32e);
      let lhoff = BigInt(lhoff32);
      const wantU = usize32e === 0xFFFFFFFF;
      const wantC = csize32e === 0xFFFFFFFF;
      const wantO = lhoff32 === 0xFFFFFFFF;
      if (wantU || wantC || wantO) {
        const z64 = parseExtraZip64(extra, wantU, wantC, wantO);
        if (wantU && z64.usize === undefined) throw new Error('Zip64 usize missing in central');
        if (wantC && z64.csize === undefined) throw new Error('Zip64 csize missing in central');
        if (wantO && z64.offset === undefined) throw new Error('Zip64 offset missing in central');
        if (z64.usize !== undefined) usize = z64.usize;
        if (z64.csize !== undefined) csize = z64.csize;
        if (z64.offset !== undefined) lhoff = z64.offset;
      }

      const name = decodeName(nameBytes, flags, extra);
      entries.push({ fileName: name, flags, method, crc32, compressedSize: csize, uncompressedSize: usize, localHeaderOffset: lhoff, isDirectory: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }

    return { entries, warnings };
  } finally {
    await fh.close();
  }
}
