# Lineage notes from a stock clone, 2026-10-19

On 2026-10-19 at 15:53 UTC, `scripts/verify_note.mjs` (at 959a5c5) checked every landed commit with a note on a stock `git clone` of the production colony `signed-notes` (https://firetrident.com/git/signed-notes.git, notes fetched from `refs/notes/firetrident`), first alone and then with the deployment's public keys.
The colony has one landing: its note is intact, signed by key `7980151ea697807b`, 1 of 1 ([verify-signed-notes.log](verify-signed-notes.log)).
Read only: a clone, a fetch and a GET of `/.well-known/firetrident-keys.json`. It replaces a stock-clone count on a Hono run on a preview that no longer exists.
