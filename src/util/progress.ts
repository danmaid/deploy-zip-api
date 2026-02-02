import { EventEmitter } from 'node:events';

export type RunPlanStage = { name: string; lane: number; group?: string };
export type ProgressEvent =
  | { type: 'plan'; run: string; kind: 'upload'|'download'; stages: RunPlanStage[]; t: number }
  | { type: 'stage'; run: string; name: string; status: 'start'|'end'; t: number; durMs?: number; detail?: string }
  | { type: 'bytes'; run: string; name: string; t: number; bytes: number; total: number }
  | { type: 'done'; run: string; t: number; ok: boolean; detail?: string };

export class ProgressHub {
  private ee = new EventEmitter();

  emit(evt: ProgressEvent) {
    this.ee.emit('evt', evt);
  }

  on(run: string, cb: (evt: ProgressEvent) => void) {
    const handler = (evt: ProgressEvent) => {
      if (evt.run === run) cb(evt);
    };
    this.ee.on('evt', handler);
    return () => this.ee.off('evt', handler);
  }
}

export function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}
