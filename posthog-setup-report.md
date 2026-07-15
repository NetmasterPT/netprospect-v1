# PostHog post-wizard report

The wizard completed a targeted PostHog integration for the NetProspect dashboard experience. It added browser-side PostHog initialization through environment-backed runtime config, forwarded PostHog distinct and session identifiers from the browser to server API requests, captured key dashboard and outreach workflow events on the client, and mirrored critical server-side business actions into PostHog for more reliable analytics. It also exposed a safe server config endpoint for the browser SDK, mounted the installed SDK bundle for the SPA, and verified the dashboard container still builds successfully.

| Event name | Description | File |
| --- | --- | --- |
| dashboard_search_submitted | Tracks when a user submits a global search from the dashboard header. | `dashboard/public/index.html` |
| theme_toggled | Tracks when a user switches the dashboard theme. | `dashboard/public/index.html` |
| directory_filters_applied | Tracks when directory filters are changed and results are refreshed. | `dashboard/public/index.html` |
| site_detail_opened | Tracks when a site detail drawer is opened from the dashboard. | `dashboard/public/index.html` |
| campaign_created | Tracks when a new outreach campaign is created from the dashboard. | `dashboard/public/index.html` |
| campaign_generate_requested | Tracks when campaign email generation is requested. | `dashboard/public/index.html` |
| campaign_send_requested | Tracks when campaign delivery is requested from the dashboard. | `dashboard/public/index.html` |
| segment_saved | Tracks when a filtered audience is saved as a segment. | `dashboard/public/index.html` |
| audit_requested | Tracks when a manual site audit is requested. | `dashboard/public/index.html`, `dashboard/server.mjs` |
| csv_import_submitted | Tracks when a CSV import is submitted to the server. | `dashboard/server.mjs` |
| client_status_updated | Tracks when a company is marked or updated as a client. | `dashboard/server.mjs` |
| campaign_generation_queued | Tracks when campaign generation jobs are queued server-side. | `dashboard/server.mjs` |
| campaign_send_queued | Tracks when campaign send jobs are queued server-side. | `dashboard/server.mjs` |
| report_viewed | Tracks when a public outreach report page is viewed. | `dashboard/server.mjs` |

## Next steps

We've built some PostHog artifacts for this setup:

- [Analytics basics (wizard) dashboard](https://eu.posthog.com/project/224592/dashboard/822272)
- Insight creation was deferred because the newly instrumented custom events have not been ingested into the project's event schema yet. Open the dashboard flows once, then create insights from those events after they appear in PostHog.

## Verify before merging

- [ ] Run a full production build (the wizard only verified the files it touched) and fix any lint or type errors introduced by the generated code.
- [ ] Run the test suite — call sites that were rewritten or instrumented may need updated mocks or fixtures.
- [ ] Add the exact PostHog env var names you added to `.env.example` and any monorepo/bootstrap scripts so collaborators know what to set.

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.
