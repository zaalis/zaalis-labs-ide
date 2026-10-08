'use strict';
const { text, fail } = require('../common');
const id = value => { const result = text(value, 'Discord id', 32); if (!/^\d+$/.test(result)) throw fail('Invalid Discord id.'); return result; };
async function discord(connections, name, input, ctx) {
  const aliases={get_channel:'fetch_channel',messages:'fetch_messages',get_member:'fetch_member',send:'send_message',thread:'create_thread',roles:'list_roles',update_channel:'edit_channel',add_role:'assign_role',update_role:'edit_role'};
  const action = aliases[input.action] || input.action || 'list_guilds', channel = () => id(input.channel_id), guild = () => id(input.guild_id);
  const routes = {
    list_guilds: () => ['GET', '/users/@me/guilds'], list_channels: () => ['GET', `/guilds/${guild()}/channels`],
    fetch_channel: () => ['GET', `/channels/${channel()}`], fetch_messages: () => ['GET', `/channels/${channel()}/messages`, undefined, { limit: Math.min(100, input.limit || 20), before: input.before, after: input.after }],
    search_members: () => ['GET', `/guilds/${guild()}/members/search`, undefined, { query: text(input.query, 'query', 100), limit: Math.min(100, input.limit || 20) }],
    fetch_member: () => ['GET', `/guilds/${guild()}/members/${id(input.user_id)}`],
    send_message: () => ['POST', `/channels/${channel()}/messages`, { content: text(input.content || input.text, 'content', 2000), allowed_mentions: { parse: [] } }],
    react: () => ['PUT', `/channels/${channel()}/messages/${id(input.message_id)}/reactions/${encodeURIComponent(text(input.emoji, 'emoji', 100))}/@me`],
    create_thread: () => ['POST', `/channels/${channel()}/threads`, { name: text(input.name, 'name', 100), type: 11 }],
    list_roles: () => ['GET', `/guilds/${guild()}/roles`], create_channel: () => ['POST', `/guilds/${guild()}/channels`, { name: text(input.name, 'name', 100), type: input.type || 0 }],
    edit_channel: () => ['PATCH', `/channels/${channel()}`, input.data || input.fields || {}], delete_channel: () => ['DELETE', `/channels/${channel()}`],
    create_role: () => ['POST', `/guilds/${guild()}/roles`, {...input.fields,name:text(input.name,'name',100)}], edit_role:()=>['PATCH',`/guilds/${guild()}/roles/${id(input.role_id)}`,input.fields||input.data||{}],delete_role:()=>['DELETE',`/guilds/${guild()}/roles/${id(input.role_id)}`],
    assign_role: () => ['PUT', `/guilds/${guild()}/members/${id(input.user_id)}/roles/${id(input.role_id)}`], remove_role: () => ['DELETE', `/guilds/${guild()}/members/${id(input.user_id)}/roles/${id(input.role_id)}`],
    timeout: () => ['PATCH', `/guilds/${guild()}/members/${id(input.user_id)}`, { communication_disabled_until: input.until || null }],
    kick: () => ['DELETE', `/guilds/${guild()}/members/${id(input.user_id)}`], ban: () => ['PUT', `/guilds/${guild()}/bans/${id(input.user_id)}`, { delete_message_seconds: 0 }], unban: () => ['DELETE', `/guilds/${guild()}/bans/${id(input.user_id)}`],
    pin: () => ['PUT', `/channels/${channel()}/messages/pins/${id(input.message_id)}`], unpin: () => ['DELETE', `/channels/${channel()}/messages/pins/${id(input.message_id)}`],
    delete_message: () => ['DELETE', `/channels/${channel()}/messages/${id(input.message_id)}`],
  };
  const readOnlyActions = new Set(['list_guilds', 'list_channels', 'fetch_channel', 'fetch_messages', 'search_members', 'fetch_member', 'send_message', 'react', 'create_thread']);
  if (!routes[action] || (name === 'discord' && !readOnlyActions.has(action))) throw fail('Unsupported Discord action; administration requires discord_admin.');
  const [method, route, body, query] = routes[action](); return connections.request(ctx.userId, 'discord', route, { method, body, query, signal: ctx.signal });
}
module.exports = { discord };
