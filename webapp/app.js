/* global window, document */

const tg = window.Telegram?.WebApp;

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
  if (!tg || !tg.sendData) {
    alert("Telegram WebApp SDK недоступен");
    return;
  }
  tg.sendData(JSON.stringify(payload));
}

async function searchTracks(query) {
  const params = new URLSearchParams({ q: query, limit: "10" });
  const deezerUrl = `https://api.deezer.com/search?${params.toString()}`;

  // WebView inside Telegram can block/alter access to 3rd party APIs.
  // Try multiple JSON-capable proxies. If all fail, show the last error.
  const proxyUrls = [
    // allorigins
    `https://api.allorigins.win/raw?url=${encodeURIComponent(deezerUrl)}`,
    // corsproxy.io
    `https://corsproxy.io/?${encodeURIComponent(deezerUrl)}`,
    // thingproxy (varies)
    `https://thingproxy.freeboard.io/fetch/${encodeURIComponent(deezerUrl)}`,
  ];

  const candidates = [deezerUrl, ...proxyUrls];
  let lastErr = null;

  for (const url of candidates) {
    try {
      const resp = await fetch(url, { method: "GET" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const items = Array.isArray(data.data) ? data.data : [];
      return items.filter((x) => x && x.type === "track").slice(0, 10);
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(`Load failed (all attempts): ${lastErr?.message || lastErr}`);
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
  if (tg) tg.ready();

  const form = document.getElementById("searchForm");
  const q = document.getElementById("q");
  if (!form || !q) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = q.value.trim();
    if (!query) return;

    setStatus("Ищу в Deezer...");
    try {
      const tracks = await searchTracks(query);
      renderTrackList(tracks);
      setStatus(`Готово: найдено ${tracks.length}.`);
    } catch (err) {
      console.error(err);
      setStatus(`Ошибка поиска: ${err.message || err}`);
    }
  });
}

setup();

