import { createCipheriv } from 'node:crypto';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** The RFB VNC authentication response: DES over the challenge, keyed by the password with each byte's bits reversed. */
function vncResponse(password, challenge) {
  const key = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    const byte = password.charCodeAt(i) || 0;
    for (let b = 0; b < 8; b++) key[i] |= ((byte >> b) & 1) << (7 - b);
  }
  const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

// 32 bpp, depth 24, little-endian true colour, red at bit 16, green at 8, blue at 0.
const SET_PIXEL_FORMAT = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
const RAW = 0, CURSOR = -239;
// Xvfb parks the pointer at the screen centre. Without the Cursor pseudo-encoding, x11vnc paints the cursor into the pixels sent.
const SET_ENCODINGS = Buffer.from([2, 0, 0, 2, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x11]);

function updateRequest(x, y) {
  const message = Buffer.alloc(10);
  message[0] = 3;
  message.writeUInt16BE(x, 2); message.writeUInt16BE(y, 4); message.writeUInt16BE(1, 6); message.writeUInt16BE(1, 8);
  return message;
}

async function updatedPixel(read, x, y) {
  for (;;) {
    const type = (await read(1))[0];
    if (type === 2) continue;
    if (type === 1) { const head = await read(5); await read(head.readUInt16BE(3) * 6); continue; }
    if (type === 3) { const head = await read(7); await read(head.readUInt32BE(3)); continue; }
    if (type !== 0) throw new Error('Unexpected RFB server message ' + type);
    const count = (await read(3)).readUInt16BE(1);
    let pixel;
    for (let i = 0; i < count; i++) {
      const rect = await read(12);
      const [rx, ry, width, height] = [0, 2, 4, 6].map(offset => rect.readUInt16BE(offset));
      const encoding = rect.readInt32BE(8);
      if (encoding === CURSOR) { await read(width * height * 4 + ((width + 7) >> 3) * height); continue; }
      if (encoding !== RAW) throw new Error('Unexpected RFB encoding ' + encoding);
      const data = await read(width * height * 4);
      if (x >= rx && x < rx + width && y >= ry && y < ry + height) {
        const value = data.readUInt32LE(((y - ry) * width + (x - rx)) * 4);
        pixel = { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
      }
    }
    if (pixel) return pixel;
  }
}

/**
 * Authenticates to an RFB 3.8 server on a Unix socket and reads the centre pixel with raw 1×1 updates.
 * It re-requests until `until(pixel)` holds or `timeoutMs` passes, and returns the last pixel either way.
 */
export async function readPixel({ socketPath, password, until = () => true, timeoutMs = 20_000 }) {
  const socket = net.connect({ path: socketPath });
  let buffered = Buffer.alloc(0), wake, failure;
  socket.on('data', bytes => { buffered = Buffer.concat([buffered, bytes]); wake?.(); });
  socket.on('error', error => { failure = error; wake?.(); });
  socket.on('close', () => { failure ??= new Error('RFB connection closed'); wake?.(); });
  const deadline = Date.now() + timeoutMs;
  const read = async n => {
    while (buffered.length < n) {
      if (failure) throw failure;
      if (Date.now() > deadline) throw new Error('RFB read timed out');
      await new Promise(accept => { wake = accept; setTimeout(accept, 25); });
    }
    const out = buffered.subarray(0, n);
    buffered = buffered.subarray(n);
    return out;
  };
  try {
    const banner = (await read(12)).toString('latin1');
    if (!/^RFB \d{3}\.\d{3}\n$/.test(banner)) throw new Error('Not an RFB server: ' + JSON.stringify(banner));
    socket.write('RFB 003.008\n');
    const types = [...await read((await read(1))[0])];
    if (!types.includes(2)) throw new Error('RFB server offers no VNC authentication: ' + types.join(','));
    socket.write(Buffer.from([2]));
    socket.write(vncResponse(password, await read(16)));
    if ((await read(4)).readUInt32BE() !== 0) throw new Error('VNC authentication failed');
    socket.write(Buffer.from([1]));
    const init = await read(24);
    const width = init.readUInt16BE(0), height = init.readUInt16BE(2);
    await read(init.readUInt32BE(20));
    socket.write(SET_PIXEL_FORMAT);
    socket.write(SET_ENCODINGS);
    const x = width >> 1, y = height >> 1;
    for (;;) {
      socket.write(updateRequest(x, y));
      const result = { width, height, x, y, ...await updatedPixel(read, x, y) };
      if (until(result) || Date.now() + 250 > deadline) return result;
      await sleep(250);
    }
  } finally { socket.destroy(); }
}

/** `pid` and every descendant, through /proc/<pid>/task/<tid>/children. A pid that is gone yields nothing. */
export async function processTree(pid, procRoot = '/proc') {
  const found = [];
  const walk = async current => {
    let tasks;
    try { tasks = await fs.readdir(join(procRoot, String(current), 'task')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (found.includes(current)) return;
    found.push(current);
    for (const task of tasks) {
      const children = await fs.readFile(join(procRoot, String(current), 'task', task, 'children'), 'utf8').catch(() => '');
      for (const child of children.split(/\s+/).filter(Boolean)) await walk(Number(child));
    }
  };
  await walk(pid);
  return found;
}

/** TCP sockets in LISTEN state that one of `pids` holds open, matched by inode from /proc/net/tcp{,6} to /proc/<pid>/fd. */
export async function tcpListeners(pids, procRoot = '/proc') {
  const listening = new Set();
  for (const file of ['tcp', 'tcp6']) {
    const text = await fs.readFile(join(procRoot, 'net', file), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A') listening.add(fields[9]);
    }
  }
  const found = [];
  for (const pid of pids) {
    let fds;
    try { fds = await fs.readdir(join(procRoot, String(pid), 'fd')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const fd of fds) {
      const inode = (await fs.readlink(join(procRoot, String(pid), 'fd', fd)).catch(() => '')).match(/^socket:\[(\d+)\]$/)?.[1];
      if (inode && listening.has(inode)) found.push({ pid, fd: Number(fd), inode });
    }
  }
  return found;
}

/** The first line `child` prints on stdout, without its newline. Rejects if it exits or stays silent first. */
export function firstLine(child, timeoutMs = 15_000) {
  return new Promise((accept, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('fixture printed nothing within ' + timeoutMs + ' ms')), timeoutMs);
    child.stdout.on('data', bytes => {
      text += bytes;
      if (text.includes('\n')) { clearTimeout(timer); accept(text.slice(0, text.indexOf('\n'))); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('fixture exited (' + code + ') before printing')); });
  });
}
