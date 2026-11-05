import { join } from 'node:path';
import { CdpConnection, browserEndpoint } from './cdp.mjs';

// Cookie names, values and domains never reach d.log or an error message.
const PARAM_FIELDS = ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey'];
const BATCH = 500;
const POLL_MS = 250;

async function withBrowser(cdpUrl, d, work) {
  const cdp = await new CdpConnection({ commandTimeoutMs: 30_000 }).connect(await browserEndpoint(cdpUrl, d));
  try { return await work(cdp); } finally { cdp.close(); }
}

async function readCookies(cdpUrl, d) {
  const { cookies } = await withBrowser(cdpUrl, d, cdp => cdp.send('Storage.getCookies'));
  if (!Array.isArray(cookies)) throw new Error('The browser returned no cookie list');
  return cookies;
}

// A session cookie sent with an expiry would become persistent.
function cookieParam(cookie) {
  const param = {};
  for (const key of PARAM_FIELDS) if (cookie[key] !== undefined) param[key] = cookie[key];
  if (cookie.session !== true && cookie.expires !== undefined) param.expires = cookie.expires;
  return param;
}

/** Writes every cookie of the browser at `cdpUrl` to `<tempDir>/cookies.json` (0600) and returns `{ path, count }`. */
export async function exportCookies(cdpUrl, tempDir, d) {
  const cookies = await readCookies(cdpUrl, d);
  const path = join(tempDir, 'cookies.json');
  const file = await d.fs.open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(cookies)); await file.sync(); } finally { await file.close(); }
  return { path, count: cookies.length };
}

/** Sets the cookies saved at `path` in the browser at `cdpUrl` and returns `{ count }`. */
export async function importCookies(cdpUrl, path, d) {
  let cookies;
  // A JSON syntax error quotes the text around it, which would put cookie values in the message.
  try { cookies = JSON.parse(await d.fs.readFile(path, 'utf8')); } catch { cookies = undefined; }
  if (!Array.isArray(cookies)) throw new Error('The saved cookies could not be read');
  let count = 0;
  await withBrowser(cdpUrl, d, async cdp => {
    const set = params => cdp.send('Storage.setCookies', { cookies: params }).then(() => true, rejected);
    for (let i = 0; i < cookies.length; i += BATCH) {
      const batch = cookies.slice(i, i + BATCH).map(cookieParam);
      if (await set(batch)) { count += batch.length; continue; }
      // The browser rejects a whole batch for one bad cookie. Set the rest one at a time and skip the bad ones.
      for (const param of batch) if (await set([param])) count++;
    }
  });
  return { count };
}

// Only a protocol error rejects a cookie. A dropped connection or a timeout fails the import.
const rejected = error => { if (error.definitive) return false; throw error; };

export async function closeBrowser(cdpUrl, d) {
  await withBrowser(cdpUrl, d, async cdp => {
    // A closing browser drops the connection before it can reply.
    try { await cdp.send('Browser.close'); } catch (error) { if (error.message !== 'Browser disconnected') throw error; }
  });
}

// Polls the endpoint until `done(up)` is true. Returns false when the poll count or the clock runs out first.
async function poll(cdpUrl, d, timeoutMs, done) {
  const polls = Math.ceil(timeoutMs / POLL_MS), deadline = d.now() + timeoutMs;
  for (let attempt = 0; attempt < polls; attempt++) {
    if (done(await browserEndpoint(cdpUrl, d).then(() => true, () => false))) return true;
    if (attempt === polls - 1 || d.now() >= deadline) return false;
    await d.sleep(POLL_MS);
  }
  return false;
}

const seconds = timeoutMs => Math.ceil(timeoutMs / 1000);

/** Waits for the browser at `cdpUrl` to answer on its DevTools port. */
export async function waitForBrowser(cdpUrl, d, { timeoutMs = 60_000 } = {}) {
  if (!await poll(cdpUrl, d, timeoutMs, up => up)) throw new Error(`Clawser's browser did not answer within ${seconds(timeoutMs)} seconds.`);
}

/** Closes the browser so it saves its cookies, then waits for its service to start it again. */
export async function flushCookies(cdpUrl, d, { timeoutMs = 60_000 } = {}) {
  await closeBrowser(cdpUrl, d);
  let wentAway = false;
  const back = up => { if (!up) wentAway = true; return up && wentAway; };
  if (!await poll(cdpUrl, d, timeoutMs, back)) throw new Error(`The browser did not come back within ${seconds(timeoutMs)} seconds after saving cookies.`);
}

/** Returns how many cookies the browser at `cdpUrl` holds. */
export async function countCookies(cdpUrl, d) {
  return (await readCookies(cdpUrl, d)).length;
}
