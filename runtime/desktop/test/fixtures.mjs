import { writeFile } from 'node:fs/promises';

export function inspection(owner='owner',id='owned',name='openclaw-handoff-desktop') {
  const ports={'9223/tcp':[{HostIp:'127.0.0.1',HostPort:'18810'}],'5900/tcp':[{HostIp:'127.0.0.1',HostPort:'59090'}]};
  return {Id:id,Name:'/' + name,Config:{Labels:{'openclaw.browser-handoff.desktop':owner}},State:{Running:true},HostConfig:{NetworkMode:name + '-net',PortBindings:ports},NetworkSettings:{Ports:ports,Networks:{[name + '-net']:{NetworkID:'network-id'}}},Mounts:[{Type:'volume',Name:name + '-profile',Destination:'/profile',RW:true}]};
}
export async function receipt(stateDir,owner='owner',id='owned',name='openclaw-handoff-desktop') {
  await writeFile(`${stateDir}/ownership.json`,JSON.stringify({name,ownerId:owner,containerId:id,network:name + '-net',volume:name + '-profile',networkId:'network-id',cdpPort:18810,vncPort:59090}));
}

