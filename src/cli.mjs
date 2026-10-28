export const clawserCliDescriptor = Object.freeze({
  name: 'clawser',
  description: 'Set up and check the Clawser browser handoff runtime',
  hasSubcommands: true,
});

// CLI registration is metadata-only. Provisioning is imported only when an
// operator invokes a command, never during discovery or an agent tool call.
export function registerClawserCli(api, dependencies = {}) {
  if (typeof api.registerCli !== 'function') return false;
  api.registerCli(({ program }) => {
    const root = program.command('clawser').description(clawserCliDescriptor.description);
    for (const name of ['setup', 'doctor']) {
      const command = root.command(name).description(name === 'setup'
        ? 'Configure handoff using the existing default browser CDP connection'
        : 'Check the configured browser backend without changing it');
      command
        .option('--novnc', 'Use the dedicated Docker desktop instead of existing-browser CDP')
        .option('--state-dir <path>', 'Private Clawser state directory')
        .option('--browser-profile <name>', 'Existing OpenClaw browser connection (dedicated profile with --novnc)')
        .option('--port <port>', 'Loopback viewer/controller port')
        .option('--cdp-port <port>', 'Loopback Chromium debugging port')
        .option('--vnc-port <port>', 'Loopback VNC port')
        .option('--container-name <name>', 'Dedicated Docker container name');
      if (name === 'setup') command
        .option('--dry-run', 'Show the setup plan without making changes')
        .option('--no-default-profile', 'Keep the current default browser profile');
      command.action(async options => {
        const argv = [name];
        for (const [key, flag] of [
          ['stateDir', '--state-dir'], ['browserProfile', '--browser-profile'],
          ['port', '--port'], ['cdpPort', '--cdp-port'],
          ['vncPort', '--vnc-port'], ['containerName', '--container-name'],
        ]) if (options[key] !== undefined) argv.push(flag, String(options[key]));
        if (options.novnc) argv.push('--novnc');
        if (options.dryRun) argv.push('--dry-run');
        if (options.defaultProfile === false) argv.push('--no-default-profile');
        try {
          if (typeof api.rootDir !== 'string' || !api.rootDir) {
            throw new Error('OpenClaw did not provide the stable installed plugin directory; reinstall Clawser or use its standalone CLI');
          }
          const run = dependencies.runClawser ?? (await import('./setup.mjs')).runClawser;
          const result = await run(argv, {
            openclawInvocation: { command: process.execPath, prefixArgs: [process.argv[1]] },
            packageDir: api.rootDir,
          });
          if (result?.ok === false) process.exitCode = 1;
          return result;
        } catch (error) {
          const report = dependencies.reportError ?? (message => process.stderr.write(`${message}\n`));
          report(`Clawser: ${error instanceof Error ? error.message : 'Setup or health check failed'}`);
          process.exitCode = 1;
          return { ok: false };
        }
      });
    }
  }, { descriptors: [clawserCliDescriptor] });
  return true;
}
