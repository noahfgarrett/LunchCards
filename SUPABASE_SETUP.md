# Table Cards Supabase Setup

The app is static and can run on GitHub Pages without secrets. The active Supabase backend is:

- Project name: `TableCards`
- Project ref: `gustsojyrpbbxptcbykg`
- Project URL: `https://gustsojyrpbbxptcbykg.supabase.co`
- Publishable key: `sb_publishable_vZUqrwPhSu46PUmrMw-EKg_XfuMGqbs`

Supabase docs checked for this setup:

- Realtime Broadcast: https://supabase.com/docs/guides/realtime/broadcast
- Realtime Presence: https://supabase.com/docs/guides/realtime/presence
- Realtime Authorization: https://supabase.com/docs/guides/realtime/authorization

## Recommended Hub Model

- `lobbies` stores lobby metadata and the join code.
- `lobby_players` stores seats.
- Realtime Presence tracks who is currently connected to `table-cards:<lobby-code>`.
- Realtime Broadcast sends low-latency game events after the host validates each move.

## Browser Config

This config is already present before `app.js` in `index.html`:

```html
<script>
  window.TABLE_CARDS_SUPABASE = {
    url: "https://gustsojyrpbbxptcbykg.supabase.co",
    publishableKey: "sb_publishable_vZUqrwPhSu46PUmrMw-EKg_XfuMGqbs"
  };
</script>
```

Do not put a secret key or service role key in GitHub Pages.

## Minimal Schema

Run `supabase-schema.sql` in the Supabase SQL editor. It keeps RLS on for public tables and allows anonymous coworker lobby creation. For stricter company-only access, add Supabase Auth and replace the permissive policies with authenticated email-domain policies.
