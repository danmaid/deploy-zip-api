import { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

export async function teeToSpool(req: IncomingMessage, spoolPath: string, maxBytes: number) {
  const pass = new PassThrough();
  const ws = createWriteStream(spoolPath, { flags: 'wx' });

  let seen = 0;

  req.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > maxBytes) {
      const err = new Error('ZIP too large');
      req.destroy(err);
      pass.destroy(err);
      ws.destroy(err);
      return;
    }

    const ok1 = ws.write(chunk);
    const ok2 = pass.write(chunk);
    if (!ok1 || !ok2) {
      req.pause();
      let pending = 0;
      const resumeIfReady = () => {
        pending -= 1;
        if (pending <= 0) req.resume();
      };
      if (!ok1) {
        pending += 1;
        ws.once('drain', resumeIfReady);
      }
      if (!ok2) {
        pending += 1;
        pass.once('drain', resumeIfReady);
      }
    }
  });

  req.on('end', () => {
    pass.end();
    ws.end();
  });

  req.on('error', (e) => {
    pass.destroy(e);
    ws.destroy(e);
  });

  const spoolDone = finished(ws);
  return { pass, spoolDone };
}
