import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activationTargetFingerprint } from '../src/browser-activation.mjs';
import { resolveHandoffBrowser } from '../src/browser-config.mjs';

export function activationFixture(config, deps) {
  let diagnostic;
  deps.readActivationDiagnostic = async () => diagnostic && structuredClone(diagnostic);
  return {
    get diagnostic() { return diagnostic; },
    set diagnostic(value) { diagnostic = value; },
    async publish(overrides = {}) {
      const pluginConfig = config.plugins.entries['browser-handoff'].config;
      const binding = resolveHandoffBrowser({ config, pluginConfig });
      const stat = deps.readProcessStartTicks ? undefined : await readFile('/proc/' + process.pid + '/stat', 'utf8');
      diagnostic = { version: 1, generation: randomUUID(), phase: 'active', backend: binding.backend,
        profile: binding.profile, targetFingerprint: activationTargetFingerprint({ config, pluginConfig }),
        updatedAt: deps.now?.() ?? Date.now(), producerPid: process.pid,
        producerStartTicks: stat ? stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19] : await deps.readProcessStartTicks(process.pid),
        publicTransport: binding.backend === 'cdp' ? 'ready' : 'on-demand', ...overrides };
      return structuredClone(diagnostic);
    },
  };
}
