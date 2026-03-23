/* global window, document */

const LIKES_STORAGE_KEY = "musify_liked_tracks_v1";

function loadLikedTracks() {
  try {
    const raw = window.localStorage.getItem(LIKES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveLikedTracks(likedTracks) {
  try {
    window.localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(likedTracks));
  } catch (_) {
    // ignore storage errors
  }
}

let likedTracks = loadLikedTracks();

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

function showSection(section) {
  const results = document.getElementById("results");
  const profile = document.getElementById("profile");
  const form = document.getElementById("searchForm");
  if (!results || !profile || !form) return;

  if (section === "profile") {
    form.style.display = "none";
    results.style.display = "none";
    profile.style.display = "block";
    renderProfile();
    return;
  }

  form.style.display = "flex";
  results.style.display = "block";
  profile.style.display = "none";
}

function renderProfile() {
  const profile = document.getElementById("profile");
  if (!profile) return;

  const tracks = Object.values(likedTracks);
  if (!tracks.length) {
    profile.innerHTML = `<div class="small">Пока нет лайков. Нажмите "Лайк" у трека в поиске.</div>`;
    return;
  }

  profile.innerHTML = "";
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
        <button type="button" data-profile-action="play" data-id="${id}">Отправить в чат</button>
        <button type="button" data-profile-action="open" data-id="${id}">Открыть в Deezer</button>
        <button type="button" data-profile-action="unlike" data-id="${id}">Убрать лайк</button>
      </div>
    `;
    profile.appendChild(card);
  }

  profile.querySelectorAll("button[data-profile-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-profile-action");
      const trackId = Number(btn.getAttribute("data-id"));
      const track = likedTracks[String(trackId)];
      if (!trackId || !track) return;

      if (action === "play") {
        setStatus("Отправляю трек в чат...");
        tgSend({ action: "play", trackId });
        return;
      }
      if (action === "open") {
        const trackLink = track.link || `https://www.deezer.com/track/${trackId}`;
        window.open(trackLink, "_blank", "noopener,noreferrer");
        return;
      }
      if (action === "unlike") {
        delete likedTracks[String(trackId)];
        saveLikedTracks(likedTracks);
        setStatus("Лайк снят.");
        tgSend({ action: "like", trackId, liked: false });
        renderProfile();
      }
    });
  });
}

async function searchTracks(query) {
  function normalizeTracks(data) {
    const items = Array.isArray(data?.data) ? data.data : [];
    return items.map((it) => ({
      id: it?.id,
      title: it?.title,
      link: it?.link,
      preview: it?.preview,
      artist: it?.artist,
      album: it?.album,
    }));
  }

  function jsonpSearch() {
    return new Promise((resolve, reject) => {
      const cbName = `deezerCb_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const script = document.createElement("script");
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("JSONP timeout"));
      }, 8000);

      function cleanup() {
        window.clearTimeout(timeout);
        try {
          delete window[cbName];
        } catch (_) {
          window[cbName] = undefined;
        }
        script.remove();
      }

      window[cbName] = (payload) => {
        cleanup();
        resolve(normalizeTracks(payload));
      };

      const url = new URL("https://api.deezer.com/search");
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "10");
      url.searchParams.set("output", "jsonp");
      url.searchParams.set("callback", cbName);
      script.src = url.toString();
      script.async = true;
      script.onerror = () => {
        cleanup();
        reject(new Error("JSONP load failed"));
      };
      document.head.appendChild(script);
    });
  }

  const url = new URL("https://api.deezer.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "10");

  try {
    const resp = await fetch(url.toString(), { method: "GET" });
    if (!resp.ok) {
      throw new Error(`Deezer HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return normalizeTracks(data);
  } catch (_) {
    // Telegram WebView can block CORS fetch; JSONP is a safe fallback for Deezer search.
    return await jsonpSearch();
  }
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
        <button type="button" data-action="open" data-id="${id}">Открыть в Deezer</button>
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

      if (action === "open") {
        const trackLink = t.link || `https://www.deezer.com/track/${trackId}`;
        window.open(trackLink, "_blank", "noopener,noreferrer");
        return;
      }

      if (action === "like") {
        const key = String(trackId);
        const alreadyLiked = Boolean(likedTracks[key]);
        if (alreadyLiked) {
          delete likedTracks[key];
          saveLikedTracks(likedTracks);
          setStatus("Лайк снят.");
          tgSend({ action: "like", trackId, liked: false });
          btn.textContent = "Лайк";
        } else {
          likedTracks[key] = t;
          saveLikedTracks(likedTracks);
          setStatus("Лайк добавлен.");
          tgSend({ action: "like", trackId, liked: true });
          btn.textContent = "Убрать лайк";
        }
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
  const tabSearch = document.getElementById("tabSearch");
  const tabProfile = document.getElementById("tabProfile");
  if (!form || !q) return;

  tabSearch?.addEventListener("click", () => showSection("search"));
  tabProfile?.addEventListener("click", () => showSection("profile"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = q.value.trim();
    if (!query) return;

    setStatus("Ищу в Deezer...");
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

    try {
      const tracks = await searchTracks(query);
      renderTrackList(tracks);
      setStatus(`Найдено: ${tracks.length}`);
      if (!tracks.length) {
        return;
      }
    } catch (err) {
      setStatus("Не удалось загрузить результаты в Mini App, отправляю поиск в чат...");
      tgSend({ action: "search", query });
      return;
    }
  });
}

setup();

