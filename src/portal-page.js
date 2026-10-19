import { SnowgateError } from './errors.js';
import { TABLES } from './rest/tables.js';

// sn_portal_page (PF-0013): one Service Portal page as a layout tree —
// containers → rows → columns → widget instances (rows can nest inside
// columns) — with each instance's widget and options, read GET-only.
const MAX_DEPTH = 4;
const SYS_ID = /^[0-9a-f]{32}$/;
const PAGE_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const byOrder = (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0);

function parseOptions(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

export async function portalPage(client, page) {
  if (!SYS_ID.test(page ?? '') && !PAGE_ID.test(page ?? '')) {
    throw new SnowgateError(`"${page}" is not a portal page id or sys_id.`, 'PAGE_INVALID');
  }
  const evidence = [];
  const q = async (table, query) => {
    const res = await client.query(table, { fields: TABLES[table], query });
    evidence.push(res.evidence);
    return res.records;
  };
  const [p] = await q('sp_page', SYS_ID.test(page) ? `sys_id=${page}` : `id=${page}`);
  if (!p) throw new SnowgateError(`No Service Portal page "${page}" (sp_page id or sys_id).`, 'PAGE_NOT_FOUND');

  const columnsOf = async (rows, depth) => {
    if (!rows.length) return;
    const columns = (await q('sp_column', `sp_rowIN${rows.map((r) => r.sys_id).join(',')}`)).sort(byOrder);
    const ids = columns.map((c) => c.sys_id).join(',');
    const instances = columns.length ? (await q('sp_instance', `sp_columnIN${ids}`)).sort(byOrder) : [];
    const nested = columns.length && depth < MAX_DEPTH ? (await q('sp_row', `sp_columnIN${ids}`)).sort(byOrder) : [];
    await columnsOf(nested, depth + 1);
    for (const row of rows) {
      row.columns = columns.filter((c) => c.sp_row === row.sys_id).map((c) => ({
        sys_id: c.sys_id,
        order: c.order,
        size: c.size,
        sizes: { xs: c.size_xs, sm: c.size_sm, lg: c.size_lg },
        class_name: c.class_name || undefined,
        instances: instances.filter((i) => i.sp_column === c.sys_id).map((i) => ({
          sys_id: i.sys_id,
          title: i.title || undefined,
          id: i.id || undefined,
          widget: { sys_id: i.sp_widget, name: i['sp_widget.name'], id: i['sp_widget.id'] },
          order: i.order,
          active: i.active,
          css: i.css || undefined,
          options: parseOptions(i.widget_parameters),
        })),
        rows: nested.filter((r) => r.sp_column === c.sys_id),
      }));
    }
  };

  const containers = (await q('sp_container', `sp_page=${p.sys_id}`)).sort(byOrder);
  const rows = containers.length ? (await q('sp_row', `sp_containerIN${containers.map((c) => c.sys_id).join(',')}`)).sort(byOrder) : [];
  await columnsOf(rows, 1);
  const strip = (r) => ({ sys_id: r.sys_id, order: r.order, class_name: r.class_name || undefined, columns: (r.columns ?? []).map((c) => ({ ...c, rows: c.rows.map(strip) })) });
  return {
    page: { sys_id: p.sys_id, id: p.id, title: p.title, public: p.public, css: p.css || undefined, scope: p.sys_scope, record_url: client.recordUrl('sp_page', p.sys_id) },
    containers: containers.map((c) => ({
      sys_id: c.sys_id,
      name: c.name || c.title || undefined,
      order: c.order,
      width: c.width,
      class_name: c.class_name || undefined,
      background_color: c.background_color || undefined,
      rows: rows.filter((r) => r.sp_container === c.sys_id).map(strip),
    })),
    evidence,
  };
}
