---
name: servicenow-changes
description: How to make a change on a ServiceNow instance with snowgate - capture it in the task's update set, change it through the browser, verify it, and record it in the YallaFlow work item.
---

# Changing something on ServiceNow

The task belongs to YallaFlow: work on its active work item, and follow its guidance for the workflow stages.

1. **Select the task's update set first:** call `ui_use_update_set`. It creates or reuses `<work-id> - <title>` and makes it your current update set. Change nothing before it reports `current: true`. Otherwise the change lands in Default.
2. **Find what to change** with the read tools: `sn_query`, `sn_get_record`, `sn_portal_page`, and the discovery results in `.snowgate/discovery/`.
3. **Make the change in the browser:** `ui_navigate` to the record (for example `/sp_page.do?sys_id=<id>`), then `ui_type` / `ui_click` to edit it and press the form's Update or Save button.
4. **Verify the result** and record it as the work item's evidence: `yallaflow verify <work-id> -- snowgate check <table> <sys_id> <field>=<value>... --work <work-id>` reads the stored values from the instance and fails on any difference (for example `include_none=false show_help=true`; quote values with spaces). Check every field you changed, using the stored values (`true`/`false`, choice values, sys_ids), not the labels. View the page too if users see it (`ui_navigate` + `ui_snapshot`). `snowgate validate` checks change packages in `changes/` only; it does not verify a change made through the browser.
5. **Record in the YallaFlow work item** what you changed: the update set name, and each record with its table and sys_id.
6. **Leave the update set In Progress.** Do not complete it, back it out, export it or commit it unless the user asks.

If snowgate refuses something you need, say so to the user and call `sn_report_gap`.
