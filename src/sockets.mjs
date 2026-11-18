// A peer that never closes its side would otherwise keep a refused socket, and a connection slot, open,
// and stall server.close(). The socket goes once the reply is flushed, or after a second at most.
export function refuseSocket(socket, response) {
  if (socket.destroyed) return;
  const limit = setTimeout(() => socket.destroy(), 1000);
  limit.unref?.();
  socket.end(response, () => { clearTimeout(limit); socket.destroy(); });
}

// server.close() waits for every open connection. After a grace period the rest are cut, so a stuck
// peer can't hold up the shutdown, or the tunnel teardown that follows it.
export async function closeServer(server, sockets, graceMs) {
  if (!server.listening) return;
  const closed = new Promise((resolvePromise) => server.close(resolvePromise));
  const timer = setTimeout(() => {
    server.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
  }, graceMs);
  timer.unref?.();
  try { await closed; } finally { clearTimeout(timer); }
}
