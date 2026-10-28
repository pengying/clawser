// Resolve configuration only. Browser availability is checked by the selected
// backend; this module never discovers, launches or copies a browser profile.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.trim() === value && value.length > 0;

export function cdpOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Browser CDP must be an explicit loopback HTTP origin'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Browser CDP must be an explicit loopback HTTP origin');
  return url.origin;
}

function eligibleOrigin(browser, profile) {
  if (!name(profile) || !object(browser.profiles) || !Object.hasOwn(browser.profiles, profile) || !object(browser.profiles[profile]))
    throw new Error('An explicitly configured existing browser profile is required');
  const connection = browser.profiles[profile];
  if ((connection.attachOnly ?? browser.attachOnly) !== true) throw new Error('Browser profile requires attachOnly=true; browser launch is unsupported');
  if (connection.driver !== undefined && !['openclaw', 'clawd', 'existing-session'].includes(connection.driver))
    throw new Error('Browser profile requires a compatible CDP driver');
  if (connection.engine !== undefined && connection.engine !== 'chromium') throw new Error('Browser profile requires the Chromium engine');
  return cdpOrigin(connection.cdpUrl);
}

export function resolveHandoffBrowser({ config, pluginConfig = {}, profile } = {}) {
  const browser = config?.browser;
  if (!object(browser)) throw new Error('Current browser configuration is unavailable');
  if (browser.enabled === false) throw new Error('Browser is disabled in current configuration');
  const desktop = pluginConfig.desktop?.enabled === true;
  const selected = desktop ? pluginConfig.desktop.profile : profile ?? browser.defaultProfile;
  if (!name(selected)) throw new Error('An explicitly configured existing default browser profile is required');
  if (desktop && profile !== undefined && profile !== selected) throw new Error('Only the configured desktop browser profile is permitted');
  const cdpUrl = eligibleOrigin(browser, selected);
  const entries = [[selected, cdpUrl]];
  if (pluginConfig.profiles !== undefined && !object(pluginConfig.profiles)) throw new Error('Invalid configured browser profile mappings');
  for (const [legacy, value] of Object.entries(pluginConfig.profiles || {})) {
    const origin = eligibleOrigin(browser, legacy);
    if (cdpOrigin(value) !== origin) throw new Error('Browser profile CDP mapping does not match current host configuration');
    if (!desktop || legacy === selected) entries.push([legacy, origin]);
  }
  return { backend: desktop ? 'novnc' : 'cdp', profile: selected, cdpUrl, profiles: Object.fromEntries(entries) };
}

export function currentBrowserConfig(api) {
  let config;
  try { config = api.runtime.config.current(); }
  catch { throw new Error('Current browser configuration API is unavailable'); }
  if (!object(config) || !object(config.browser)) throw new Error('Current browser configuration is incomplete');
  return config;
}

export function browserBindingKey(binding) {
  return JSON.stringify([binding.backend, binding.profile, binding.cdpUrl, Object.entries(binding.profiles).sort(([a], [b]) => a.localeCompare(b))]);
}
