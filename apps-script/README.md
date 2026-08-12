# Shared project store

`main.html` used to keep everything in each person's own browser. Every
comment, board post, meeting note and schedule edit lived in that one
laptop's `localStorage` and nowhere else, so no two people ever saw the
same project, and a link to a comment could only ever work for the person
who wrote it.

`sig-project-store.gs` is the other half now: a Google Apps Script web app
holding one copy of the project in a Sheet, with uploads in a Drive folder.
The page writes through to it and polls it every 20 seconds.

## Turning it on

1. Deploy `sig-project-store.gs`. The steps are in the comment at the top
   of that file. It creates its own Sheet and Drive folder when you run
   `setup()`, and prints their links.
2. Fill in the **People** tab of the Sheet: one row per person, `name`
   exactly as it appears in the page's name dropdown, plus their email.
   A name with no email can still be typed in an @mention, it just never
   gets mail.
3. Paste the deployment's `/exec` URL into `STORE_URL` in `main.html`.
   Until you do, the page runs exactly as it did before: local only, no
   sync, no email, no errors.
4. Open the page in the browser holding the project as it should start,
   and run `ssSeed()` in the console. Once. It pushes that browser's copy
   up as the starting state. Check the Sheet, then tell everyone else to
   reload.

## What sends email

| Where | Who gets mailed |
| --- | --- |
| Project Updates board | everyone on the People tab, every post |
| Message Board, Suggestions | only the people named in an @mention |
| Task comments, file comments, meeting notes | only the people named in an @mention |

Editing a post never re-mails the people it already named. Only somebody
newly added to it hears about it. Mentioning yourself sends nothing.

Every email carries a link that opens the exact post it is about:

```
#board=messages&post=m1755...   a post on any of the three boards
#task=ph7&comment=c1755...      a comment on a task
#note=n1755...                  a meeting note
```

The router that reads these is in `main.html`, at the bottom of the shared
store section. If you add a link shape in the script, handle it there too,
or the link lands people on the timeline with no idea why.

## Things worth knowing

**No gate.** This was decided deliberately. Anyone who finds the `/exec`
URL in the page source can read and write everything, and uploaded files
are shared as "anyone with the link" so the page can display them. Do not
put anything in here that would matter if it were public.

**Addresses stay in the Sheet.** The page sends a *name* and the script
looks the address up. That is what stops the URL in the public page source
from being usable as a mail relay.

**Comments are appended, not written back.** A comment lives inside its
task, so saving one by writing the whole task would erase anything
somebody else added in the last few seconds. `append()` merges server side
under a lock instead. If you add another kind of list people can add to,
do the same.

**File bytes never go in the Sheet.** A single cell holds 50,000
characters, which a base64 image passes immediately. Uploads go to Drive
and the record keeps the link. Files uploaded before this existed stay as
base64 in whichever browser they were added on, and keep working there.

## Quota

Consumer Gmail allows about 100 recipients a day. A Project Update mails
the whole roster, so that is roughly 20 updates a day. Mentions cost one
each. Well clear of normal use, but worth remembering before anyone
scripts something against it.
