# LunchCards

A card-game Progressive Web App for playing Hearts, Spades, Euchre, and Texas Hold'em with coworkers, live at:

https://noahfgarrett.github.io/LunchCards/

The static PWA is hosted on GitHub Pages and uses Supabase for live party and authoritative match state (setup notes in `SUPABASE_SETUP.md`).

Use **Play Solo** to start any of the four games immediately against CPU seats. Each game remembers its own CPU difficulty choice.

Cards animate through dealing, Hearts passing and receiving, play-to-center, winner highlighting, and trick collection. Collection direction is rotated per client, so the same winning seat moves toward the correct person on every screen.

## Development

```sh
npm install
npm run build:vendor
npm test
```

The browser suites expect the app on `http://127.0.0.1:4173` (override with `LUNCH_CARDS_URL`). Serve the folder in one terminal:

```sh
python3 -m http.server 4173
```

and run the suites in another:

```sh
npm run test:animations
npm run test:holdem
npm run test:difficulty
npm run test:rounds
npm run test:e2e
```

The browser suites run Chromium headlessly. They cover concurrent party joins, mobile name focus, roster propagation, readiness, canonical multiplayer deals, reload/resume, a complete three-human Hearts round, locally rotated trick collection, Hearts pass/receive motion, a complete two-human Hold'em hand, CPU difficulty behavior, mobile layouts, accessibility, offline startup, setup draft preservation, and name-rendering injection protection.

## Multiplayer Model

- Realtime notifications prompt clients to fetch the newest lobby or match snapshot.
- Each player has an unguessable seat token stored only in that browser.
- Supabase RPCs atomically claim seats and enforce host/player ownership.
- Match writes use optimistic versions so stale clients cannot overwrite newer turns.
- The host is the sole CPU authority; human players submit only their own turns.
- Sessions expire after four inactive hours and hosts can explicitly close them.
