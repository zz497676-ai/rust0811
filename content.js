// Injected on demand (via the popup button). Extracts the article's paragraphs,
// sends them to the background service worker in chunks for annotation, then
// writes the sanitized, annotated HTML back into the page.

(() => {
  if (window.__arfRunning) return; // avoid double-injection re-entrancy
  window.__arfRunning = true;

  const MIN_PARAGRAPH_LENGTH = 40;
  const CHUNK_CHAR_BUDGET = 3000;
  const ALLOWED_CLASSES = new Set(["arf-hi", "arf-lo", "arf-pos", "arf-neg"]);

  const EXCLUDED_ANCESTORS_SELECTOR = "nav, header, footer, aside, script, style, noscript, [contenteditable='true']";
  const BLOCK_CHILD_SELECTOR = ":scope > div, :scope > section, :scope > article, :scope > ul, :scope > ol, :scope > table, :scope > header, :scope > footer, :scope > p, :scope > li";

  // An element counts as "paragraph-like" if it directly holds text/inline
  // content with no block-level children of its own. Standard <p>-based
  // sites satisfy this trivially; div-heavy SPA sites (e.g. 小红书) that
  // never use <p> also produce qualifying <div>/<span>/<li> leaves this way.
  function isParagraphLike(el) {
    return el.querySelectorAll(BLOCK_CHILD_SELECTOR).length === 0;
  }

  // Drop any candidate that itself contains another candidate, keeping only
  // the innermost text-holding element so we don't double-count nested spans.
  function dedupeNested(elements) {
    return elements.filter((el) => !elements.some((other) => other !== el && el.contains(other)));
  }

  function findParagraphLikeBlocks(root) {
    const all = root.querySelectorAll("p, div, span, li");
    const candidates = [];
    for (const el of all) {
      if (el.closest(EXCLUDED_ANCESTORS_SELECTOR)) continue;
      if (!isParagraphLike(el)) continue;
      if (el.innerText.trim().length < MIN_PARAGRAPH_LENGTH) continue;
      candidates.push(el);
    }
    return dedupeNested(candidates);
  }

  function findArticleContainer(blocks) {
    const explicit = document.querySelector("article");
    if (explicit && explicit.innerText.trim().length > 200) return explicit;

    // Fallback heuristic: pick the element whose contained paragraph-like
    // blocks hold the most total text, ignoring nav/header/footer/aside chrome.
    const candidates = document.querySelectorAll("main, [role='main'], div, section");
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      if (el.closest("nav, header, footer, aside")) continue;
      let score = 0;
      for (const b of blocks) {
        if (el.contains(b)) score += b.innerText.trim().length;
      }
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best || document.body;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function buildChunks(paragraphs) {
    const chunks = [];
    let current = [];
    let currentLen = 0;
    paragraphs.forEach((p, idx) => {
      const text = p.innerText;
      if (currentLen + text.length > CHUNK_CHAR_BUDGET && current.length > 0) {
        chunks.push(current);
        current = [];
        currentLen = 0;
      }
      current.push(idx);
      currentLen += text.length;
    });
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  // Whitelist-walk the model's response so only <b> and <span class="arf-*">
  // survive; everything else (scripts, event handlers, unknown tags/classes
  // the model might be tricked into emitting) is stripped or unwrapped.
  function sanitizeInline(sourceEl, doc) {
    const frag = doc.createDocumentFragment();
    for (const node of Array.from(sourceEl.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        frag.appendChild(doc.createTextNode(node.textContent));
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (tag === "B" || tag === "STRONG") {
          const b = document.createElement("b");
          b.appendChild(sanitizeInline(node, doc));
          frag.appendChild(b);
        } else if (tag === "SPAN" && ALLOWED_CLASSES.has(node.getAttribute("class"))) {
          const span = document.createElement("span");
          span.className = node.getAttribute("class");
          span.appendChild(sanitizeInline(node, doc));
          frag.appendChild(span);
        } else {
          frag.appendChild(sanitizeInline(node, doc));
        }
      }
    }
    return frag;
  }

  function showBadge(text) {
    let badge = document.getElementById("arf-status-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "arf-status-badge";
      badge.className = "arf-status-badge";
      document.body.appendChild(badge);
    }
    badge.textContent = text;
    return badge;
  }

  function removeBadge(delay = 1500) {
    setTimeout(() => {
      const badge = document.getElementById("arf-status-badge");
      if (badge) badge.remove();
    }, delay);
  }

  async function processChunk(paragraphs, indices, badge, done, total) {
    const requestHtml = indices
      .map((i) => `<p id="${i}">${escapeHtml(paragraphs[i].innerText)}</p>`)
      .join("\n");

    const result = await chrome.runtime.sendMessage({
      type: "ANALYZE_CHUNK",
      payload: requestHtml,
    });

    if (!result || !result.ok) {
      badge.textContent = `第 ${done + 1} 段处理失败：${result?.error || "未知错误"}`;
      return false;
    }

    const parser = new DOMParser();
    const parsed = parser.parseFromString(`<root>${result.html}</root>`, "text/html");
    const returnedParagraphs = parsed.querySelectorAll("root > p[id]");

    returnedParagraphs.forEach((rp) => {
      const idx = Number(rp.getAttribute("id"));
      const target = paragraphs[idx];
      if (!target) return;
      const sanitized = sanitizeInline(rp, document);
      target.innerHTML = "";
      target.appendChild(sanitized);
      target.classList.add("arf-processed");
    });
    return true;
  }

  async function run() {
    const allBlocks = findParagraphLikeBlocks(document.body);
    const container = findArticleContainer(allBlocks);
    let paragraphs = allBlocks.filter((b) => container.contains(b));
    if (paragraphs.length === 0) paragraphs = allBlocks; // container heuristic found nothing usable, use everything

    if (paragraphs.length === 0) {
      showBadge("未能在本页找到可识别的文章正文。");
      removeBadge(3000);
      window.__arfRunning = false;
      return;
    }

    const chunks = buildChunks(paragraphs);
    const badge = showBadge(`AI 格式化中... 0/${chunks.length}`);

    for (let i = 0; i < chunks.length; i++) {
      const ok = await processChunk(paragraphs, chunks[i], badge, i, chunks.length);
      if (!ok) break;
      badge.textContent = `AI 格式化中... ${i + 1}/${chunks.length}`;
    }

    badge.textContent = "格式化完成";
    removeBadge();
    window.__arfRunning = false;
  }

  run();
})();
