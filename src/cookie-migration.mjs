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
  await withBrowser(cdpUrl, d, async cdp => {
    for (let i = 0; i < cookies.length; i += BATCH) await cdp.send('Storage.setCookies', { cookies: cookies.slice(i, i + BATCH).map(cookieParam) });
  });
  return { count: cookies.length };
}

export async function closeBrowser(cdpUrl, d) {
  await withBrowser(cdpUrl, d, async cdp => {
    // A closing browser drops the connection before it can reply.
    try { await cdp.send('Browser.close'); } catch (error) { if (error.message !== 'Browser disconnected') throw error; }
  });
}

/** Closes the browser so it saves its cookies, then waits for its service to start it again. */
export async function flushCookies(cdpUrl, d, { timeoutMs = 60_000 } = {}) {
  await closeBrowser(cdpUrl, d);
  const polls = Math.ceil(timeoutMs / POLL_MS);
  let wentAway = false;
  for (let poll = 0; poll < polls; poll++) {
    const up = await browserEndpoint(cdpUrl, d).then(() => true, () => false);
    if (!up) wentAway = true;
    else if (wentAway) return;
    if (poll < polls - 1) await d.sleep(POLL_MS);
  }
  throw new Error(`The browser did not come back within ${Math.ceil(timeoutMs / 1000)} seconds after saving cookies.`);
}

/** Returns how many cookies the browser at `cdpUrl` holds. */
export async function countCookies(cdpUrl, d) {
  return (await readCookies(cdpUrl, d)).length;
}
