import { Readable } from 'node:stream';

export type ZipEntryHeader = {
  localHeaderOffset: bigint;
  fileNameBytes: Buffer;
  extra: Buffer;
  method: 0 | 8;
  flags: number;
  compressedSize: bigint;
  uncompressedSize: bigint;
  crc32: number;
};

export type DataDescriptor = {
  crc32: number;
  compressedSize: bigint;
  uncompressedSize: bigint;
};

const LFH_SIG = 0x04034b50;
const CDH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const DD_SIG = 0x08074b50;

function u16(buf: Buffer, off: number) { return buf.readUInt16LE(off); }
function u32(buf: Buffer, off: number) { return buf.readUInt32LE(off); }

class AsyncByteQueue {
  private chunks: Buffer[] = [];
  public length = 0;
  private ended = false;
  private waiters: Array<() => void> = [];
  private discarding = false;
  private consumedTotal: bigint = 0n;

  constructor(src: Readable) {
    src.on('data', (c: Buffer) => {
      if (this.discarding) return;
      this.chunks.push(c);
      this.length += c.length;
      this.wake();
    });
    src.on('end', () => {
      this.ended = true;
      this.wake();
    });
    src.on('error', () => {
      this.ended = true;
      this.wake();
    });
  }

  discardFuture() {
    this.discarding = true;
    this.chunks = [];
    this.length = 0;
    this.wake();
  }

  getConsumedTotal(): bigint {
    return this.consumedTotal;
  }

  private wake() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  async ensure(n: number) {
    while (this.length < n) {
      if (this.ended) throw new Error('Unexpected EOF');
      await new Promise<void>(r => this.waiters.push(r));
    }
  }

  read(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    if (n > this.length) throw new Error('Queue underflow');
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0];
      const need = n - off;
      if (head.length <= need) {
        head.copy(out, off);
        off += head.length;
        this.chunks.shift();
        this.length -= head.length;
      } else {
        head.copy(out, off, 0, need);
        this.chunks[0] = head.subarray(need);
        this.length -= need;
        off += need;
      }
    }
    this.consumedTotal += BigInt(n);
    return out;
  }

  peekU32LE(): number {
    if (this.length < 4) throw new Error('Need 4 bytes');
    const b0 = this.chunks[0];
    if (b0.length >= 4) return b0.readUInt32LE(0);
    const tmp = this.read(4);
    const v = tmp.readUInt32LE(0);
    this.chunks.unshift(tmp);
    this.length += 4;
    this.consumedTotal -= 4n;
    return v;
  }

  streamExact(n: bigint): Readable {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (n < 0n || n > max) throw new Error('Entry too large');
    let remaining = Number(n);
    const q = this;
    return new Readable({
      async read() {
        try {
          if (remaining <= 0) return this.push(null);
          await q.ensure(1);
          const take = Math.min(remaining, q.length);
          const chunk = q.read(take);
          remaining -= chunk.length;
          this.push(chunk);
        } catch (e) {
          this.destroy(e as Error);
        }
      }
    });
  }

  streamUnknown(): Readable {
    const q = this;
    return new Readable({
      async read(size) {
        try {
          await q.ensure(1);
          const take = Math.min(q.length, size || q.length);
          this.push(q.read(take));
        } catch {
          this.push(null);
        }
      }
    });
  }
}

function parseZip64Extra(extra: Buffer, wantC: boolean, wantU: boolean) {
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
      return out;
    }
    off += sz;
  }
  return {};
}

export class ZipStreamReader {
  private q: AsyncByteQueue;

  constructor(src: Readable) {
    this.q = new AsyncByteQueue(src);
  }

  async nextHeader(): Promise<ZipEntryHeader | null> {
    await this.q.ensure(4);
    const sig = this.q.peekU32LE();
    if (sig === CDH_SIG || sig === EOCD_SIG) {
      this.q.discardFuture();
      return null;
    }
    if (sig !== LFH_SIG) {
      this.q.discardFuture();
      return null;
    }

    const localHeaderOffset = this.q.getConsumedTotal();

    await this.q.ensure(30);
    const h = this.q.read(30);
    const flags = u16(h, 6);
    const method = u16(h, 8);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported compression method: ${method}`);

    const crc32 = u32(h, 14);
    const csize32 = u32(h, 18);
    const usize32 = u32(h, 22);
    const nameLen = u16(h, 26);
    const extraLen = u16(h, 28);

    await this.q.ensure(nameLen + extraLen);
    const nameBuf = this.q.read(nameLen);
    const extra = this.q.read(extraLen);

    let csize = BigInt(csize32);
    let usize = BigInt(usize32);
    const wantC = csize32 === 0xFFFFFFFF;
    const wantU = usize32 === 0xFFFFFFFF;
    if (wantC || wantU) {
      const z64 = parseZip64Extra(extra, wantC, wantU);
      if (wantC && z64.csize === undefined) throw new Error('Zip64 csize missing');
      if (wantU && z64.usize === undefined) throw new Error('Zip64 usize missing');
      if (z64.csize !== undefined) csize = z64.csize;
      if (z64.usize !== undefined) usize = z64.usize;
    }

    return { localHeaderOffset, fileNameBytes: nameBuf, extra, method: method as 0|8, flags, compressedSize: csize, uncompressedSize: usize, crc32 };
  }

  streamCompressedKnown(n: bigint): Readable { return this.q.streamExact(n); }
  streamCompressedUnknown(): Readable { return this.q.streamUnknown(); }

  async readDataDescriptor(zip64: boolean): Promise<DataDescriptor> {
    await this.q.ensure(12);
    const first = this.q.peekU32LE();
    if (first === DD_SIG) this.q.read(4);

    await this.q.ensure(zip64 ? 4+8+8 : 4+4+4);
    const crc = this.q.read(4).readUInt32LE(0) >>> 0;
    let csize: bigint;
    let usize: bigint;
    if (zip64) {
      const b = this.q.read(16);
      csize = b.readBigUInt64LE(0);
      usize = b.readBigUInt64LE(8);
    } else {
      const b = this.q.read(8);
      csize = BigInt(b.readUInt32LE(0));
      usize = BigInt(b.readUInt32LE(4));
    }
    return { crc32: crc, compressedSize: csize, uncompressedSize: usize };
  }
}
