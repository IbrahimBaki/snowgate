// Configuration tables the read-only client may query, with the exact fields
// it may request. Anything else is refused before a request is made, so no
// transactional or PII table and no unlisted column can be read.
//
// Every table name here is a HYPOTHESIS until the target instance answers for
// it; discovery records a missing or forbidden table as a limitation.

const SCOPE = 'sys_scope';

const CREATED = ['sys_created_by', 'sys_created_on'];

export const TABLES = {
  sys_scope: ['sys_id', 'scope', 'name', 'version', 'active'],
  sys_update_set: ['sys_id', 'name', 'state', 'application', 'sys_created_by', 'sys_created_on', 'sys_updated_on'],
  sys_update_xml: ['sys_id', 'type', 'name', 'target_name', 'action', 'update_set', 'remote_update_set', 'application', 'sys_updated_on'],
  // Retrieved update sets and their preview problems (gateway preview/commit gates).
  sys_remote_update_set: ['sys_id', 'name', 'state', 'sys_created_on'],
  sys_update_preview_problem: ['sys_id', 'type', 'status', 'description', 'remote_update_set'],
  sys_user_preference: ['user', 'value'],
  sys_db_object: ['sys_id', 'name', 'label', 'super_class', SCOPE, ...CREATED],
  sys_dictionary: ['sys_id', 'name', 'element', 'internal_type', 'column_label', SCOPE],
  sys_script: ['sys_id', 'name', 'collection', 'when', 'active', SCOPE, 'sys_updated_on', ...CREATED],
  sys_script_include: ['sys_id', 'name', 'api_name', 'active', SCOPE, ...CREATED],
  sys_script_client: ['sys_id', 'name', 'table', 'type', 'active', SCOPE, ...CREATED],
  sys_ui_policy: ['sys_id', 'short_description', 'table', 'active', SCOPE, ...CREATED],
  sys_security_acl: ['sys_id', 'name', 'operation', 'type', 'active', SCOPE, ...CREATED],
  sp_portal: ['sys_id', 'title', 'url_suffix', SCOPE, ...CREATED],
  sp_page: ['sys_id', 'id', 'title', SCOPE, ...CREATED],
  sp_widget: ['sys_id', 'name', 'id', SCOPE, ...CREATED],
  sc_cat_item: ['sys_id', 'name', 'active', 'sys_class_name', SCOPE, ...CREATED],
  item_option_new: ['sys_id', 'name', 'question_text', 'type', 'cat_item', SCOPE, ...CREATED],
  sys_hub_flow: ['sys_id', 'name', 'active', SCOPE, ...CREATED],
  sysauto_script: ['sys_id', 'name', 'active', 'run_type', SCOPE, ...CREATED],
  sys_rest_message: ['sys_id', 'name', 'rest_endpoint', SCOPE, ...CREATED],
  // Further configuration artifacts, read by sys_id from customer updates.
  sys_ui_page: ['sys_id', 'name', 'category', SCOPE, ...CREATED],
  sys_ui_action: ['sys_id', 'name', 'table', 'action_name', 'active', SCOPE, ...CREATED],
  sys_ui_script: ['sys_id', 'name', 'active', SCOPE, ...CREATED],
  sysevent_email_action: ['sys_id', 'name', 'collection', 'active', SCOPE, ...CREATED],
  sys_ws_definition: ['sys_id', 'name', 'active', SCOPE, ...CREATED],
  catalog_ui_policy: ['sys_id', 'short_description', 'catalog_item', 'active', SCOPE, ...CREATED],
  catalog_script_client: ['sys_id', 'name', 'cat_item', 'type', 'active', SCOPE, ...CREATED],
  sys_ux_page_registry: ['sys_id', 'title', 'path', SCOPE, ...CREATED],
  sp_instance: ['sys_id', 'title', 'sp_widget.name', 'sp_column', SCOPE, ...CREATED],
};

// Code and definition fields (configuration, never data), verified on a real
// instance's sys_dictionary (2026-10-19), incl. fields inherited from
// question and sys_script_client. Readable through sn_query/sn_get_record so
// an agent can inspect behaviour; the project map does not fetch them.
export const CODE_FIELDS = {
  sp_widget: ['template', 'css', 'client_script', 'script', 'link', 'option_schema'],
  sp_page: ['css', 'public'],
  sys_script: ['script', 'condition', 'filter_condition'],
  sys_script_include: ['script', 'client_callable', 'access'],
  sys_script_client: ['script', 'ui_type'],
  catalog_script_client: ['script', 'ui_type'],
  sys_ui_page: ['html', 'client_script', 'processing_script'],
  sys_ui_action: ['script', 'condition', 'client', 'onclick'],
  sys_ui_policy: ['conditions'],
  catalog_ui_policy: ['catalog_conditions', 'applies_to'],
  sc_cat_item: ['short_description', 'description', 'category'],
  sys_ui_script: ['script'],
  sysevent_email_action: ['condition', 'subject', 'message_html'],
  item_option_new: ['mandatory', 'order', 'default_value'],
};
for (const [table, fields] of Object.entries(CODE_FIELDS)) TABLES[table] = [...new Set([...TABLES[table], ...fields])];

// The allow-listed fields without code: what discovery fetches in bulk.
export const metaFields = (table) => TABLES[table].filter((f) => !(CODE_FIELDS[table] ?? []).includes(f));

// Artifact tables the project map reads by sys_id, with the field that names
// a record. Any other table appearing in customer updates is listed by the
// update's own target_name.
export const ARTIFACT_TABLES = {
  sys_script: { label: 'Business rule', nameField: 'name' },
  sys_script_include: { label: 'Script include', nameField: 'name' },
  sys_script_client: { label: 'Client script', nameField: 'name' },
  sys_ui_policy: { label: 'UI policy', nameField: 'short_description' },
  sys_security_acl: { label: 'ACL', nameField: 'name' },
  sp_portal: { label: 'Portal', nameField: 'title' },
  sp_page: { label: 'Portal page', nameField: 'id' },
  sp_widget: { label: 'Widget', nameField: 'name' },
  sc_cat_item: { label: 'Catalog item', nameField: 'name' },
  item_option_new: { label: 'Catalog variable', nameField: 'name' },
  catalog_ui_policy: { label: 'Catalog UI policy', nameField: 'short_description' },
  catalog_script_client: { label: 'Catalog client script', nameField: 'name' },
  sys_hub_flow: { label: 'Flow', nameField: 'name' },
  sysauto_script: { label: 'Scheduled job', nameField: 'name' },
  sys_rest_message: { label: 'Outbound REST message', nameField: 'name' },
  sys_ui_page: { label: 'UI page', nameField: 'name' },
  sys_ui_action: { label: 'UI action', nameField: 'name' },
  sys_ui_script: { label: 'UI script', nameField: 'name' },
  sysevent_email_action: { label: 'Notification', nameField: 'name' },
  sys_ws_definition: { label: 'Scripted REST API', nameField: 'name' },
  sys_ux_page_registry: { label: 'UX application', nameField: 'title' },
  // A widget instance is named by its title, else by its widget.
  sp_instance: { label: 'Widget instance', nameField: ['title', 'sp_widget.name'] },
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
