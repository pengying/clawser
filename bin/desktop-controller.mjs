#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';
import { DesktopController } from '../src/desktop-controller.mjs';
import { DesktopRuntime } from '../runtime/desktop/index.mjs';
import { CloudflareTransport } from '../src/cloudflare-transport.mjs';

// This file is local operator configuration, never an invitation or browser API.
const configPath=process.argv[2];
if(!configPath||process.argv.length!==3)throw new Error('Usage: desktop-controller.mjs /absolute/private/config.json');
if(!isAbsolute(configPath))throw new Error('Controller configuration path must be absolute');
const info=await lstat(configPath);
if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077))throw new Error('Controller configuration must be an owner-only regular file');
const config=JSON.parse(await readFile(configPath,'utf8'));
const fromConfig=value=>isAbsolute(value)?value:resolve(dirname(configPath),value);
if(typeof config.stateDir!=='string'||typeof config.profile!=='string')throw new Error('Controller stateDir and profile are required');
const stateDir=fromConfig(config.stateDir);
const runtimeOptions={...config.runtime,stateDir:config.runtime?.stateDir?fromConfig(config.runtime.stateDir):resolve(stateDir,'runtime')};
const transportOptions={...config.transport,stateDir:config.transport?.stateDir?fromConfig(config.transport.stateDir):resolve(stateDir,'tunnel')};
const runtime=new DesktopRuntime(runtimeOptions);
const transport=new CloudflareTransport(transportOptions);
const controller=new DesktopController({stateDir,profile:config.profile,runtime,transport,port:config.port??19410,...(config.socketPath?{socketPath:fromConfig(config.socketPath)}:{}),...(config.noVncAssetsDir?{noVncAssetsDir:fromConfig(config.noVncAssetsDir)}:{})});
await controller.start();
process.stdout.write('Browser Handoff desktop controller ready\n');
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;try{await controller.close();process.exitCode=0;}catch{process.exitCode=1;}};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
