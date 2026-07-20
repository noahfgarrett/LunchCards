# Lunch Cards Supabase Setup

The app is static and can run on GitHub Pages without secrets. The active Supabase backend is:

- Existing Supabase project name: `TableCards` (unchanged)
- Project ref: `gustsojyrpbbxptcbykg`
- Project URL: `https://gustsojyrpbbxptcbykg.supabase.co`
- Publishable key: `sb_publishable_vZUqrwPhSu46PUmrMw-EKg_XfuMGqbs`

Supabase docs checked for this setup:

- Realtime Broadcast: https://supabase.com/docs/guides/realtime/broadcast
- Realtime Presence: https://supabase.com/docs/guides/realtime/presence
- Realtime Authorization: https://supabase.com/docs/guides/realtime/authorization

## Hub Model

- `table_cards_lobbies` stores lobby metadata, expiry, and the versioned canonical game snapshot for Hearts, Spades, Euchre, or Hold'em.
- `table_cards_players` stores seats, readiness, CPU settings, and hashed seat credentials.
- Realtime Postgres Changes invalidates client state; a five-second poll is the fallback.
- Active shared tables also poll every two seconds, independently of rendering, and refresh immediately when a phone returns to the foreground.
- Public clients cannot directly insert, update, or delete lobby/player rows.
- Token-validating RPCs provide atomic joins, host controls, heartbeats, and optimistic game updates.
- Deterministic trick collection may be finalized by any seated client; optimistic versioning accepts exactly one identical result.

## Browser Config

This config is already present before `app.js` in `index.html`:

```html
<script>
  window.LUNCH_CARDS_SUPABASE = {
    url: "https://gustsojyrpbbxptcbykg.supabase.co",
    publishableKey: "sb_publishable_vZUqrwPhSu46PUmrMw-EKg_XfuMGqbs"
  };
</script>
```

Do not put a secret key or service role key in GitHub Pages.

## Schema

Run `supabase-schema.sql` in the Supabase SQL editor. It is idempotent and upgrades an older Lunch Cards schema in place. RLS remains enabled, sensitive token hashes and game state are excluded from public table reads, and game state is returned only to a browser presenting a valid seat token.

The RPCs are intentionally callable with the publishable key because this is a no-login coworker app. Each privileged operation validates a 256-bit seat token inside a `SECURITY DEFINER` function. Supabase's generic advisor reports those exposed functions as warnings; direct row writes and wrong-token calls are covered by the security acceptance checks.

For company-domain enforcement or stronger anti-cheat guarantees, the next architectural step is Supabase Auth plus a server-side rules engine. Currently, every seated player receives the canonical snapshot, including all hands, so a technically inclined participant could inspect network data.
