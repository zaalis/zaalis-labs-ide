'use strict';
const { text, fail } = require('../common');
async function feishu(connections, name, i, ctx) {
  const id = value => encodeURIComponent(text(value, 'document/file id', 200));
  const routes = {
    feishu_read_doc: () => ['GET', i.file_type==='doc'?`/doc/v2/${id(i.document_id||i.token)}/raw_content`:['sheet','sheets'].includes(i.file_type)?`/sheets/v2/spreadsheets/${id(i.document_id||i.token)}/values/${id(i.range||i.sheet_id)}`:`/docx/v1/documents/${id(i.document_id || i.token)}/raw_content`],
    feishu_doc_comments: () => ['GET', `/drive/v1/files/${id(i.file_token || i.token)}/comments`, undefined, { file_type: i.file_type || 'docx', page_size: Math.min(100, i.limit || 50) }],
    feishu_add_doc_comment: () => ['POST', `/drive/v1/files/${id(i.file_token || i.token)}/comments`, { reply_list: { replies: [{ content: { elements: [{ type: 'text', text_run: { text: text(i.text || i.content, 'comment', 10000) } }] } }] }, is_whole: true }, { file_type: i.file_type || 'docx' }],
    feishu_list_files: () => ['GET', '/drive/v1/files', undefined, { folder_token: i.folder_token, page_size: Math.min(200, i.limit || 50) }],
    feishu_search_docs: () => ['POST', '/suite/docs-api/search/object', { search_key: text(i.query, 'query', 1000), count: Math.min(50, i.limit || 20), offset: i.offset || 0 }],
  };
  routes.feishu_drive_list_comment_replies = () => ['GET', `/drive/v1/files/${id(i.file_token || i.token)}/comments/${id(i.comment_id)}/replies`, undefined, {file_type:i.file_type||'docx',page_size:Math.min(100,i.limit||50),page_token:i.page_token}];
  routes.feishu_drive_reply_comment = () => ['POST', `/drive/v1/files/${id(i.file_token || i.token)}/comments/${id(i.comment_id)}/replies`, {content:{elements:[{type:'text',text_run:{text:text(i.text||i.content,'reply',10000)}}]}}, {file_type:i.file_type||'docx'}];
  if (!routes[name]) throw fail('Unknown Feishu action.'); const [method, route, body, query] = routes[name]();
  const result = await connections.request(ctx.userId, 'feishu', route, { method, body, query, signal: ctx.signal });
  if (result.code !== undefined && result.code !== 0) throw fail('Feishu: ' + String(result.msg || result.code), 'provider_error', 502); return result.data || result;
}
module.exports = { feishu };
