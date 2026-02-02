export class Timing {
  private marks = new Map<string, bigint>();
  private durs = new Map<string, { ns: bigint; desc?: string }>();
  private nowNs(): bigint { return process.hrtime.bigint(); }
  start(name: string) { this.marks.set(name, this.nowNs()); }
  end(name: string, desc?: string) {
    const s = this.marks.get(name);
    if (!s) return;
    const ns = this.nowNs() - s;
    this.durs.set(name, { ns, desc });
  }
  addMs(name: string, durMs: number, desc?: string) {
    const cur = this.durs.get(name);
    const addNs = BigInt(Math.round(durMs * 1e6));
    const ns = (cur?.ns ?? 0n) + addNs;
    this.durs.set(name, { ns, desc: desc ?? cur?.desc });
  }
  toHeader(): string {
    const parts: string[] = [];
    for (const [name, v] of this.durs.entries()) {
      const ms = Number(v.ns) / 1e6;
      const dur = ms.toFixed(1);
      if (v.desc) {
        const d = v.desc.replace(/"/g, "'");
        parts.push(`${name};dur=${dur};desc="${d}"`);
      } else {
        parts.push(`${name};dur=${dur}`);
      }
    }
    return parts.join(', ');
  }
}
