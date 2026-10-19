// Configuration tables the read-only client may query, with the exact fields
// it may request. Anything else is refused before a request is made, so no
// transactional or PII table and no unlisted column can be read.
//
// Every table name here is a HYPOTHESIS until the target instance answers for
// it; discovery records a missing or forbidden table as a limitation.

const SCOPE = 'sys_scope';

export const TABLES = {
  sys_scope: ['sys_id', 'scope', 'name', 'version', 'active'],
  sys_update_set: ['sys_id', 'name', 'state', 'application', 'sys_created_by', 'sys_created_on', 'sys_updated_on'],
  sys_update_xml: ['sys_id', 'type', 'name', 'target_name', 'update_set', 'application', 'sys_updated_on'],
  // Retrieved update sets and their preview problems (gateway preview/commit gates).
  sys_remote_update_set: ['sys_id', 'name', 'state', 'sys_created_on'],
  sys_update_preview_problem: ['sys_id', 'type', 'status', 'description', 'remote_update_set'],
  sys_user_preference: ['user', 'value'],
  sys_db_object: ['sys_id', 'name', 'label', 'super_class', SCOPE],
  sys_dictionary: ['sys_id', 'name', 'element', 'internal_type', 'column_label', SCOPE],
  sys_script: ['sys_id', 'name', 'collection', 'when', 'active', SCOPE, 'sys_updated_on'],
  sys_script_include: ['sys_id', 'name', 'api_name', 'active', SCOPE],
  sys_script_client: ['sys_id', 'name', 'table', 'type', 'active', SCOPE],
  sys_ui_policy: ['sys_id', 'short_description', 'table', 'active', SCOPE],
  sys_security_acl: ['sys_id', 'name', 'operation', 'type', 'active', SCOPE],
  sp_portal: ['sys_id', 'title', 'url_suffix', SCOPE],
  sp_page: ['sys_id', 'id', 'title', SCOPE],
  sp_widget: ['sys_id', 'name', 'id', SCOPE],
  sc_cat_item: ['sys_id', 'name', 'active', 'sys_class_name', SCOPE],
  item_option_new: ['sys_id', 'name', 'question_text', 'type', 'cat_item', SCOPE],
  sys_hub_flow: ['sys_id', 'name', 'active', SCOPE],
  sysauto_script: ['sys_id', 'name', 'active', 'run_type', SCOPE],
  sys_rest_message: ['sys_id', 'name', 'rest_endpoint', SCOPE],
};

// Customer-scoped apps use the x_<vendor>_ prefix. Global-scope customisations
// are covered by customer updates (sys_update_xml), not per artifact table.
const CUSTOM_SCOPED = 'sys_scope.scopeSTARTSWITHx_';

// The discovery inventory (PLAN §8 step 2). `filter` is the default encoded
// query; with --scope, `scopeField=<scope>` replaces the custom-scope filter.
export const INVENTORY = [
  { key: 'scoped_apps', label: 'Scoped applications', table: 'sys_scope', filter: 'scopeSTARTSWITHx_', scopeField: 'scope' },
  { key: 'update_sets', label: 'Update sets', table: 'sys_update_set', filter: '', scopeField: 'application.scope' },
  { key: 'current_update_set_prefs', label: 'Current update set per user', table: 'sys_user_preference', filter: 'name=sys_update_set', scopeField: null },
  { key: 'customer_updates', label: 'Customer updates', table: 'sys_update_xml', filter: '', scopeField: 'application.scope' },
  { key: 'custom_tables', label: 'Custom tables', table: 'sys_db_object', filter: 'nameSTARTSWITHu_^ORnameSTARTSWITHx_', scopeField: 'sys_scope.scope', keepFilter: true },
  { key: 'custom_fields', label: 'Custom fields', table: 'sys_dictionary', filter: 'elementSTARTSWITHu_^ORelementSTARTSWITHx_', scopeField: 'sys_scope.scope', keepFilter: true },
  { key: 'business_rules', label: 'Business rules', table: 'sys_script', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
  { key: 'script_includes', label: 'Script includes', table: 'sys_script_include', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
  { key: 'client_scripts', label: 'Client scripts', table: 'sys_script_client', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
  { key: 'ui_policies', label: 'UI policies', table: 'sys_ui_policy', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
  { key: 'acls', label: 'ACLs', table: 'sys_security_acl', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
  { key: 'portals', label: 'Service Portal portals', table: 'sp_portal', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
  { key: 'portal_pages', label: 'Service Portal pages', table: 'sp_page', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
  { key: 'widgets', label: 'Service Portal widgets', table: 'sp_widget', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
  { key: 'catalog_items', label: 'Catalog items', table: 'sc_cat_item', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
  { key: 'catalog_variables', label: 'Catalog variables', table: 'item_option_new', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
  { key: 'flows', label: 'Flows', table: 'sys_hub_flow', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
  { key: 'scheduled_jobs', label: 'Scheduled script jobs', table: 'sysauto_script', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
  { key: 'rest_messages', label: 'Outbound REST messages', table: 'sys_rest_message', filter: CUSTOM_SCOPED, scopeField: 'sys_scope.scope' },
];

export function inventoryQuery(entry, scope) {
  if (!scope || !entry.scopeField) return entry.filter;
  const scoped = `${entry.scopeField}=${scope}`;
  return entry.keepFilter && entry.filter ? `${entry.filter}^${scoped}` : scoped;
}
