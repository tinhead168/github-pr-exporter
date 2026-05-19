// collector.js — v1.8.0
// Extracts all PM-relevant data from GitHub PR pages.
// Built from live DOM investigation (Feb-Mar 2026).
// Changelog: v1.7→1.8: Strip suggestion widget UI chrome from body text

(() => {
  "use strict";

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ── Rich text ───────────────────────────────────────────────────────

  function richText(el) {
    if (!el) return null;
    const parts = [];
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (t) parts.push(t);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = node.tagName.toLowerCase();
      if (tag === "pre") {
        parts.push("```\n" + node.textContent.trim() + "\n```");
      } else if (tag === "code") {
        parts.push("`" + node.textContent.trim() + "`");
      } else if (/^h[1-6]$/.test(tag)) {
        parts.push("#".repeat(+tag[1]) + " " + clean(node.textContent));
      } else if (tag === "ul" || tag === "ol") {
        $$(":scope > li", node).forEach((li, i) => {
          const prefix = tag === "ol" ? `${i + 1}. ` : "- ";
          parts.push(prefix + clean(li.textContent));
        });
      } else if (tag === "blockquote") {
        parts.push("> " + clean(node.textContent));
      } else if (tag === "table") {
        $$("tr", node).forEach((row) => {
          const cells = $$(":scope > th, :scope > td", row).map((c) =>
            clean(c.textContent)
          );
          parts.push("| " + cells.join(" | ") + " |");
        });
      } else if (tag === "img") {
        const alt = node.getAttribute("alt");
        if (alt) parts.push(alt);
      } else if (tag === "p" || tag === "div" || tag === "a") {
        const inner = richText(node);
        if (inner) parts.push(inner);
      } else {
        const t = clean(node.textContent);
        if (t) parts.push(t);
      }
    }
    return parts.join("\n").trim() || null;
  }

  // ── Permalink builder ───────────────────────────────────────────────

  const baseUrl = location.origin + location.pathname;
  function makePermalink(elementId) {
    if (!elementId) return null;
    return baseUrl + "#" + elementId;
  }

  // ── 1. PR metadata (embedded JSON + DOM state override) ────────────

  function extractMetadata() {
    const script = $('script[data-target="react-app.embeddedData"]');
    let meta = null;
    if (script) {
      try {
        const data = JSON.parse(script.textContent);
        const pr = data?.payload?.pullRequestsLayoutRoute?.pullRequest;
        if (pr) {
          meta = {
            title: pr.title, number: pr.number, state: pr.state,
            author: pr.author?.login || pr.author,
            baseBranch: pr.baseBranch, headBranch: pr.headBranch,
            id: pr.id, relayId: pr.relayId || null,
            commitsCount: pr.commitsCount,
            mergedBy: pr.mergedByName || null, mergedTime: pr.mergedTime || null,
          };
        }
      } catch {}
    }
    if (!meta) meta = {};

    // DOM state override — embedded JSON is stale/cached
    const stateBadge = $(".State, [title='Status: Open'], [title='Status: Closed'], [title='Status: Merged']");
    if (stateBadge) {
      const bt = clean(stateBadge.textContent).toLowerCase();
      if (bt.includes("closed")) meta.state = "CLOSED";
      else if (bt.includes("merged")) meta.state = "MERGED";
      else if (bt.includes("draft")) meta.state = "DRAFT";
      else if (bt.includes("open")) meta.state = "OPEN";
    }
    const headerState = $(".gh-header-meta .State");
    if (headerState) {
      const hs = clean(headerState.textContent).toLowerCase();
      if (hs.includes("closed")) meta.state = "CLOSED";
      else if (hs.includes("merged")) meta.state = "MERGED";
      else if (hs.includes("draft")) meta.state = "DRAFT";
      else if (hs.includes("open")) meta.state = "OPEN";
    }
    if ($(".gh-header-meta .State--merged, .State--purple")) meta.state = "MERGED";
    if ($(".gh-header-meta .State--closed, .State--red")) meta.state = "CLOSED";

    return meta;
  }

  // ── 2. Extract a comment block ─────────────────────────────────────

  function extractComment(container) {
    const authorEl = $("a.author", container);
    const author = authorEl ? clean(authorEl.textContent) : null;
    const botBadge = $(".Label--secondary", container);
    const isBot = botBadge ? clean(botBadge.textContent).toLowerCase() === "bot" : false;
    const timeEl = $("relative-time", container);
    const timestamp = timeEl ? timeEl.getAttribute("datetime") || clean(timeEl.textContent) : null;
    const authorLabel = $(".Label.ml-1", container);
    const role = authorLabel ? clean(authorLabel.textContent) : null;
    const bodyEl = $(".comment-body.markdown-body", container) || $(".comment-body", container) || $(".markdown-body", container);
    const body = richText(bodyEl);
    if (!body && !author) return null;
    const entry = { author, timestamp, body };
    if (isBot) entry.isBot = true;
    if (role) entry.role = role;
    return entry;
  }

  // ── 3. File path finder ────────────────────────────────────────────

  function findFilePath(el) {
    const dpEl = $("[data-path]", el);
    if (dpEl) return dpEl.getAttribute("data-path");
    const fileLink = $("a[href*='#diff-'], a.Link--primary[title]", el);
    if (fileLink) { const t = fileLink.getAttribute("title") || clean(fileLink.textContent); if (t && t.includes("/")) return t; }
    const summaryEl = $("summary", el) || $(".file-info", el);
    if (summaryEl) { const m = clean(summaryEl.textContent).match(/[\w-]+\/[\w./-]+\.\w+/); if (m) return m[0]; }
    for (const a of $$("a", el)) { const text = clean(a.textContent); if (text.match(/^[\w-]+\/[\w./-]+\.\w+$/) && text.length > 5) return text; }
    return null;
  }

  // ── 4. Commit SHA finder ───────────────────────────────────────────

  function findCommitSha(el) {
    for (const a of $$("a", el)) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/commits?\/([0-9a-f]{7,40})/);
      if (m) return { sha: m[1], url: location.origin + href };
    }
    const codeEl = $("code, tt, .sha", el);
    if (codeEl) { const text = clean(codeEl.textContent); if (/^[0-9a-f]{7,40}$/.test(text)) return { sha: text, url: null }; }
    return null;
  }

  // ── 5. Badge labels from img alt text ──────────────────────────────

  const BADGE_PATTERNS = [
    { re: /^P([0-4])\s*(?:Badge)?$/i,       fn: m => [`P${m[1]}`] },
    { re: /^security[- ](high|medium|low|critical)$/i,
      fn: m => ["Security", m[1].charAt(0).toUpperCase() + m[1].slice(1) + " Priority"] },
    { re: /^(high|medium|low|critical)$/i,
      fn: m => [m[1].charAt(0).toUpperCase() + m[1].slice(1) + " Priority"] },
  ];

  function extractBadgeLabels(commentEl) {
    const labels = [];
    for (const img of $$("img", commentEl)) {
      const alt = (img.getAttribute("alt") || "").trim();
      if (!alt || alt.startsWith("@")) continue;
      for (const pattern of BADGE_PATTERNS) {
        const m = alt.match(pattern.re);
        if (m) { for (const l of pattern.fn(m)) { if (!labels.includes(l)) labels.push(l); } break; }
      }
    }
    return labels;
  }

  // ── 6. Body text cleanup ───────────────────────────────────────────
  // Strip badge alt text AND suggestion widget UI chrome from body

  const SUGGESTION_CHROME_PATTERNS = [
    /^Suggested change$/i,
    /^Suggestion applied$/i,
    /^Commit suggestion/i,
    /^Pending in batch$/i,
    /^Remove from batch$/i,
    /^Commit suggestions?\d*$/i,
    /^Commit changes$/i,
    /^Add suggestion to batch$/i,
    /^\|.*\|$/,  // table rows from inline diffs
  ];

  function stripBodyChrome(body) {
    if (!body) return body;
    const lines = body.split("\n");

    // Strip leading badge alt text lines
    while (lines.length > 0) {
      const line = lines[0].trim();
      if (/^P[0-4]\s*Badge$/i.test(line) ||
          /^security[- ](high|medium|low|critical)$/i.test(line) ||
          /^(high|medium|low|critical)$/i.test(line)) {
        lines.shift();
      } else break;
    }

    // Strip trailing suggestion widget chrome
    // Find the last occurrence of "Suggested change" and truncate from there
    let cutIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^Suggested change$/i.test(lines[i].trim())) {
        cutIdx = i;
        // Only cut if what follows looks like widget chrome (table rows, "Suggestion applied", etc.)
        let chromeCount = 0;
        for (let j = i + 1; j < lines.length && j < i + 15; j++) {
          const l = lines[j].trim();
          if (SUGGESTION_CHROME_PATTERNS.some(p => p.test(l)) || l === "") chromeCount++;
        }
        if (chromeCount >= 2) break; // confirmed widget chrome follows
        else cutIdx = -1; // false positive, keep looking
      }
    }
    if (cutIdx >= 0) lines.length = cutIdx;

    return lines.join("\n").trim();
  }

  // ── 7. Extract review threads ──────────────────────────────────────

  function extractReviewThreads(container) {
    const turboFrames = $$('turbo-frame[id^="review-thread-or-comment-id-"]', container);
    const threads = [];

    for (const frame of turboFrames) {
      const details = $("details.review-thread-component", frame) || frame;
      const file = findFilePath(details);

      // Line numbers
      let lineStart = null, lineEnd = null;
      const blobNums = $$(".blob-num[data-line-number]", details);
      if (blobNums.length) {
        const nums = blobNums.map(el => parseInt(el.getAttribute("data-line-number"))).filter(n => !isNaN(n));
        if (nums.length) { lineStart = Math.min(...nums); lineEnd = Math.max(...nums); }
      }
      if (!lineStart) {
        const headerText = clean((details.textContent || "").slice(0, 500));
        const lineMatch = headerText.match(/lines?\s*\+?(\d+)(?:\s*to\s*\+?(\d+))?/i);
        if (lineMatch) { lineStart = parseInt(lineMatch[1]); if (lineMatch[2]) lineEnd = parseInt(lineMatch[2]); }
      }

      // Code context
      const codeEls = $$(".blob-code-inner, .js-file-line", details);
      const codeContext = codeEls.length ? codeEls.map(el => el.textContent.trimEnd()).join("\n").trim() : null;

      // Resolved
      const isResolved = details.hasAttribute("data-resolved") ||
        !!$(".timeline-comment-label-resolved, .js-resolved-badge", details) ||
        (details.tagName === "DETAILS" && !details.open && !!$("[data-resolved]", frame));

      // Outdated
      const outdatedEl = $$(".Label.Label--warning", details).find(el => clean(el.textContent) === "Outdated");
      const isOutdated = !!outdatedEl;

      // Comments
      const commentEls = $$(".review-comment, .js-comment-container", details);
      const comments = [];
      const seen = new Set();

      for (const c of commentEls) {
        if (seen.has(c)) continue;
        seen.add(c);
        const entry = extractComment(c);
        if (!entry) continue;

        // Badge labels from img elements
        const badgeLabels = extractBadgeLabels(c);
        if (badgeLabels.length) entry.labels = badgeLabels;

        // Clean body — strip badge text AND suggestion widget chrome
        entry.body = stripBodyChrome(entry.body);

        // Suggested changes — clean diff only
        const suggestionBlob = $(".js-suggested-changes-blob, .blob-wrapper.suggestion", c);
        if (suggestionBlob) {
          const removedLines = $$(".blob-code-deletion .blob-code-inner", suggestionBlob).map(el => el.textContent.trimEnd());
          const addedLines = $$(".blob-code-addition .blob-code-inner", suggestionBlob).map(el => el.textContent.trimEnd());
          if (removedLines.length || addedLines.length) {
            entry.suggestedChange = {};
            if (removedLines.length) entry.suggestedChange.removed = removedLines;
            if (addedLines.length) entry.suggestedChange.added = addedLines;
          } else {
            const codeText = $$(".blob-code-inner", suggestionBlob).map(el => el.textContent.trimEnd()).join("\n");
            if (codeText) entry.suggestedChange = { code: codeText };
          }
        }

        // Comment permalink
        const commentAnchor = $('[id^="issuecomment-"], [id^="discussion_r"]', c);
        if (commentAnchor) { entry.commentId = commentAnchor.id; entry.permalink = makePermalink(commentAnchor.id); }

        comments.push(entry);
      }

      if (comments.length) {
        const thread = { threadId: frame.id || null, file, resolved: isResolved, outdated: isOutdated, comments };
        if (lineStart) { thread.lineStart = lineStart; if (lineEnd && lineEnd !== lineStart) thread.lineEnd = lineEnd; }
        if (codeContext) thread.codeContext = codeContext;
        threads.push(thread);
      }
    }
    return threads;
  }

  // ── 8. Walk the timeline ────────────────────────────────────────────

  function extractTimeline() {
    const discussion = $(".js-discussion");
    if (!discussion) return [];
    const items = [];

    // PR description
    const firstPartial = $("rails-partial", discussion);
    if (firstPartial) {
      const desc = extractComment(firstPartial);
      if (desc) {
        desc.type = "pr-description";
        const issueEl = $('[id^="issue-"], [id^="pullrequest-"]', firstPartial);
        if (issueEl) { desc.elementId = issueEl.id; desc.permalink = makePermalink(issueEl.id); }
        items.push(desc);
      }
    }

    const timelineEls = $$(".js-timeline-item", discussion);
    for (const tItem of timelineEls) {

      // Case A: Code review
      const reviewEl = $('[id^="pullrequestreview-"]', tItem);
      if (reviewEl) {
        const reviewHeader = $(".TimelineItem-body", tItem);
        const author = $("a.author", reviewHeader);
        const timeEl = $("relative-time", reviewHeader);
        const botBadge = $(".Label--secondary", reviewHeader);
        const summaryComment = extractComment($(".timeline-comment-group", tItem) || tItem);
        const reviewId = reviewEl.id || null;
        let reviewState = null;
        const stateEl = $(".review-status-label, .State", tItem);
        if (stateEl) reviewState = clean(stateEl.textContent).toLowerCase();
        if (!reviewState) {
          if ($(".octicon-check, .color-fg-success", tItem)) reviewState = "approved";
          else if ($(".octicon-x, .color-fg-danger", tItem)) reviewState = "changes_requested";
          else reviewState = "commented";
        }
        const commitInfo = findCommitSha(tItem);
        const threads = extractReviewThreads(tItem);
        items.push({
          type: "review", reviewId, reviewState,
          reviewedCommit: commitInfo?.sha || null,
          author: author ? clean(author.textContent) : summaryComment?.author,
          timestamp: timeEl ? timeEl.getAttribute("datetime") || clean(timeEl.textContent) : summaryComment?.timestamp,
          isBot: botBadge ? clean(botBadge.textContent).toLowerCase() === "bot" : false,
          permalink: makePermalink(reviewId),
          body: summaryComment?.body || null,
          threadCount: threads.length, unresolvedCount: threads.filter(t => !t.resolved).length,
          threads,
        });
        continue;
      }

      // Case B: Regular comment
      const commentGroup = $(".timeline-comment-group", tItem);
      if (commentGroup) {
        const entry = extractComment(commentGroup);
        if (entry) {
          entry.type = "comment";
          const groupId = commentGroup.id || "";
          if (groupId.startsWith("issuecomment-")) { entry.commentId = groupId; entry.permalink = makePermalink(groupId); }
          items.push(entry);
          continue;
        }
      }

      // Case C: Events
      const eventBody = $(".TimelineItem-body", tItem);
      if (eventBody) {
        let text = clean(eventBody.textContent);
        if (text && !text.startsWith("reviewed")) {
          const evAuthor = $("a.author", eventBody);
          const evTime = $("relative-time", eventBody);
          const verifiedIdx = text.indexOf("Verified");
          if (verifiedIdx > 0) text = text.slice(0, verifiedIdx).trim();
          const commitInfo = findCommitSha(eventBody);
          const event = {
            type: "event",
            author: evAuthor ? clean(evAuthor.textContent) : null,
            timestamp: evTime ? evTime.getAttribute("datetime") || clean(evTime.textContent) : null,
            text,
          };
          if (commitInfo) { event.commitSha = commitInfo.sha; event.commitUrl = commitInfo.url || (location.origin + location.pathname.replace(/\/pull\/\d+.*/, "") + "/commit/" + commitInfo.sha); }
          const targetEl = $("[id].js-targetable-element, [id].js-targetable-elem", tItem);
          if (targetEl) { event.elementId = targetEl.id; event.permalink = makePermalink(targetEl.id); }
          items.push(event);
        }
      }
    }
    return items;
  }

  // ── 9. Sidebar — section-aware ─────────────────────────────────────

  function extractSidebar() {
    const sidebar = $("#partial-discussion-sidebar");
    if (!sidebar) return null;
    const result = {};
    for (const section of $$(".discussion-sidebar-item", sidebar)) {
      const headingEl = $(".discussion-sidebar-heading, .text-bold", section);
      const heading = headingEl ? clean(headingEl.textContent).toLowerCase() : "";
      if (heading === "reviewers") {
        const names = $$(".css-truncate-target, .assignee", section).map(el => clean(el.textContent)).filter(Boolean);
        if (names.length) result.reviewers = [...new Set(names)];
      }
      if (heading === "assignees") {
        const names = $$(".css-truncate-target, .assignee", section).map(el => clean(el.textContent)).filter(n => n && !n.toLowerCase().includes("no one"));
        if (names.length) result.assignees = [...new Set(names)];
      }
      if (heading === "labels") {
        const labels = $$(".IssueLabel, .js-issue-labels a", section).map(l => clean(l.textContent)).filter(Boolean);
        if (labels.length) result.labels = labels;
      }
      if (heading === "milestone") {
        const ms = $(".milestone-name, a", section);
        if (ms) { const t = clean(ms.textContent); if (t && !t.includes("No milestone") && !t.includes("reload this page") && !t.includes("Uh oh")) result.milestone = t; }
      }
      if (heading === "projects") {
        const projs = $$("a", section).map(a => clean(a.textContent)).filter(p => p && !p.includes("None") && !p.includes("reload this page") && !p.includes("Uh oh"));
        if (projs.length) result.projects = projs;
      }
    }
    return Object.keys(result).length ? result : null;
  }

  // ── 10. Checks ─────────────────────────────────────────────────────

  function extractChecks() {
    const heading = $(".status-heading, .h4.status-heading");
    if (!heading) return null;
    return { summary: clean(heading.textContent) };
  }

  // ── Assemble ────────────────────────────────────────────────────────

  const timeline = extractTimeline();
  const reviews = timeline.filter(t => t.type === "review");
  const allThreads = reviews.flatMap(r => r.threads || []);

  return {
    version: "1.8.0",
    exportedAt: new Date().toISOString(),
    url: location.href,
    pr: extractMetadata(),
    summary: {
      totalTimelineItems: timeline.length,
      reviewCount: reviews.length,
      totalThreads: allThreads.length,
      unresolvedThreads: allThreads.filter(t => !t.resolved).length,
      resolvedThreads: allThreads.filter(t => t.resolved).length,
      outdatedThreads: allThreads.filter(t => t.outdated).length,
      filesWithComments: [...new Set(allThreads.map(t => t.file).filter(Boolean))],
    },
    timeline,
    sidebar: extractSidebar(),
    checks: extractChecks(),
  };
})();
