/* global window, document */

// Если бот открыл WebApp с ?api=https%3A%2F%2F... (переменная BOT_PUBLIC_API_URL), подставляем базу API.
(function initApiBaseFromQuery() {
  try {
    const q = new URLSearchParams(window.location.search).get("api");
    if (q) {
      window.MUSIFY_API_BASE = String(q).trim().replace(/\/$/, "");
    }
  } catch (_) {
    // ignore
  }
})();

const LIKES_STORAGE_KEY = "musify_liked_tracks_v1";
const LOCAL_COMMENTS_KEY = "musify_local_comments_v1";

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

function loadLocalCommentsStore() {
  try {
    const raw = window.localStorage.getItem(LOCAL_COMMENTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveLocalCommentsStore(store) {
  try {
    window.localStorage.setItem(LOCAL_COMMENTS_KEY, JSON.stringify(store));
  } catch (_) {
    // ignore
  }
}

function getLocalCommentsForTrack(trackId) {
  const all = loadLocalCommentsStore();
  return all[String(trackId)] || [];
}

function appendLocalComment(trackId, userId, author, text) {
  const all = loadLocalCommentsStore();
  const key = String(trackId);
  if (!all[key]) all[key] = [];
  all[key].unshift({
    user_id: userId,
    author: author || "anon",
    text,
    created_at: new Date().toISOString(),
  });
  saveLocalCommentsStore(all);
}

function getCurrentTgAuthor() {
  const u = window.Telegram?.WebApp?.initDataUnsafe?.user;
  if (!u) return { userId: null, author: "anon" };
  if (u.username) return { userId: u.id, author: `@${u.username}` };
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
  if (name) return { userId: u.id, author: name };
  return { userId: u.id, author: `id:${u.id}` };
}

function getApiBase() {
  const b = (typeof window !== "undefined" && window.MUSIFY_API_BASE) || "";
  return String(b).trim().replace(/\/$/, "");
}

async function fetchCommentsFromApi(trackId) {
  const base = getApiBase();
  if (!base) return null;
  const url = `${base}/api/comments/${trackId}?_ts=${Date.now()}`;
  // Retry once because tunnels/webview can sporadically fail first request.
  for (let i = 0; i < 2; i += 1) {
    try {
      const resp = await fetch(url, {
        cache: "no-store",
        headers: { "ngrok-skip-browser-warning": "1" },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      if (i === 1) throw err;
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  return null;
}

function mergeCommentLists(serverList, localList) {
  const seen = new Set();
  const out = [];
  const add = (c) => {
    const uid = c.user_id != null ? String(c.user_id) : "x";
    const key = `${uid}|${c.text}|${c.created_at}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const c of serverList || []) add(c);
  for (const c of localList || []) add(c);
  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return out;
}

let commentsModalBound = false;

function setupCommentsModal() {
  if (commentsModalBound) return;
  commentsModalBound = true;
  const modal = document.getElementById("commentsModal");
  const closeBtn = document.getElementById("commentsModalClose");
  closeBtn?.addEventListener("click", closeCommentsModal);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeCommentsModal();
  });
}

function closeCommentsModal() {
  const modal = document.getElementById("commentsModal");
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
}

async function openCommentsModal(trackId, trackTitle) {
  setupCommentsModal();
  const modal = document.getElementById("commentsModal");
  const titleEl = document.getElementById("commentsModalTitle");
  const hintEl = document.getElementById("commentsModalHint");
  const bodyEl = document.getElementById("commentsModalBody");
  if (!modal || !titleEl || !bodyEl) return;

  titleEl.textContent = trackTitle ? `Комментарии: ${trackTitle}` : "Комментарии к треку";
  if (hintEl) hintEl.textContent = "";
  bodyEl.innerHTML = `<div class="small">Загрузка…</div>`;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");

  const base = getApiBase();
  if (!base && hintEl) {
    hintEl.textContent =
      "Глобальные комментарии недоступны: не задан API бота (BOT_PUBLIC_API_URL/MUSIFY_API_BASE).";
  }

  let serverComments = [];
  if (base) {
    try {
      const data = await fetchCommentsFromApi(trackId);
      serverComments = (data?.comments || []).map((c) => ({
        user_id: c.user_id,
        author: c.author,
        text: c.text,
        created_at: c.created_at,
      }));
    } catch (_) {
      if (hintEl) {
        hintEl.textContent =
          "Не удалось загрузить глобальные комментарии с сервера. Проверьте BOT_PUBLIC_API_URL и туннель.";
      }
    }
  }

  const commentsToShow = base
    ? serverComments
    : getLocalCommentsForTrack(trackId).map((c) => ({
        user_id: c.user_id,
        author: c.author,
        text: c.text,
        created_at: c.created_at,
      }));

  if (!commentsToShow.length) {
    bodyEl.innerHTML = `<div class="small">Пока нет комментариев.</div>`;
    return;
  }

  bodyEl.innerHTML = mergeCommentLists(base ? serverComments : [], commentsToShow)
    .map(
      (c) => `
    <div class="comment-row">
      <div class="comment-author">${escapeHtml(c.author)}</div>
      <div class="comment-meta">${escapeHtml(c.created_at)}</div>
      <div class="comment-text">${escapeHtml(c.text)}</div>
    </div>
  `
    )
    .join("");
}

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
    const id = Number(t.id);
    if (!Number.isFinite(id) || id <= 0) continue;
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
        <button type="button" data-profile-action="comments" data-id="${id}">Комментарии</button>
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
      if (action === "comments") {
        openCommentsModal(trackId, track.title || "");
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
    const id = Number(t.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const title = t.title || "Track";
    const artist = t.artist?.name || "Unknown";
    const album = t.album?.title || "";

    const likeText = likedTracks[String(id)] ? "Убрать лайк" : "Лайк";
    const card = document.createElement("div");
    card.className = "track";
    card.innerHTML = `
      <div><b>${escapeHtml(artist)}</b> — ${escapeHtml(title)}</div>
      <div class="meta small">${escapeHtml(album)}</div>
      <div class="row">
        <button type="button" data-action="play" data-id="${id}">Отправить в чат</button>
        <button type="button" data-action="like" data-id="${id}">${likeText}</button>
        <button type="button" data-action="open" data-id="${id}">Открыть в Deezer</button>
        <button type="button" data-action="view_comments" data-id="${id}">Комментарии</button>
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

    // Важно: обработчики внутри цикла, чтобы не ссылаться на последний трек (closure bug).
    card.querySelectorAll("button[data-action]").forEach((btn) => {
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

        if (action === "view_comments") {
          setStatus("");
          openCommentsModal(trackId, title);
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
            likedTracks[key] = { ...t, id: trackId };
            saveLikedTracks(likedTracks);
            setStatus("Лайк добавлен.");
            tgSend({ action: "like", trackId, liked: true });
            btn.textContent = "Убрать лайк";
          }
          renderProfile();
          return;
        }

        if (action === "comment") {
          const ta = card.querySelector(`textarea[data-comment-for="${trackId}"]`);
          const comment = (ta?.value || "").trim();
          if (!comment) {
            setStatus("Введите комментарий.");
            return;
          }
          setStatus("Сохраняю комментарий...");
        const apiBase = getApiBase();
        const { userId, author } = getCurrentTgAuthor();
        // Если API доступен, показываем комментарии глобально из БД.
        // Локальное добавляем только как fallback, когда API недоступен.
        if (!apiBase) appendLocalComment(trackId, userId, author, comment);
          tgSend({ action: "comment", trackId, comment });
          setStatus("Комментарий сохранён. Откройте «Комментарии».");
        }
      });
    });
  }
}

function setup() {
  const form = document.getElementById("searchForm");
  const q = document.getElementById("q");
  const tabSearch = document.getElementById("tabSearch");
  const tabProfile = document.getElementById("tabProfile");
  if (!form || !q) return;

  tabSearch?.addEventListener("click", () => showSection("search"));
  tabProfile?.addEventListener("click", () => showSection("profile"));
  setupCommentsModal();

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

