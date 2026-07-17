export function getJoinableSessions(sessions) {
  return sessions
    .filter(session => session.status === "lobby" || session.status === "playing")
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));
}

export function formatSeatLabel(player, seatIndex) {
  const prefix = `Seat ${seatIndex + 1}:`;
  if (!player) return `${prefix} Open`;
  const parts = [player.name || "Unnamed"];
  if (player.is_host) parts.push("Host");
  if (player.is_cpu) parts.push("CPU");
  if (player.is_ready) parts.push("Ready");
  return `${prefix} ${parts.join(" · ")}`;
}

export function describeSessionStatus(session) {
  const seated = session.players?.length || 0;
  const game = titleCase(session.game || "hearts");
  const status = session.status === "playing" ? "In progress" : session.status === "complete" ? "Complete" : "Lobby";
  return `${seated}/${session.player_count} seated · ${game} · ${status}`;
}

export function canLaunchSession(session) {
  const players = Array.isArray(session.players) ? session.players : [];
  const required = Number(session.player_count || 0);
  return required > 0 && players.length === required && players.every(player => player.is_ready);
}

export function makeSessionShareUrl(currentUrl, code) {
  const url = new URL(currentUrl);
  url.searchParams.set("hub", code);
  return url.href;
}

function titleCase(value) {
  return `${value}`.slice(0, 1).toUpperCase() + `${value}`.slice(1);
}
