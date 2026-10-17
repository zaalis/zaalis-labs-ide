/* Input is already HTML-escaped and fenced/inline code is held by the shared
 * renderer. This module only adds table structure and preserves cell markup. */
(() => {
    'use strict';
    function cells(line) {
        const source = String(line).trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
        return source.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
    }
    function tableAt(lines, index, inline) {
        if (!lines[index]?.includes('|') || !lines[index + 1]?.includes('|')) return null;
        const headers = cells(lines[index]), separators = cells(lines[index + 1]);
        if (headers.length < 2 || separators.length !== headers.length || !separators.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
        const align = separators.map(cell => cell.startsWith(':') ? cell.endsWith(':') ? 'center' : 'left' : cell.endsWith(':') ? 'right' : 'left');
        const row = (values, tag) => `<tr>${headers.map((_, column) => `<${tag} style="text-align:${align[column]}">${inline(values[column] || '')}</${tag}>`).join('')}</tr>`;
        const rows = []; let cursor = index + 2;
        while (cursor < lines.length && lines[cursor].trim() && lines[cursor].includes('|')) {
            const values = cells(lines[cursor]); if (values.length !== headers.length) break;
            rows.push(row(values, 'td')); cursor++;
        }
        return { html: `<div class="markdown-table-scroll" tabindex="0" role="region" aria-label="Tableau"><table><thead>${row(headers, 'th')}</thead><tbody>${rows.join('')}</tbody></table></div>`, nextIndex: cursor };
    }
    window.ZaalisMarkdownTables = { tableAt };
})();
