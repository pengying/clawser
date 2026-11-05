import * as fs from 'node:fs/promises';

const field = bytes => Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 255]), bytes]);

export const xauthorityEntry = (display, cookie) => Buffer.concat([
  Buffer.from([0xff, 0xff]),
  field(Buffer.alloc(0)),
  field(Buffer.from(String(display))),
  field(Buffer.from('MIT-MAGIC-COOKIE-1')),
  field(cookie),
]);

const exists = path => fs.access(path).then(() => true, () => false);

export async function freeDisplay(d, { from = 20, to = 99, socketDir = '/tmp/.X11-unix', lockDir = '/tmp' } = {}) {
  for (let n = from; n <= to; n++) {
    if (!await exists(`${socketDir}/X${n}`) && !await exists(`${lockDir}/.X${n}-lock`)) return n;
  }
  throw new Error(`no free X display between :${from} and :${to}`);
}
