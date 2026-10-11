'use strict';
const { text, fail } = require('../common');
async function homeassistant(connections, name, i, ctx) {
  const token = value => { const result = text(value, 'identifier', 200); if (!/^[a-zA-Z0-9_.-]+$/.test(result)) throw fail('Invalid Home Assistant identifier.'); return result; };
  let route = '/api/', method = 'GET', body;
  if (name === 'ha_get_state') route += 'states/' + token(i.entity_id);
  else if (name === 'ha_list_entities') route += 'states';
  else if (name === 'ha_list_services') route += 'services';
  else if (name === 'ha_call_service') { route += `services/${token(i.domain)}/${token(i.service)}`; method = 'POST'; body = i.service_data || i.data || {}; }
  else throw fail('Unknown Home Assistant tool.');
  const result = await connections.request(ctx.userId, 'homeassistant', route, { method, body, signal: ctx.signal });
  return name === 'ha_list_entities' && i.domain ? result.filter(row => row.entity_id.startsWith(i.domain + '.')) : result;
}
module.exports = { homeassistant };
