import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const installationRoot = '/opt/google/chrome';
const limits = { timeoutMs: 120_000, maxFiles: 4096, maxBytes: 1024 ** 3 };
const within = (root, path) => {
  const child = relative(root, path);
  return !!child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
const validPath = path => typeof path === 'string' && isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path);

// CI cache preparation only. allowedRoot is a trusted fixture override; the CLI
// always uses the fixed Chrome installation and never launches its executable.
export async function prepareBrowser({ browserPath = process.env.CHROME_BIN, allowedRoot = installationRoot,
  timeoutMs = limits.timeoutMs, maxFiles = limits.maxFiles, maxBytes = limits.maxBytes,
  log = message => console.log(message) } = {}) {
  if (process.platform !== 'linux') throw new Error('Browser prefetch requires Linux directory descriptors');
  if (!validPath(allowedRoot) || !validPath(browserPath)) throw new Error('Browser prefetch requires absolute installation and CHROME_BIN paths');
  for (const [name, value] of Object.entries({ timeoutMs, maxFiles, maxBytes })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > limits[name]) throw new Error(`Invalid browser prefetch ${name} limit`);
  }
  const started = performance.now(), deadline = started + timeoutMs, controller = new AbortController();
  const expired = () => Object.assign(new Error('Browser prefetch time limit exceeded'), { code: 'ETIMEDOUT' });
  const timer = setTimeout(() => controller.abort(expired()), timeoutMs);
  timer.unref();
  const check = () => {
    controller.signal.throwIfAborted();
    if (performance.now() >= deadline) throw expired();
  };
  let files = 0, bytes = 0, rootHandle;
  try {
    const root = resolve(allowedRoot);
    if (await realpath(root) !== root) throw new Error('Browser prefetch installation must be canonical and contain no symlinks');
    const browserRealpath = await realpath(browserPath);
    if (!within(root, browserRealpath)) throw new Error('Selected browser resolves outside the verified installation');
    if (!(await lstat(browserRealpath)).isFile()) throw new Error('Selected browser must be a regular installation file');
    check();
    rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (await realpath(`/proc/self/fd/${rootHandle.fd}`) !== root) throw new Error('Browser prefetch installation changed during verification');

    const walk = async (directory, depth = 0) => {
      check();
      if (depth > 32) throw new Error('Browser prefetch directory depth limit exceeded');
      // Anchor each entry to its already-open parent, including when another
      // process renames the directory or replaces its original pathname.
      const anchor = `/proc/self/fd/${directory.fd}`;
      const entries = await readdir(anchor, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        check();
        if (entry.isSymbolicLink()) continue;
        const path = join(anchor, entry.name), observed = await lstat(path);
        if (observed.isSymbolicLink() || (!observed.isDirectory() && !observed.isFile())) continue;
        const flags = constants.O_RDONLY | constants.O_NOFOLLOW |
          (observed.isDirectory() ? constants.O_DIRECTORY : constants.O_NONBLOCK);
        const handle = await open(path, flags);
        try {
          const current = await handle.stat();
          if (current.dev !== observed.dev || current.ino !== observed.ino || current.mode !== observed.mode)
            throw new Error('Browser prefetch installation entry changed during verification');
          if (current.isDirectory()) { await walk(handle, depth + 1); continue; }
          if (!current.isFile()) throw new Error('Browser prefetch refuses non-regular installation files');
          if (files >= maxFiles) throw new Error('Browser prefetch file limit exceeded');
          if (!Number.isSafeInteger(current.size) || current.size > maxBytes - bytes) throw new Error('Browser prefetch byte limit exceeded');
          let consumed = 0;
          if (current.size) {
            const stream = handle.createReadStream({ autoClose: false, start: 0, end: current.size - 1,
              highWaterMark: 256 * 1024, signal: controller.signal });
            for await (const chunk of stream) {
              check();
              consumed += chunk.length; bytes += chunk.length;
            }
          }
          const after = await handle.stat();
          if (consumed !== current.size || after.size !== current.size || after.mtimeMs !== current.mtimeMs)
            throw new Error('Browser prefetch installation file changed while reading');
          files++;
        } finally { await handle.close(); }
      }
    };
    await walk(rootHandle);
    check();
    const summary = { files, bytes, durationMs: performance.now() - started,
      browserPath: resolve(browserPath), browserRealpath, installationRoot: root };
    log(JSON.stringify(summary));
    return summary;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    await rootHandle?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareBrowser(); }
  catch (error) {
    console.error(`Browser prefetch failed: ${error.code || error.message}`);
    process.exitCode = 1;
  }
}
