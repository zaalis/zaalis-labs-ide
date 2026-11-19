'use strict';

function mobileAllowed(method, routePath) {
  const key = `${String(method || 'GET').toUpperCase()} ${routePath}`;
  return /^(GET|PUT) \/chats$/.test(key)
      || key === 'GET /recent-projects'
      || key === 'POST /chat'
      || key === 'GET /ollama-models'
      || key === 'GET /gguf-models'
      || key === 'GET /remote/status'
      || key === 'POST /remote/stop';
}

function tunnelRouteAllowed(method, routePath) {
  const upper = String(method || 'GET').toUpperCase();
  if (upper === 'GET' && (routePath === '/m' || routePath.startsWith('/mobile/'))) return true;
  if (upper === 'GET' && routePath === '/api/auth/me') return true;
  if (!routePath.startsWith('/api/')) return false;
  return mobileAllowed(upper, routePath.slice(4));
}

module.exports = { mobileAllowed, tunnelRouteAllowed };
