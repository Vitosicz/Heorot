# DM E2E Checklist (2-3 Accounts)

Purpose: validate that DM behavior is stable after the mapping/focus fixes and does not regress to random room jumps.

Scope: web/desktop DM and group-DM flows only.

## Test Setup

Accounts:
- `A` = main tester
- `B` = existing contact with prior DM history
- `C` = user with no prior DM with `A`

Clients:
- `A` on Desktop app
- `B` and `C` on Web (or Desktop if available)

Room/State prerequisites:
- At least one joined Space with multiple channels
- `A` has active channel open in a Space before DM actions
- No pending invite dialogs

Evidence collection:
- Screenshot before and after each case
- Toast text and timestamp
- DM roomId (from URL/permalink or room info if visible)
- Browser console/network error snippet if failed

## Pass Criteria (Release Gate)

All must pass:
- No redirect to unrelated Space channel after DM create/open
- New DM appears in DM list without Ctrl+R
- Reopening same DM does not create duplicates
- Group DM reopens same room (no accidental new room)
- No blocked composer state after DM open (`Event blocked by other events not yet sent`)

## Test Cases

### DM-01 New 1:1 DM from People tab
Steps:
1. Login as `A`.
2. Open `@` (People/DM tab).
3. Click `New DM` and enter `C`.
4. Confirm creation.

Expected:
- Success toast: `Direct message created.`
- UI opens DM with `C` immediately.
- DM is visible in DM list after close/reopen of dialog.
- Active room is not replaced by unrelated Space channel.

### DM-02 Reopen existing 1:1 DM (no duplicate)
Steps:
1. From `A`, run New DM to `C` again.
2. Confirm.

Expected:
- Toast: `Direct message opened.`
- Same room as DM-01 (same roomId).
- No second duplicate DM entry for same pair.

### DM-03 New Group DM (A+B+C)
Steps:
1. From `A`, New DM, add `B` and `C`.
2. Confirm group creation.

Expected:
- Toast: `Group chat created (...)`.
- Opens group room immediately.
- Room appears in DM list.

### DM-04 Reopen same Group DM (no duplicate)
Steps:
1. From `A`, New DM, add same targets (`B`, `C`) again.
2. Confirm.

Expected:
- Toast: `Group chat opened.`
- Same roomId as DM-03.
- No duplicate group DM created.

### DM-05 User profile -> Message button
Steps:
1. In any room, open user profile card for `C`.
2. Click `Message`.

Expected:
- Opens 1:1 DM with `C`.
- No jump to unrelated channel.
- If no DM existed yet, it is created and listed.

### DM-06 Incoming DM appears without reload
Steps:
1. Login as `B`.
2. From `B`, start DM with `A` (if not existing) and send message.
3. Observe `A` client without Ctrl+R.

Expected:
- DM thread appears/updates in `A` list without manual reload.
- New message visible in timeline.

### DM-07 Composer health after auto-focus
Steps:
1. Trigger DM create/open quickly multiple times from `A` (DM-01 then DM-02).
2. Type and send a short message immediately after open.

Expected:
- Message sends normally.
- No composer warning: `Event blocked by other events not yet sent`.

### DM-08 Cross-space stability
Steps:
1. On `A`, open a random Space channel.
2. Open New DM dialog and create/open DM with `C`.

Expected:
- Focus switches to DM (People context).
- App does not snap back to first Space channel.

## Result Table

| Case | Status | Evidence | Notes |
|---|---|---|---|
| DM-01 |  |  |  |
| DM-02 |  |  |  |
| DM-03 |  |  |  |
| DM-04 |  |  |  |
| DM-05 |  |  |  |
| DM-06 |  |  |  |
| DM-07 |  |  |  |
| DM-08 |  |  |  |

## Final Decision

- `PASS`: all cases pass, no unrelated room redirects, no DM duplicates, no blocked composer state.
- `FAIL`: any case fails. Attach failing case ID, exact toast/error text, and screenshot/log snippet.
-