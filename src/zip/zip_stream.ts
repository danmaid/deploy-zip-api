import { Readable } from 'node:stream';
export type ZipEntryHeader = { localHeaderOffset: bigint; fileNameBytes: Buffer; extra: Buffer; method: 0|8; flags: number; compressedSize: bigint; uncompressedSize: bigint; crc32: number; };
export type DataDescriptor = { crc32: number; compressedSize: bigint; uncompressedSize: bigint; };
const LFH_SIG=0x04034b50, CDH_SIG=0x02014b50, EOCD_SIG=0x06054b50, DD_SIG=0x08074b50;
const u16=(b:Buffer,o:number)=>b.readUInt16LE(o); const u32=(b:Buffer,o:number)=>b.readUInt32LE(o);
class Q{chunks:Buffer[]=[];len=0;ended=false;waiters:Array<()=>void>=[];discard=false;consumed=0n;
  constructor(src:Readable){src.on('data',(c:Buffer)=>{if(this.discard)return;this.chunks.push(c);this.len+=c.length;this.wake();});src.on('end',()=>{this.ended=true;this.wake();});src.on('error',()=>{this.ended=true;this.wake();});}
  wake(){const ws=this.waiters;this.waiters=[];for(const w of ws) w();}
  discardFuture(){this.discard=true;this.chunks=[];this.len=0;this.wake();}
  async ensure(n:number){while(this.len<n){if(this.ended) throw new Error('Unexpected EOF'); await new Promise<void>(r=>this.waiters.push(r));}}
  read(n:number){if(n>this.len) throw new Error('underflow');const out=Buffer.allocUnsafe(n);let off=0;while(off<n){const h=this.chunks[0];const need=n-off;if(h.length<=need){h.copy(out,off);off+=h.length;this.chunks.shift();this.len-=h.length;}else{h.copy(out,off,0,need);this.chunks[0]=h.subarray(need);this.len-=need;off+=need;}}this.consumed+=BigInt(n);return out;}
  peekU32(){if(this.len<4) throw new Error('need4');const b0=this.chunks[0];if(b0.length>=4) return b0.readUInt32LE(0);const t=this.read(4);const v=t.readUInt32LE(0);this.chunks.unshift(t);this.len+=4;this.consumed-=4n;return v;}
  streamExact(n:bigint){const max=BigInt(Number.MAX_SAFE_INTEGER);if(n<0n||n>max) throw new Error('Entry too large');let rem=Number(n);const q=this;return new Readable({async read(){try{if(rem<=0) return this.push(null);await q.ensure(1);const take=Math.min(rem,q.len);const c=q.read(take);rem-=c.length;this.push(c);}catch(e){this.destroy(e as Error);}}});}
  streamUnknown(){const q=this;return new Readable({async read(size){try{await q.ensure(1);const take=Math.min(q.len,size||q.len);this.push(q.read(take));}catch{this.push(null);}}});}
}
function parseZip64(extra:Buffer,wC:boolean,wU:boolean){let off=0;while(off+4<=extra.length){const id=extra.readUInt16LE(off);const sz=extra.readUInt16LE(off+2);off+=4;if(off+sz>extra.length) break;if(id===0x0001){let p=off;const o:any={};if(wU){o.usize=extra.readBigUInt64LE(p);p+=8;}if(wC){o.csize=extra.readBigUInt64LE(p);p+=8;}return o;}off+=sz;}return {};}
export class ZipStreamReader{q:Q;constructor(src:Readable){this.q=new Q(src);}getConsumedTotal(){return this.q.consumed;}
  async nextHeader(){await this.q.ensure(4);const sig=this.q.peekU32();if(sig===CDH_SIG||sig===EOCD_SIG){this.q.discardFuture();return null;}if(sig!==LFH_SIG){this.q.discardFuture();return null;}
    const localHeaderOffset=this.q.consumed;await this.q.ensure(30);const h=this.q.read(30);const flags=u16(h,6);const method=u16(h,8);if(method!==0&&method!==8) throw new Error('Unsupported compression method');
    const crc32=u32(h,14);const csize32=u32(h,18);const usize32=u32(h,22);const nameLen=u16(h,26);const extraLen=u16(h,28);
    await this.q.ensure(nameLen+extraLen);const nameBuf=this.q.read(nameLen);const extra=this.q.read(extraLen);
    let csize=BigInt(csize32), usize=BigInt(usize32);const wC=csize32===0xFFFFFFFF, wU=usize32===0xFFFFFFFF; if(wC||wU){const z=parseZip64(extra,wC,wU); if(wC&&z.csize===undefined) throw new Error('Zip64 csize missing'); if(wU&&z.usize===undefined) throw new Error('Zip64 usize missing'); if(z.csize!==undefined) csize=z.csize; if(z.usize!==undefined) usize=z.usize;}
    return { localHeaderOffset, fileNameBytes:nameBuf, extra, method:method as 0|8, flags, compressedSize:csize, uncompressedSize:usize, crc32 } as ZipEntryHeader;
  }
  streamCompressedKnown(n:bigint){return this.q.streamExact(n);} streamCompressedUnknown(){return this.q.streamUnknown();}
  async readDataDescriptor(zip64:boolean){await this.q.ensure(12);const first=this.q.peekU32(); if(first===DD_SIG) this.q.read(4);
    await this.q.ensure(zip64?20:12); const crc=this.q.read(4).readUInt32LE(0)>>>0; let csize:bigint; let usize:bigint;
    if(zip64){const b=this.q.read(16); csize=b.readBigUInt64LE(0); usize=b.readBigUInt64LE(8);} else {const b=this.q.read(8); csize=BigInt(b.readUInt32LE(0)); usize=BigInt(b.readUInt32LE(4));}
    return { crc32:crc, compressedSize:csize, uncompressedSize:usize } as DataDescriptor;
  }
}
