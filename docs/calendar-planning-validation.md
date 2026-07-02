# Calendar Planning Validation

Use this checklist to validate the optional `calendar-planning-os` bridge on a clean or customer-style Mac before enabling real calendar writeback.

## Goal

Confirm Daily OS can call the optional calendar engine, render draft cards, and keep writeback disabled.

## Setup

1. Clone or update both repositories on the same machine.

```bash
git clone git@github.com:alexli-77/daily-os-feishu.git
git clone git@github.com:alexli-77/calendar-planning-os.git
```

2. Start Daily OS in the foreground first.

```bash
cd daily-os-feishu
npm ci
npm run start
```

3. Open the dashboard and go to `Workflows -> Calendar planning`.

4. Fill the calendar engine fields:

```text
Enabled: on
Command: node
calendar-planning-os folder: ../calendar-planning-os
CLI path: bin/calendar-planning-os.mjs
Week days: 5
Max tasks: 8
```

5. Click `Save`.

Saving these fields writes `config/config.yaml`. The running `npm run start` service reloads this config for the next Feishu command. A restart is only needed after code updates or when turning the Feishu interaction layer itself on or off.

## Smoke Test

Click `Test Calendar Engine`.

Expected result:

- It reports `Calendar engine OK`.
- It shows the resolved workdir and CLI path.
- It does not collect Feishu, Linear, vault, or calendar source data.

If this fails, fix the folder or CLI path before testing real drafts.

## Feishu Test

In Feishu, send:

```text
daily-os calendar week
```

Expected result:

- Feishu replies with a calendar draft card.
- The card has confirm, adjust, and skip actions.
- The card says it has not written to Feishu, Apple, or Google Calendar.

Then send:

```text
daily-os calendar today
```

Expected result:

- Feishu replies with a today draft card.
- Current todo inbox, weekly priorities, Linear, and calendar evidence are reflected only when those sources are enabled.

## Dashboard Test

From the dashboard Overview page or Workflows page:

- Run `Calendar Week`.
- Run `Calendar Today`.

Expected result:

- Draft text appears in the dashboard output panel.
- Logs show action success without storing the draft body.

## Writeback Boundary

This validation is draft-only.

Do not expect real calendar writes yet. Real Feishu, Apple, or Google Calendar writeback needs a separate provider-specific implementation, explicit confirmation, overwrite checks, and undo behavior.
