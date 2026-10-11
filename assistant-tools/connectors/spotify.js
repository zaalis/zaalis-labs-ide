'use strict';
const { text, fail } = require('../common');
const id = value => { const result = text(value, 'Spotify id', 100); if (!/^[a-zA-Z0-9]+$/.test(result)) throw fail('Invalid Spotify id.'); return result; };
async function spotify(connections, name, i, ctx) {
  const group = name.replace('spotify_', ''), action = i.action || 'get'; let method = 'GET', route, body, query = {};
  const paging = { limit: Math.min(50, Number(i.limit) || 20), offset: Math.max(0, Number(i.offset) || 0), market: i.market };
  if (group === 'search') { route = '/search'; query = { ...paging, q: text(i.query, 'query', 400), type: i.type || 'track' }; }
  else if (group === 'albums') { route = `/albums/${id(i.album_id || i.id)}` + (action === 'tracks' ? '/tracks' : ''); query = paging; }
  else if (group === 'devices') { route = '/me/player/devices'; if (action === 'transfer') { method = 'PUT'; route = '/me/player'; body = { device_ids: [text(i.device_id, 'device_id', 100)], play: !!i.play }; } }
  else if (group === 'queue') { route = '/me/player/queue'; if (action === 'add') { method = 'POST'; query = { uri: text(i.uri, 'uri', 200), device_id: i.device_id }; } }
  else if (group === 'playback') {
    const paths = { get: '', state: '', play: '/play', pause: '/pause', next: '/next', previous: '/previous', seek: '/seek', shuffle: '/shuffle', repeat: '/repeat', volume: '/volume', recent: '/recently-played' };
    if (!(action in paths)) throw fail('Unknown playback action.'); route = '/me/player' + paths[action];
    if (!['get', 'state', 'recent'].includes(action)) method = ['next', 'previous'].includes(action) ? 'POST' : 'PUT';
    query = { device_id: i.device_id, ...(action === 'seek' ? { position_ms: i.position_ms } : action === 'volume' ? { volume_percent: i.volume_percent } : ['repeat', 'shuffle'].includes(action) ? { state: i.state } : {}) };
    if (action === 'play') body = { ...(i.uris ? { uris: i.uris } : {}), ...(i.context_uri ? { context_uri: i.context_uri } : {}) };
  } else if (group === 'library') {
    const type = i.type === 'album' ? 'albums' : 'tracks'; route = '/me/' + type; query = paging;
    if (['save', 'remove', 'contains'].includes(action)) { const uris=i.uris||(i.ids||[i.id]).map(value=>'spotify:'+(type==='albums'?'album':'track')+':'+id(value));if(!uris.length||uris.length>50||uris.some(u=>!/^spotify:(track|album|episode|show|artist|playlist|audiobook):[A-Za-z0-9]+$/.test(u)))throw fail('One to fifty valid Spotify URIs required.');route='/me/library'+(action==='contains'?'/contains':'');query={uris:uris.join(',')};method=action==='save'?'PUT':action==='remove'?'DELETE':'GET'; }
  } else if (group === 'playlists') {
    if (action === 'list' || (action === 'get' && !i.playlist_id && !i.id)) { route = '/me/playlists'; query = paging; }
    else if (action === 'create') { route = '/me/playlists'; method = 'POST'; body = { name: text(i.name, 'name', 200), public: i.public === true, description: String(i.description || '') }; }
    else {
      route = `/playlists/${id(i.playlist_id || i.id)}`;
      if (['tracks', 'items', 'add', 'remove', 'replace'].includes(action)) { route += '/items'; method = { add: 'POST', remove: 'DELETE', replace: 'PUT', tracks: 'GET', items:'GET' }[action]; query = paging; if (!['tracks','items'].includes(action)) body = action === 'remove' ? { items: (i.uris || []).map(uri => ({ uri })) } : { uris: i.uris || [] }; }
      else if (action === 'update') { method = 'PUT'; body = { name: i.name, description: i.description, public: i.public }; }
      else if (action !== 'get') throw fail('Unknown playlist action.');
    }
  } else throw fail('Unknown Spotify tool.');
  return connections.request(ctx.userId, 'spotify', route, { method, body, query, signal: ctx.signal });
}
module.exports = { spotify };
