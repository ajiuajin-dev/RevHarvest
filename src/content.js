(() => {
  if (globalThis.__sheinReviewCollectorInstalled) return;
  globalThis.__sheinReviewCollectorInstalled = true;

  let cancelled = false;
  let running = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "CANCEL_COLLECTION") {
      cancelled = true;
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "COLLECT") {
      if (!running) collect().catch(reportFailure);
      sendResponse({ ok: true });
    }
  });

  async function collect() {
    running = true;
    cancelled = false;
    await revealReviews();
    let staleRounds = 0;
    let iteration = 0;
    let endConfirmed = false;

    while (!cancelled && staleRounds < 6) {
      iteration += 1;
      const reviews = extractReviews();
      const expectedTotal = findExpectedTotal();
      await chrome.runtime.sendMessage({ type: "BATCH", reviews, expectedTotal, iteration });

      if (expectedTotal !== null && reviews.length >= expectedTotal) break;
      if (hasNoMoreReviewsMarker()) {
        endConfirmed = true;
        break;
      }
      const beforeSignature = reviewSignature(reviews);
      const advanced = await advanceReviewList(beforeSignature);
      staleRounds = advanced ? 0 : staleRounds + 1;
    }

    if (cancelled) {
      running = false;
      return;
    }
    const reviews = extractReviews();
    await chrome.runtime.sendMessage({
      type: "FINISH",
      reviews,
      expectedTotal: findExpectedTotal(),
      endConfirmed: endConfirmed || hasNoMoreReviewsMarker(),
      completionReason: endConfirmed || hasNoMoreReviewsMarker() ? "no-more-reviews-marker" : "stalled"
    });
    running = false;
  }

  async function revealReviews() {
    const candidates = [...document.querySelectorAll("button, a, [role='tab']")];
    const trigger = candidates.find((element) => /review|评价|评论|avis|reseña/i.test(element.textContent ?? ""));
    trigger?.click();
    await waitForMutationOrTimeout(900);
  }

  function extractReviews() {
    const selectors = [
      "[data-review-id]",
      "[data-comment-id]",
      "[data-expose-id][class*='reviews']",
      ".common-reviews-new__list-item",
      ".j-expose__common-reviews__list-item",
      "[class*='review'][class*='item']",
      "[class*='reviews'][class*='item']",
      "[class*='comment'][class*='item']",
      "[class*='review-item']",
      "[class*='comment-item']",
      "[class*='reviewItem']",
      "[class*='reviews__list-item']"
    ];
    const explicitCards = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    const anchoredCards = findCardsFromReviewAnchors();
    const cards = uniqueElements([...explicitCards, ...anchoredCards]);
    return cards.map(parseCard).filter((review) => review.text || review.rating !== null);
  }

  function findCardsFromReviewAnchors() {
    const anchors = [...document.querySelectorAll([
      ".rate-des",
      ".common-reviews-new__middle-text",
      "[class*='review-content']",
      "[class*='reviewContent']",
      "[class*='comment-content']",
      "[data-testid*='review-content' i]"
    ].join(","))];

    return anchors.map(findReviewCardAncestor).filter(Boolean);
  }

  function findReviewCardAncestor(anchor) {
    let candidate = anchor;
    for (let depth = 0; candidate && depth < 9; depth += 1, candidate = candidate.parentElement) {
      const text = candidate.textContent?.trim() ?? "";
      if (text.length > 10000) break;
      const signals = [
        candidate.querySelector(".nikename, [class*='author'], [class*='user-name'], [class*='nickname']"),
        candidate.querySelector(".date, time, [class*='review-date'], [class*='comment-date']"),
        candidate.querySelector(".rate-star, [aria-label*='rating' i], [aria-label*='star' i], [class*='star']"),
        candidate.querySelector(".like-num, [class*='helpful'], [class*='like']")
      ].filter(Boolean).length;
      if (signals >= 2) return candidate;
    }
    return anchor.closest("li, article") || anchor.parentElement;
  }

  function parseCard(card) {
    const pickText = (...selectors) => {
      for (const selector of selectors) {
        const value = card.querySelector(selector)?.textContent?.trim();
        if (value) return value;
      }
      return "";
    };
    const text = pickText(".rate-des", ".common-reviews-new__middle-text", "[class*='content']", "[class*='text']", "[class*='comment']", "p");
    const ratingElement = card.querySelector("[aria-label*='rating' i], [aria-label*='star' i], .rate-star, [class*='star'], [class*='rating']");
    const ratingText = ratingElement?.getAttribute("aria-label") || ratingElement?.textContent?.trim() || "";
    const ratingMatch = ratingText.match(/([1-5](?:\.\d+)?)/);
    const images = [...card.querySelectorAll("img")]
      .map((image) => image.currentSrc || image.src)
      .filter((src) => /^https?:/i.test(src));
    return {
      id: card.dataset.reviewId
        || card.dataset.commentId
        || card.getAttribute("data-id")
        || card.getAttribute("data-expose-id")
        || "",
      author: pickText(".nikename", "[class*='user']", "[class*='author']", "[class*='name']"),
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      date: pickText(".date", "time", "[class*='date']", "[class*='time']"),
      text,
      variant: pickText("[class*='sku']", "[class*='variant']", "[class*='goods-info']"),
      likes: parseFirstNumber(pickText(".like-num", "[class*='like']", "[class*='helpful']")),
      images,
      sourceUrl: location.href
    };
  }

  function findExpectedTotal() {
    const nodes = [...document.querySelectorAll(
      ".common-reviews__tab-item_active span, h2, h3, button, [role='tab']"
    )];
    for (const node of nodes) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 120) continue;
      const normalized = text.replace(/,/g, "");
      const match = normalized.match(/(?:review|评价|评论|avis|reseña)[^0-9]{0,12}(\d+)(\+)?/i)
        ?? normalized.match(/(\d+)(\+)?[^0-9]{0,12}(?:review|评价|评论|avis|reseña)/i);
      if (match && !match[2]) return Number(match[1]);
    }
    return null;
  }

  function hasNoMoreReviewsMarker() {
    const pattern = /^(?:no more reviews?|no more comments?|没有更多(?:评价|评论)|暂无更多(?:评价|评论)|已显示全部(?:评价|评论))\.?$/i;
    return [...document.querySelectorAll("body *")].some((element) => {
      if (element.children.length > 3 || element.getClientRects().length === 0) return false;
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      return pattern.test(text);
    });
  }

  function clickLoadMore() {
    const controls = [...document.querySelectorAll("button, [role='button'], a")];
    const button = controls
      .filter(isUsableControl)
      .map((element) => ({ element, score: continuationScore(element) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.element;
    if (!button) return false;
    button.scrollIntoView({ block: "center", behavior: "auto" });
    button.click();
    return true;
  }

  function isUsableControl(element) {
    const hidden = element.getClientRects().length === 0;
    const disabled = element.disabled
      || element.getAttribute("aria-disabled") === "true"
      || /(^|\s)(disabled|is-disabled)(\s|$)/i.test(element.className || "");
    return !hidden && !disabled;
  }

  function continuationScore(element) {
    const text = element.textContent?.trim() ?? "";
    const label = [
      text,
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("title") ?? "",
      typeof element.className === "string" ? element.className : ""
    ].join(" ");
    const paginationContext = element.closest("[class*='pagination'], nav[aria-label*='pagination' i]");

    if (/load more|show more|view more|加载更多|查看更多|more reviews/i.test(label)) return 100;
    if (/next page|next|下一页|下页|pagination[-_\s]*(next|right)/i.test(label)) {
      return paginationContext ? 95 : 70;
    }
    if (paginationContext && /(^|[-_\s])(next|right)([-_\s]|$)/i.test(label)) return 90;
    return 0;
  }

  async function advanceReviewList(beforeSignature) {
    const clicked = clickLoadMore();
    if (clicked && await waitForReviewChange(beforeSignature, 10000)) return true;

    const scrolled = scrollReviewSurface();
    if (scrolled && await waitForReviewChange(beforeSignature, 5000)) return true;

    return false;
  }

  function reviewSignature(reviews = extractReviews()) {
    return reviews
      .map((review) => review.id || `${review.author}|${review.date}|${review.text}`)
      .join("\u241e");
  }

  async function waitForReviewChange(beforeSignature, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!cancelled && Date.now() < deadline) {
      await wait(250);
      if (reviewSignature() !== beforeSignature) return true;
    }
    return false;
  }

  function scrollReviewSurface() {
    const candidates = [...document.querySelectorAll("[class*='review'], [class*='comment'], [role='dialog']")]
      .filter((element) => {
        const overflowY = getComputedStyle(element).overflowY;
        return /(auto|scroll)/i.test(overflowY) && element.scrollHeight > element.clientHeight + 20;
      });
    const target = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (target) {
      const before = target.scrollTop;
      target.scrollTo({ top: target.scrollHeight, behavior: "auto" });
      if (target.scrollTop !== before) return true;
    }
    const before = window.scrollY;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
    return window.scrollY !== before;
  }

  function waitForMutationOrTimeout(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      };
      const observer = new MutationObserver(finish);
      observer.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function uniqueElements(elements) {
    return [...new Set(elements)].filter((element) => {
      const containsNestedCard = elements.some((other) => {
        if (other === element || !element.contains(other)) return false;
        const otherText = other.querySelector?.(".rate-des, [class*='review-content'], [class*='comment-content']")?.textContent?.trim();
        return Boolean(otherText);
      });
      return !containsNestedCard;
    });
  }

  function parseFirstNumber(value) {
    const match = String(value).replace(/,/g, "").match(/\d+/);
    return match ? Number(match[0]) : null;
  }

  async function reportFailure(error) {
    running = false;
    await chrome.runtime.sendMessage({ type: "FAIL", error: error?.message ?? String(error) });
  }
})();
