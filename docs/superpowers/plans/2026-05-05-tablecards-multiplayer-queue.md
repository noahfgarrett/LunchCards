# TableCards Multiplayer Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish TableCards to GitHub Pages at `/TableCards/` and add a Supabase-backed coworker session queue with host launch controls.

**Architecture:** Keep the app as a static GitHub Pages PWA. Supabase stores lobby/session records, seats, ready state, and launch events; the browser polls/lightly subscribes and reconciles local UI state. The game table still runs locally for this pass, but launched sessions move all joined clients into the correct game shell.

**Tech Stack:** Static HTML/CSS/vanilla JavaScript, Supabase REST via `@supabase/supabase-js`, GitHub Pages, Node smoke tests.

---

### Task 1: Queue State Model

**Files:**
- Create: `tests/queue-state.test.js`
- Create: `queue-state.js`
- Modify: `app.js`

- [ ] Write failing tests for session filtering, seat labels, and launch readiness.
- [ ] Run `node tests/queue-state.test.js` and confirm it fails because `queue-state.js` is missing.
- [ ] Implement pure queue helpers in `queue-state.js`.
- [ ] Import helpers in `app.js`.
- [ ] Run `node tests/queue-state.test.js` and confirm it passes.

### Task 2: Supabase Queue Schema

**Files:**
- Modify: `supabase-schema.sql`

- [ ] Add player `client_id`, `is_host`, `is_ready`, and `last_seen` columns.
- [ ] Add policies constrained to valid lobby/player data.
- [ ] Apply the migration to project `gustsojyrpbbxptcbykg`.
- [ ] Verify table shape and Supabase security advisors.

### Task 3: Queue UI

**Files:**
- Modify: `app.js`
- Modify: `styles.css`

- [ ] Replace the setup-first flow with a session board.
- [ ] Add display-name persistence.
- [ ] Add create session, join session, active sessions, seat cards, ready toggle, host controls, CPU fill, and launch.
- [ ] Keep invite links working with `?hub=CODE`.

### Task 4: Publish

**Files:**
- GitHub repo: `noahfgarrett/TableCards`

- [ ] Create or update a clean `TableCards` GitHub repo.
- [ ] Copy static app files into the repo root.
- [ ] Commit and push.
- [ ] Enable GitHub Pages from `main` branch root.
- [ ] Verify `https://noahfgarrett.github.io/TableCards/`.
