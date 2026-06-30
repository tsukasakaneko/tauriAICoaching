'use strict';

// Shared SSE client registry — imported by both autorecord.js and auth.js
// so both can broadcast events to connected Tauri windows.
const sseClients = new Map(); // userId → Set<Response>

function register(userId, res) {
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);
}

function unregister(userId, res) {
  const clients = sseClients.get(userId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(userId);
  }
}

function broadcast(userId, eventName, data) {
  const clients = sseClients.get(userId);
  if (!clients) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...clients]) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function getAllUserIds() {
  return sseClients.keys();
}

module.exports = { register, unregister, broadcast, getAllUserIds };
