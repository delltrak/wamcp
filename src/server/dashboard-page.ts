// ============================================================
// WA MCP — Operations dashboard page
// Static shell. Instance data is loaded from the JSON API.
// ============================================================

export function dashboardPage(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new Error("Invalid dashboard page nonce");
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>WA MCP operations</title>
<style nonce="${nonce}">
  :root { color-scheme: light; --ink: #1c1917; --muted: #57534e; --line: #e7e5e4; --bg: #fafaf9; --card: #fff; --ok: #166534; --warn: #9a3412; --bad: #991b1b; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 system-ui, sans-serif; color: var(--ink); background: var(--bg); }
  header, main { max-width: 980px; margin: 0 auto; padding: 20px; }
  header { padding-bottom: 0; }
  h1 { font-size: 1.4rem; margin: 0 0 6px; }
  h2 { font-size: 1.05rem; margin: 0 0 10px; }
  p { margin: 0 0 8px; }
  .muted { color: var(--muted); }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 0 0 16px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; color: var(--muted); }
  input { font: inherit; color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; min-width: 12rem; }
  button { font: inherit; border: 0; border-radius: 8px; padding: 8px 12px; background: #1c1917; color: #fff; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .cards { display: grid; gap: 10px; }
  article { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .pill { border-radius: 999px; padding: 2px 8px; background: #f5f5f4; font-size: 0.8rem; }
  .pill[data-state="connected"] { color: var(--ok); background: #dcfce7; }
  .pill[data-state="qr_pending"], .pill[data-state="connecting"] { color: var(--warn); background: #ffedd5; }
  .pill[data-state="disconnected"], .pill[data-outcome="failed"] { color: var(--bad); background: #fee2e2; }
  .pill[data-outcome="delivered"] { color: var(--ok); background: #dcfce7; }
  img { width: 180px; height: 180px; background: #fff; }
  ul { margin: 0; padding-left: 18px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
</style>
</head>
<body>
<header>
  <h1>WA MCP operations</h1>
  <p class="muted">Read-only, except starting pairing for an existing instance that is not already paired. Webhook secrets are not shown.</p>
</header>
<main>
  <p id="notice" class="muted"></p>
  <p id="pairing-code"></p>
  <section>
    <h2>Start pairing</h2>
    <p class="muted">Use Start pairing on an existing Baileys instance. This page does not create instances.</p>
    <label>Phone for a pairing code <input id="pairing-phone" inputmode="numeric" maxlength="20" autocomplete="off" placeholder="15551234567"></label>
  </section>
  <section id="health"></section>
  <section id="instances"></section>
  <section id="webhook"></section>
  <section id="events"></section>
</main>
<script nonce="${nonce}">
const overviewUrl = "api/overview";

function el(tag, value, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value == null || value === "" ? "—" : String(value);
  return node;
}

function pill(value, attr) {
  const node = document.createElement("span");
  node.className = "pill";
  node.setAttribute(attr, value || "unknown");
  node.textContent = value || "unknown";
  return node;
}

function when(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString();
}

function list(items) {
  const node = document.createElement("ul");
  if (!items || items.length === 0) {
    node.append(el("li", "None"));
    return node;
  }
  for (const item of items) node.append(el("li", item));
  return node;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (err) {
    return {};
  }
}

function renderHealth(data) {
  const root = document.getElementById("health");
  const health = data.health || {};
  root.replaceChildren(
    el("h2", "Connection health"),
    el("p", "Version " + (data.version || "—") + " · uptime " + (data.uptimeSeconds ?? "—") + "s", "muted"),
    el("p", "Total " + (health.total ?? 0) + " · connected " + (health.connected ?? 0) + " · disconnected " + (health.disconnected ?? 0) + " · connecting " + (health.connecting ?? 0) + " · QR pending " + (health.qrPending ?? 0))
  );
}

function renderInstances(data) {
  const root = document.getElementById("instances");
  const cards = document.createElement("div");
  cards.className = "cards";
  const instances = data.instances || [];
  if (instances.length === 0) cards.append(el("p", "No instances yet."));
  for (const item of instances) {
    const card = document.createElement("article");
    const title = document.createElement("div");
    title.className = "row";
    title.append(el("strong", item.name), pill(item.state, "data-state"), el("span", item.instanceId, "muted"));
    card.append(title);
    card.append(el("p", "Channel " + item.channel + " · paired " + (item.paired ? "yes" : "no") + " · phone " + (item.phone || "—")));
    card.append(el("p", "Last connected " + when(item.lastConnected) + " · last disconnected " + when(item.lastDisconnected), "muted"));
    card.append(el("p", "Disconnect " + (item.disconnectReason || "—") + " · status " + (item.disconnectStatusCode == null ? "—" : item.disconnectStatusCode), "muted"));
    const pending = item.pendingPairing || {};
    card.append(el("p", "Pending pairing " + (pending.status || "none") + " · expires " + when(pending.expiresAt), "muted"));
    if (typeof item.qrImage === "string" && item.qrImage.indexOf("data:image/svg+xml") === 0) {
      const image = document.createElement("img");
      image.alt = "WhatsApp pairing QR";
      image.src = item.qrImage;
      card.append(image);
    }
    if (item.pairingAvailable) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Start pairing";
      button.addEventListener("click", function () {
        const phone = document.getElementById("pairing-phone").value.trim();
        const body = {};
        if (phone) body.phone = phone;
        void startPairing(body, item.instanceId);
      });
      card.append(button);
    }
    cards.append(card);
  }
  root.replaceChildren(el("h2", "Instances"), cards);
}

function renderWebhook(data) {
  const root = document.getElementById("webhook");
  const webhook = data.webhook || {};
  const cloud = webhook.cloud || {};
  const deliveries = webhook.deliveries || [];
  const failed = deliveries.filter(function (item) { return item.outcome === "failed"; }).length;
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const label of ["Time", "Destination", "Event", "Outcome", "Attempt", "HTTP", "Code"]) {
    head.append(el("th", label));
  }
  table.append(head);
  if (deliveries.length === 0) {
    const row = document.createElement("tr");
    const cell = el("td", "No deliveries recorded in this process");
    cell.colSpan = 7;
    row.append(cell);
    table.append(row);
  }
  for (const item of deliveries) {
    const row = document.createElement("tr");
    row.append(el("td", when(item.at)), el("td", item.destinationId), el("td", item.event));
    const outcome = document.createElement("td");
    outcome.append(pill(item.outcome, "data-outcome"));
    row.append(outcome, el("td", item.attempt), el("td", item.httpStatus), el("td", item.errorCode));
    table.append(row);
  }
  root.replaceChildren(
    el("h2", "Webhook"),
    el("p", "Configured " + (webhook.configured ? "yes" : "no") + " · destinations " + (webhook.destinationCount ?? 0) + " · events " + (webhook.eventCount ?? 0) + " · auth configured " + (webhook.authConfigured ? "yes" : "no")),
    el("p", "Recent deliveries " + deliveries.length + " · recent failures " + failed, "muted"),
    el("p", "Cloud verify token configured " + (cloud.verifyTokenConfigured ? "yes" : "no") + " · cloud signature secret configured " + (cloud.signatureSecretConfigured ? "yes" : "no"), "muted"),
    el("h2", "Warnings"),
    list(webhook.warnings),
    el("h2", "Dropped events"),
    list(webhook.droppedEvents),
    table
  );
}

function renderEvents(data) {
  const root = document.getElementById("events");
  const listNode = document.createElement("ul");
  const events = data.events || [];
  if (events.length === 0) listNode.append(el("li", "No events recorded in this process"));
  for (const item of events) {
    listNode.append(el("li", when(item.at) + " · " + item.instanceId + " · " + item.event + " · " + item.detail));
  }
  root.replaceChildren(el("h2", "Recent events"), listNode);
}

function render(data) {
  renderHealth(data);
  renderInstances(data);
  renderWebhook(data);
  renderEvents(data);
}

async function load() {
  const response = await fetch(overviewUrl, { cache: "no-store", headers: { Accept: "application/json" } });
  if (response.status === 401) {
    document.getElementById("notice").textContent = "Authentication required";
    return;
  }
  const payload = await readJson(response);
  if (!response.ok) {
    document.getElementById("notice").textContent = payload.error || "Status request failed";
    return;
  }
  render(payload);
}

async function startPairing(body, instanceId) {
  const notice = document.getElementById("notice");
  notice.textContent = "Starting pairing";
  const url = "api/instances/" + encodeURIComponent(instanceId) + "/pairing";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await readJson(response);
  if (!response.ok) {
    notice.textContent = payload.error || "Pairing failed";
    return;
  }
  const code = document.getElementById("pairing-code");
  code.textContent = payload.pairingCode ? "Pairing code " + payload.pairingCode : "";
  notice.textContent = payload.pairingCode ? "Pairing code ready" : "Pairing started";
  await load();
}

void load();
setInterval(function () { void load(); }, 3000);
</script>
</body>
</html>
`;
}
