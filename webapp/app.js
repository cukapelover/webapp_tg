/* global window, document */

function getWebApp() {
  return window.Telegram?.WebApp || null;
}

async function waitForWebApp(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tg = getWebApp();
    if (tg) return tg;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function tgSend(payload) {
  const tg = getWebApp();
  if (!tg || !tg.sendData) {
    alert("Telegram WebApp SDK недоступен (window.Telegram.WebApp не найден)");
    return;
  }
  tg.sendData(JSON.stringify(payload));
}

async function searchTracks(query) {
  // Deprecated: We don't fetch Deezer directly from WebApp due to Telegram WebView network/CORS restrictions.
  // Kept only to avoid breaking the rest of the file if you later re-enable direct fetch.
  return [];
}

function renderTrackList(tracks) {
  const results = document.getElementById("results");
  if (!results) return;
  results.innerHTML = "";

  if (!tracks || tracks.length === 0) {
    results.innerHTML = `<div class="small">Ничего не найдено.</div>`;
    return;
  }

  for (const t of tracks) {
    const id = t.id;
    const title = t.title || "Track";
    const artist = t.artist?.name || "Unknown";
    const album = t.album?.title || "";

    const card = document.createElement("div");
    card.className = "track";
    card.innerHTML = `
      <div><b>${escapeHtml(artist)}</b> — ${escapeHtml(title)}</div>
      <div class="meta small">${escapeHtml(album)}</div>
      <div class="row">
        <button type="button" data-action="play" data-id="${id}">Отправить в чат</button>
        <button type="button" data-action="like" data-id="${id}">Лайк</button>
      </div>
      <div class="row" style="align-items:flex-start">
        <div style="flex:1;">
          <div class="small" style="margin-bottom:6px;">Комментарий</div>
          <textarea data-comment-for="${id}" placeholder="Короткий комментарий..."></textarea>
        </div>
      </div>
      <div class="row">
        <button type="button" data-action="comment" data-id="${id}">Сохранить комментарий</button>
      </div>
    `;
    results.appendChild(card);
  }

  results.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-action");
      const trackId = Number(btn.getAttribute("data-id"));

      if (!trackId) return;

      if (action === "play") {
        setStatus("Отправляю трек в чат...");
        tgSend({ action: "play", trackId });
        return;
      }

      if (action === "like") {
        // Simple optimistic UX: toggle locally not stored here.
        // The bot will interpret liked=true by default if you only send action + trackId.
        setStatus("Обновляю лайк...");
        tgSend({ action: "like", trackId, liked: true });
        return;
      }

      if (action === "comment") {
        const ta = document.querySelector(`textarea[data-comment-for="${trackId}"]`);
        const comment = (ta?.value || "").trim();
        if (!comment) {
          setStatus("Введите комментарий.");
          return;
        }
        setStatus("Сохраняю комментарий...");
        tgSend({ action: "comment", trackId, comment });
      }
    });
  });
}

function setup() {
  const form = document.getElementById("searchForm");
  const q = document.getElementById("q");
  if (!form || !q) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = q.value.trim();
    if (!query) return;

    setStatus("Ищу... жду Telegram WebApp SDK...");
    const tg = await waitForWebApp(5000);
    if (!tg) {
      setStatus("SDK недоступен. Проверь, что на Pages в index.html подключен telegram-web-app.js и что ты открыл WebApp заново.");
      return;
    }

    try {
      tg.ready?.();
      tg.expand?.();
    } catch (_) {
      // ignore
    }

    setStatus("Ищу... Открой чат с ботом: результаты придут туда.");
    tg.sendData(JSON.stringify({ action: "search", query }));
  });
}

setup();

