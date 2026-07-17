# LunchCards

Progressive Web App for coworker card sessions at:

https://noahfgarrett.github.io/LunchCards/

The static PWA is hosted on GitHub Pages and uses the existing `TableCards` Supabase project for live party and authoritative match state.

Use **Play Solo** to start Hearts, Spades, or Euchre immediately against CPU seats. Each game remembers its own CPU difficulty choice.

## Development

```sh
npm install
npm run build:vendor
npm test
python3 -m http.server 4173
npm run test:e2e
```

The end-to-end suite runs Chromium headlessly. It covers concurrent party joins, mobile name focus, roster propagation, readiness, one canonical multiplayer deal, reload/resume, Hearts passing and a synchronized trick, mobile Spades/Euchre smoke tests, setup draft preservation, and name-rendering injection protection.

## Multiplayer Model

- Realtime notifications prompt clients to fetch the newest lobby or match snapshot.
- Each player has an unguessable seat token stored only in that browser.
- Supabase RPCs atomically claim seats and enforce host/player ownership.
- Match writes use optimistic versions so stale clients cannot overwrite newer turns.
- The host is the sole CPU authority; human players submit only their own turns.
- Sessions expire after four inactive hours and hosts can explicitly close them.
