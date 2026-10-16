# MCP server

Gives Claude the full dataset — reading and writing. Day overview, search,
what ran on the Mac, clients, projects, calendar, meetings, to-dos, notes,
timer and manual time entries, leads with offers, follow-ups and AI score,
inbox, operational status, unbilled time, invoice drafts, revenue,
automations.

## Connecting

**Settings → Claude → „Mit Claude verbinden"**, inside the macOS app. One click
writes the connector into Claude Desktop's config (a copy of the old file stays
next to it) and registers it with Claude Code for every project. Afterwards
Claude Desktop has to restart — it reads that file only at startup, and the
card offers the button for it.

What gets written are absolute paths to node, to tsx and to the server. Claude
starts the connector itself and inherits none of the PATH a terminal has, which
is where `npx`-based entries usually fail.

Doing it by hand works too. Inside this repository nothing has to be
registered: `.mcp.json` is part of it, and the server reads the `SERVICE_TOKEN`
out of `.env` by itself. For a Claude on another machine:

```bash
SOLOOPS_URL=http://localhost:3000 \
SOLOOPS_TOKEN=<SERVICE_TOKEN> \
claude mcp add soloops -- npx tsx /path/to/soloops/apps/mcp/src/index.ts
```

The card shows when Claude was last here — the proof that the connector works
rather than merely exists. The desktop app uses the same token for its activity
samples, so both name themselves in an `X-Soloops-Client` header and are
counted apart.

## The tools and the API cannot drift apart

Every tool is held against the endpoint it calls. `apps/mcp/test/contract.test.ts`
calls each of the 81 tools once with values made up from its own schema,
intercepts the request, and checks the path, the method, every field it sends
and every field the endpoint requires against
[`docs/openapi.json`](openapi.json). Nothing in that test is hand-maintained,
so a renamed field fails there instead of in a conversation.

Run `npm run openapi` after changing a route, then `npm test`.

## Tools

| Area        | Tools                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview    | `soloops_today`, `soloops_search`, `soloops_activity_day`, `soloops_ops_status`                                                                                                                                                                                                                                                                                                     |
| Clients     | `soloops_list_clients`, `soloops_get_client`, `soloops_create_client`, `soloops_update_client`, `soloops_list_contacts`, `soloops_create_contact`, `soloops_update_contact`, `soloops_delete_contact`                                                                                                                                                                               |
| Projects    | `soloops_list_projects`, `soloops_get_project`, `soloops_create_project`, `soloops_update_project`, `soloops_project_digest`                                                                                                                                                                                                                                                        |
| Calendar    | `soloops_free_slots`, `soloops_list_events`, `soloops_create_event`, `soloops_update_event`, `soloops_delete_event`                                                                                                                                                                                                                                                                 |
| Meetings    | `soloops_list_meetings`, `soloops_get_meeting`, `soloops_create_meeting`, `soloops_update_meeting`, `soloops_summarize_meeting`                                                                                                                                                                                                                                                     |
| Aufgaben    | `soloops_list_tasks`, `soloops_get_task`, `soloops_create_task`, `soloops_update_task`, `soloops_complete_task`, `soloops_link_task_commit`, `soloops_refresh_task_links`, `soloops_delete_task`                                                                                                                                                                                    |
| Notes       | `soloops_list_notes`, `soloops_get_note`, `soloops_create_note`, `soloops_update_note`                                                                                                                                                                                                                                                                                              |
| Time        | `soloops_timer_status`, `soloops_timer_start`, `soloops_timer_stop`, `soloops_log_time`, `soloops_update_time`, `soloops_delete_time`, `soloops_time_report`                                                                                                                                                                                                                        |
| Money       | `soloops_unbilled_time`, `soloops_list_invoices`, `soloops_draft_invoice_from_time`, `soloops_set_invoice_status`, `soloops_revenue`                                                                                                                                                                                                                                                |
| Sales       | `soloops_pipeline`, `soloops_list_leads`, `soloops_get_lead`, `soloops_create_lead`, `soloops_update_lead`, `soloops_set_lead_stage`, `soloops_archive_lead`, `soloops_log_lead_activity`, `soloops_log_offer`, `soloops_update_offer`, `soloops_score_lead`                                                                                                                        |
| Inbox       | `soloops_inbox`, `soloops_assign_mail`, `soloops_lead_from_mail`                                                                                                                                                                                                                                                                                                                    |
| Automations | `soloops_automations`, `soloops_automation_status`, `soloops_automation_runs`, `soloops_automation_sync`, `soloops_automation_set_active`, `soloops_automation_assign_project`, `soloops_automation_templates`, `soloops_automation_import_template`, `soloops_automation_triggers`, `soloops_automation_deliveries`, `soloops_automation_set_trigger`, `soloops_automation_delete` |

The writing tools stay conservative where money or other people are involved:
`soloops_draft_invoice_from_time` only produces a draft — sending it and
transferring it to lexoffice stay manual. The task tools link commits and pull
requests but never touch them: nothing here can merge, close or comment. Leads and projects are archived
rather than deleted, time entries that are already invoiced refuse to go, and
entries from connected calendars are read-only here.

The automation tools read, switch and import, but never edit a graph. A second
way to author workflows would have to agree with the editor forever, and the
editor is both one click away and better at it. What Claude is genuinely useful
for here is "what stopped working and why" — which is what the run and delivery
logs answer.
