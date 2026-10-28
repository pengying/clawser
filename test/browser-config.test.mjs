import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as browserConfig from '../src/browser-config.mjs';

const host = () => ({ browser: { defaultProfile: 'daily', profiles: {
  daily: { cdpUrl: 'http://127.0.0.1:9222/', attachOnly: true, driver: 'existing-session', engine: 'chromium' },
  spare: { cdpUrl: 'http://localhost:9223', attachOnly: true, driver: 'openclaw' },
} } });
const resolve = value => browserConfig.resolveHandoffBrowser(value);
test('resolves only the explicitly configured existing default without launching or guessing', () => {
  assert.deepEqual(resolve({ config: host() }), { backend: 'cdp', profile: 'daily', cdpUrl: 'http://127.0.0.1:9222', profiles: { daily: 'http://127.0.0.1:9222' } });
  assert.equal(resolve({ config: host(), profile: 'spare' }).profile, 'spare');
  const config = host(); delete config.browser.defaultProfile;
  assert.throws(() => resolve({ config }), /default|profile/i);
  assert.equal(resolve({ config, profile: 'spare' }).profile, 'spare');
});
test('explicit noVNC selects its configured profile and validates its mapping', () => {
  const pluginConfig = { desktop: { enabled: true, profile: 'spare' } };
  assert.equal(resolve({ config: host(), pluginConfig }).backend, 'novnc');
  assert.equal(resolve({ config: host(), pluginConfig }).profile, 'spare');
  assert.throws(() => resolve({ config: host(), pluginConfig, profile: 'daily' }), /profile/i);
  assert.throws(() => resolve({ config: host(), pluginConfig: { desktop: { enabled: true } } }), /profile/i);
});
test('legacy mappings must match eligible explicitly configured host profiles', () => {
  const config = host(), pluginConfig = { profiles: { spare: 'http://localhost:9223/' } };
  assert.deepEqual(resolve({ config, pluginConfig }).profiles, { daily: 'http://127.0.0.1:9222', spare: 'http://localhost:9223' });
  assert.throws(() => resolve({ config, pluginConfig: { profiles: { spare: 'http://localhost:9555' } } }), /match/i);
  assert.throws(() => resolve({ config, profile: 'user' }), /configured|profile/i);
  assert.throws(() => resolve({ config, profile: 'toString' }), /configured|profile/i);
});
test('rejects missing, non-Chromium, launchable, disabled and implicit discovery connections', () => {
  for (const patch of [{ attachOnly: false }, { attachOnly: undefined }, { cdpUrl: undefined }, { driver: 'extension' }, { engine: 'firefox' }, { driver: 'unknown' }]) {
    const config = host(); Object.assign(config.browser.profiles.daily, patch);
    assert.throws(() => resolve({ config }), /attach|CDP|driver|Chromium/i);
  }
  const inherited = host(); delete inherited.browser.profiles.daily.attachOnly; inherited.browser.attachOnly = true;
  assert.equal(resolve({ config: inherited }).profile, 'daily');
  const config = host(); config.browser.enabled = false;
  assert.throws(() => resolve({ config }), /disabled/i);
  for (const driver of ['openclaw', 'clawd', 'existing-session', undefined]) {
    const config = host(); config.browser.profiles.daily.driver = driver;
    assert.equal(resolve({ config }).profile, 'daily');
  }
});
test('rejects non-loopback origins, credentials, paths, websocket guesses and malformed URLs', () => {
  for (const cdpUrl of ['http://example.com:9222', 'http://127.0.0.1:9222/path', 'http://owner@localhost:9222', 'http://localhost:9222/?x=1', 'http://localhost:9222/#x', 'ws://localhost:9222/devtools/browser/id', 'invalid']) {
    const config = host(); config.browser.profiles.daily.cdpUrl = cdpUrl;
    assert.throws(() => resolve({ config }), /CDP|loopback/i);
  }
});
test('current config comes only from the live runtime API and incomplete reads fail closed', () => {
  const config = host();
  assert.equal(browserConfig.currentBrowserConfig({ config: {}, runtime: { config: { current: () => config } } }), config);
  for (const runtime of [undefined, {}, { config: { current: () => { throw new Error('offline'); } } }, { config: { current: () => ({}) } }, { config: { current: async () => config } }]) {
    assert.throws(() => browserConfig.currentBrowserConfig({ config, runtime }), /current|config/i);
  }
});
test('binding fingerprint is stable for ordering and changes for selected profile or endpoint', () => {
  const binding = resolve({ config: host(), pluginConfig: { profiles: { spare: 'http://localhost:9223' } } });
  const key = browserConfig.browserBindingKey(binding);
  assert.equal(browserConfig.browserBindingKey({ ...binding, profiles: Object.fromEntries(Object.entries(binding.profiles).reverse()) }), key);
  assert.notEqual(browserConfig.browserBindingKey({ ...binding, profile: 'spare' }), key);
});
