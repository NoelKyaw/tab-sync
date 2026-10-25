const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const host = (u) => { try { return new URL(u).host || u.slice(0, 30); } catch { return (u || '').slice(0, 30); } };

async function safe(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: String(e) }; }
}

(async () => {
  const windows = await chrome.windows.getAll({ populate: true });
  const stores = await safe(() => chrome.cookies.getAllCookieStores());
  const groups = await safe(() => chrome.tabGroups.query({}));
  const storeOf = new Map();
  if (stores.ok) for (const s of stores.value) for (const id of s.tabIds) storeOf.set(id, s.id);
  const groupOf = new Map();
  if (groups.ok) for (const g of groups.value) groupOf.set(g.id, g);

  let html = '';
  html += `<h2>Cookie stores (${stores.ok ? stores.value.length : 'error'})</h2>`;
  html += stores.ok
    ? `<pre>${esc(stores.value.map((s) => `store "${s.id}": ${s.tabIds.length} tabs`).join('\n'))}</pre>`
    : `<pre>${esc(stores.error)}</pre>`;
  html += `<h2>Tab groups / folders (${groups.ok ? groups.value.length : 'error'})</h2>`;
  html += groups.ok
    ? `<pre>${esc(groups.value.map((g) => `group ${g.id}: "${g.title}" color=${g.color} collapsed=${g.collapsed} window=${g.windowId}`).join('\n') || '(none)')}</pre>`
    : `<pre>${esc(groups.error)}</pre>`;

  html += '<h2>Tabs</h2><table><tr><th>win</th><th>idx</th><th>active</th><th>pinned</th><th>group</th><th>folder title</th><th>cookie store</th><th>title</th><th>host</th></tr>';
  for (const w of windows) {
    for (const t of w.tabs) {
      const g = groupOf.get(t.groupId);
      html += `<tr><td>${w.id}</td><td>${t.index}</td><td>${t.active ? '●' : ''}</td><td>${t.pinned ? 'yes' : ''}</td>` +
        `<td>${t.groupId}</td><td>${esc(g?.title ?? '')}</td><td>${esc(storeOf.get(t.id) ?? '—')}</td>` +
        `<td>${esc((t.title || '').slice(0, 45))}</td><td>${esc(host(t.url || t.pendingUrl))}</td></tr>`;
    }
  }
  html += '</table>';
  document.getElementById('out').innerHTML = html;
})();
