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
        ? 'Give the agent its own browser on a private virtual screen (noVNC); --cdp keeps the CDP viewer'
        : 'Check the configured browser backend without changing it');
      command
        .option('--state-dir <path>', 'Private Clawser state directory')
        .option('--browser-profile <name>', 'Existing OpenClaw browser profile to hand off')
        .option('--port <port>', 'Loopback viewer/controller port')
        .option('--cdp', 'Use the one-tab CDP viewer on an existing browser')
        .option('--novnc', 'Use the private virtual screen (the default)');
      if (name === 'setup') command
        .option('--dry-run', 'Show the setup plan without making changes')
        .option('--yes', "Go ahead when setup has to close the agent's browser")
        .option('--migrate-cookies', "Copy logins into the agent's browser")
        .option('--no-migrate-cookies', 'Do not copy logins into the agent browser')
        .option('--tunnel <mode>', 'noVNC public tunnel: on-demand (default) or always')
        .option('--tunnel-idle-minutes <minutes>', 'Minutes an on-demand tunnel stays up after the last handoff (default 10)')
        .option('--viewer-idle-minutes <minutes>', 'Minutes a handoff may have no viewer open before it ends (default 10)');
      command.action(async options => {
        const argv = [name];
        for (const [key, flag] of [['stateDir', '--state-dir'], ['browserProfile', '--browser-profile'], ['port', '--port'], ['tunnel', '--tunnel'], ['tunnelIdleMinutes', '--tunnel-idle-minutes'], ['viewerIdleMinutes', '--viewer-idle-minutes']]) {
          if (options[key] !== undefined) argv.push(flag, String(options[key]));
        }
        for (const [key, flag] of [['cdp', '--cdp'], ['novnc', '--novnc'], ['dryRun', '--dry-run'], ['yes', '--yes']]) if (options[key]) argv.push(flag);
        if (options.migrateCookies === true) argv.push('--migrate-cookies');
        else if (options.migrateCookies === false) argv.push('--no-migrate-cookies');
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
    // Offline operator maintenance for the noVNC controller; it never runs while the controller does.
    root.command('recover').description('With the noVNC controller stopped, clear browser-call admissions it can prove are over')
      .option('--state-dir <path>', 'Private Clawser state directory')
      .option('--dry-run', 'Show what would be cleared without changing anything')
      .option('--abandon-calls', 'Also clear calls that name no Gateway (from Clawser 1.0.1 or earlier, or a Gateway it could not identify), after openclaw gateway restart')
      .action(async options => {
        const argv = ['recover'];
        if (options.stateDir !== undefined) argv.push('--state-dir', String(options.stateDir));
        if (options.dryRun) argv.push('--dry-run');
        if (options.abandonCalls) argv.push('--abandon-calls');
        try {
          if (typeof api.rootDir !== 'string' || !api.rootDir) throw new Error('OpenClaw did not provide the stable installed plugin directory; reinstall Clawser or use its standalone CLI');
          const run = dependencies.runClawser ?? (await import('./setup.mjs')).runClawser;
          const result = await run(argv, { openclawInvocation: { command: process.execPath, prefixArgs: [process.argv[1]] }, packageDir: api.rootDir });
          if (result?.ok === false) process.exitCode = 1;
          return result;
        } catch (error) {
          const report = dependencies.reportError ?? (message => process.stderr.write(`${message}\n`));
          report(`Clawser: ${error instanceof Error ? error.message : 'Recovery failed'}`);
          process.exitCode = 1;
          return { ok: false };
        }
      });
  }, { descriptors: [clawserCliDescriptor] });
  return true;
}
