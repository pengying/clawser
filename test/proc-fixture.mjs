import * as fs from 'node:fs/promises';
import { join } from 'node:path';

// A fake /proc under <root>/proc: pid folders and the net/tcp listen tables.
const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
export const row = (address, port, inode, st = '0A') =>
  `   0: ${address}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0 100 0\n`;
export const NUL = (...parts) => parts.join('\0') + '\0';

export async function proc(root, pid, { exe = '/opt/google/chrome/chrome', argv = ['/opt/google/chrome/chrome'], env = [], cgroup = '0::/', sockets = [] } = {}) {
  const dir = join(root, 'proc', String(pid));
  await fs.mkdir(join(dir, 'fd'), { recursive: true });
  await fs.symlink(exe, join(dir, 'exe'));
  await fs.writeFile(join(dir, 'cmdline'), NUL(...argv));
  await fs.writeFile(join(dir, 'environ'), NUL(...env));
  await fs.writeFile(join(dir, 'cgroup'), cgroup + '\n');
  for (const [i, inode] of sockets.entries()) await fs.symlink(`socket:[${inode}]`, join(dir, 'fd', String(i + 3)));
}

export async function net(root, tcp = '', tcp6 = '') {
  await fs.mkdir(join(root, 'proc/net'), { recursive: true });
  await fs.writeFile(join(root, 'proc/net/tcp'), HEADER + tcp);
  await fs.writeFile(join(root, 'proc/net/tcp6'), HEADER + tcp6);
}
