// collector.js — v1.6.0
// Extracts all PM-relevant data from GitHub PR pages.
// Built from live DOM investigation (Feb 2026).

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
      } else if (tag === "p" || tag === "div" || tag === "a") {
        const inner = richText(node);
        if (inner) parts.push(inner);
      } else if (tag === "img") {
        const alt = node.getAttribute("alt");
        if (alt) parts.push(alt);
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

  // ── 1. PR metadata from embedded JSON ──────────────────────────────

  function extractMetadata() {
    const script = $('script[data-target="react-app.embeddedData"]');
    if (!script) return null;
    try {
      const data = JSON.parse(script.textContent);
      const pr = data?.payload?.pullRequestsLayoutRoute?.pullRequest;
      if (!pr) return { raw: data };
      return {
        title:        pr.title,
        number:       pr.number,
        state:        pr.state,
        author:       pr.author?.login || pr.author,
        baseBranch:   pr.baseBranch,
        headBranch:   pr.headBranch,
        id:           pr.id,
        relayId:      pr.relayId || null,
        commitsCount: pr.commitsCount,
        mergedBy:     pr.mergedByName || null,
        mergedTime:   pr.mergedTime || null,
      };
    } catch {
      return null;
    }
  }

  // ── 2. Extract a comment block ─────────────────────────────────────

  function extractComment(container) {
    const authorEl = $("a.author", container);
    const author = authorEl ? clean(authorEl.textContent) : null;

    const botBadge = $(".Label--secondary", container);
    const isBot = botBadge ? clean(botBadge.textContent).toLowerCase() === "bot" : false;

    const timeEl = $("relative-time", container);
    const timestamp = timeEl
      ? timeEl.getAttribute("datetime") || clean(timeEl.textContent)
      : null;

    const authorLabel = $(".Label.ml-1", container);
    const role = authorLabel ? clean(authorLabel.textContent) : null;

    const bodyEl =
      $(".comment-body.markdown-body", container) ||
      $(".comment-body", container) ||
      $(".markdown-body", container);
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
    if (fileLink) {
      const t = fileLink.getAttribute("title") || clean(fileLink.textContent);
      if (t && t.includes("/")) return t;
    }

    const summaryEl = $("summary", el) || $(".file-info", el);
    if (summaryEl) {
      const m = clean(summaryEl.textContent).match(/[\w-]+\/[\w./-]+\.\w+/);
      if (m) return m[0];
    }

    for (const a of $$("a", el)) {
      const text = clean(a.textContent);
      if (text.match(/^[\w-]+\/[\w./-]+\.\w+$/) && text.length > 5) return text;
    }

    return null;
  }

  // ── 4. Extract commit SHA from any container ───────────────────────

  function findCommitSha(el) {
    // GitHub uses /commits/SHA in PR context, /commit/SHA elsewhere
    for (const a of $$("a", el)) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/commits?\/([0-9a-f]{7,40})/);
      if (m) return { sha: m[1], url: location.origin + href };
    }
    // Fallback: code/tt/.sha elements
    const codeEl = $("code, tt, .sha", el);
    if (codeEl) {
      const text = clean(codeEl.textContent);
      if (/^[0-9a-f]{7,40}$/.test(text)) return { sha: text, url: null };
    }
    return null;
  }

  // ── 5. Parse severity/priority labels from body text ───────────────
  // P1/P2/Security/High Priority etc are rendered as markdown text by
  // review bots, not as GitHub Label DOM elements.

  // Badge alt text patterns from bot review comments (discovered via DOM investigation):
  //   Codex:  <img alt="P1 Badge">, <img alt="P2 Badge">
  //   Gemini: <img alt="security-high">, <img alt="high">, <img alt="medium">
  // These are shields.io badge images rendered inside .comment-body

  const BADGE_PATTERNS = [
    { re: /^P([0-4])\s*(?:Badge)?$/i,       fn: m => [`P${m[1]}`] },
    { re: /^security[- ](high|medium|low|critical)$/i,
      fn: m => ["Security", m[1].charAt(0).toUpperCase() + m[1].slice(1) + " Priority"] },
    { re: /^(high|medium|low|critical)$/i,
      fn: m => [m[1].charAt(0).toUpperCase() + m[1].slice(1) + " Priority"] },
  ];

  function extractBadgeLabels(commentEl) {
    const labels = [];
    const imgs = $$("img", commentEl);
    for (const img of imgs) {
      const alt = (img.getAttribute("alt") || "").trim();
      if (!alt || alt.startsWith("@")) continue; // skip avatars
      for (const pattern of BADGE_PATTERNS) {
        const m = alt.match(pattern.re);
        if (m) {
          for (const label of pattern.fn(m)) {
            if (!labels.includes(label)) labels.push(label);
          }
          break;
        }
      }
    }
    return labels;
  }

  // Strip badge alt text that leaked into body from richText img handling
  function stripBadgeTextFromBody(body) {
    if (!body) return body;
    // Remove lines that are just badge alt text (at the start of body)
    const lines = body.split("\n");
    while (lines.length > 0) {
      const line = lines[0].trim();
      if (/^P[0-4]\s*Badge$/i.test(line) ||
          /^security[- ](high|medium|low|critical)$/i.test(line) ||
          /^(high|medium|low|critical)$/i.test(line)) {
        lines.shift();
      } else {
        break;
      }
    }
    return lines.join("\n").trim();
  }

  // ── 6. Extract review threads ──────────────────────────────────────

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
        if (nums.length) {
          lineStart = Math.min(...nums);
          lineEnd = Math.max(...nums);
        }
      }
      if (!lineStart) {
        const headerText = clean((details.textContent || "").slice(0, 500));
        const lineMatch = headerText.match(/lines?\s*\+?(\d+)(?:\s*to\s*\+?(\d+))?/i);
        if (lineMatch) {
          lineStart = parseInt(lineMatch[1]);
          if (lineMatch[2]) lineEnd = parseInt(lineMatch[2]);
        }
      }

      // Code context
      const codeEls = $$(".blob-code-inner, .js-file-line", details);
      const codeContext = codeEls.length
        ? codeEls.map(el => el.textContent.trimEnd()).join("\n").trim()
        : null;

      // Resolved — check the thread-level resolution marker
      const isResolved = details.hasAttribute("data-resolved") ||
        !!$(".timeline-comment-label-resolved, .js-resolved-badge", details) ||
        (details.tagName === "DETAILS" && !details.open && !!$("[data-resolved]", frame));

      // Outdated — Label--warning with text "Outdated" (NOT "Pending in batch")
      const outdatedEl = $$(".Label.Label--warning", details).find(el =>
        clean(el.textContent) === "Outdated"
      );
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

        // Extract severity/priority from badge images in the comment DOM
        const badgeLabels = extractBadgeLabels(c);
        if (badgeLabels.length) entry.labels = badgeLabels;

        // Strip badge alt text that leaked into body
        entry.body = stripBadgeTextFromBody(entry.body);

        // Suggested changes — clean diff only, no UI chrome
        const suggestionBlob = $(".js-suggested-changes-blob, .blob-wrapper.suggestion", c);
        if (suggestionBlob) {
          const removedLines = $$(".blob-code-deletion .blob-code-inner", suggestionBlob)
            .map(el => el.textContent.trimEnd());
          const addedLines = $$(".blob-code-addition .blob-code-inner", suggestionBlob)
            .map(el => el.textContent.trimEnd());

          if (removedLines.length || addedLines.length) {
            entry.suggestedChange = {};
            if (removedLines.length) entry.suggestedChange.removed = removedLines;
            if (addedLines.length) entry.suggestedChange.added = addedLines;
          } else {
            const codeText = $$(".blob-code-inner", suggestionBlob)
              .map(el => el.textContent.trimEnd()).join("\n");
            if (codeText) entry.suggestedChange = { code: codeText };
          }
        }

        // Comment permalink
        const commentAnchor = $('[id^="issuecomment-"], [id^="discussion_r"]', c);
        if (commentAnchor) {
          entry.commentId = commentAnchor.id;
          entry.permalink = makePermalink(commentAnchor.id);
        }

        comments.push(entry);
      }

      if (comments.length) {
        const thread = {
          threadId: frame.id || null,
          file: file,
          resolved: isResolved,
          outdated: isOutdated,
          comments: comments,
        };
        if (lineStart) {
          thread.lineStart = lineStart;
          if (lineEnd && lineEnd !== lineStart) thread.lineEnd = lineEnd;
        }
        if (codeContext) thread.codeContext = codeContext;
        threads.push(thread);
      }
    }

    return threads;
  }

  // ── 7. Walk the timeline ────────────────────────────────────────────

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
        if (issueEl) {
          desc.elementId = issueEl.id;
          desc.permalink = makePermalink(issueEl.id);
        }
        items.push(desc);
      }
    }

    // Timeline items
    const timelineEls = $$(".js-timeline-item", discussion);

    for (const tItem of timelineEls) {

      // Case A: Code review
      const reviewEl = $('[id^="pullrequestreview-"]', tItem);
      if (reviewEl) {
        const reviewHeader = $(".TimelineItem-body", tItem);
        const author = $("a.author", reviewHeader);
        const timeEl = $("relative-time", reviewHeader);
        const botBadge = $(".Label--secondary", reviewHeader);

        const summaryComment = extractComment(
          $(".timeline-comment-group", tItem) || tItem
        );

        const reviewId = reviewEl.id || null;

        // Review state
        let reviewState = null;
        const stateEl = $(".review-status-label, .State", tItem);
        if (stateEl) reviewState = clean(stateEl.textContent).toLowerCase();
        if (!reviewState) {
          if ($(".octicon-check, .color-fg-success", tItem)) reviewState = "approved";
          else if ($(".octicon-x, .color-fg-danger", tItem)) reviewState = "changes_requested";
          else reviewState = "commented";
        }

        // Reviewed commit
        const commitInfo = findCommitSha(tItem);

        const threads = extractReviewThreads(tItem);

        const entry = {
          type: "review",
          reviewId: reviewId,
          reviewState: reviewState,
          reviewedCommit: commitInfo?.sha || null,
          author: author ? clean(author.textContent) : summaryComment?.author,
          timestamp: timeEl
            ? timeEl.getAttribute("datetime") || clean(timeEl.textContent)
            : summaryComment?.timestamp,
          isBot: botBadge ? clean(botBadge.textContent).toLowerCase() === "bot" : false,
          permalink: makePermalink(reviewId),
          body: summaryComment?.body || null,
          threadCount: threads.length,
          unresolvedCount: threads.filter(t => !t.resolved).length,
          threads: threads,
        };

        items.push(entry);
        continue;
      }

      // Case B: Regular comment
      const commentGroup = $(".timeline-comment-group", tItem);
      if (commentGroup) {
        const entry = extractComment(commentGroup);
        if (entry) {
          entry.type = "comment";
          const groupId = commentGroup.id || "";
          if (groupId.startsWith("issuecomment-")) {
            entry.commentId = groupId;
            entry.permalink = makePermalink(groupId);
          }
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

          // Trim signature verification noise
          const verifiedIdx = text.indexOf("Verified");
          if (verifiedIdx > 0) text = text.slice(0, verifiedIdx).trim();

          // Commit SHA — matches both /commit/SHA and /commits/SHA
          const commitInfo = findCommitSha(eventBody);

          const repoPath = location.pathname.replace(/\/pull\/\d+.*/, "");
          const event = {
            type: "event",
            author: evAuthor ? clean(evAuthor.textContent) : null,
            timestamp: evTime
              ? evTime.getAttribute("datetime") || clean(evTime.textContent)
              : null,
            text: text,
          };
          if (commitInfo) {
            event.commitSha = commitInfo.sha;
            event.commitUrl = commitInfo.url || (location.origin + repoPath + "/commit/" + commitInfo.sha);
          }

          const targetEl = $("[id].js-targetable-element, [id].js-targetable-elem", tItem);
          if (targetEl) {
            event.elementId = targetEl.id;
            event.permalink = makePermalink(targetEl.id);
          }

          items.push(event);
        }
      }
    }

    return items;
  }

  // ── 8. Sidebar — section-aware parsing ─────────────────────────────

  function extractSidebar() {
    const sidebar = $("#partial-discussion-sidebar");
    if (!sidebar) return null;
    const result = {};

    // Walk each discussion-sidebar-item by heading
    const sections = $$(".discussion-sidebar-item", sidebar);
    for (const section of sections) {
      const headingEl = $(".discussion-sidebar-heading, .text-bold", section);
      const heading = headingEl ? clean(headingEl.textContent).toLowerCase() : "";

      if (heading === "reviewers") {
        const names = $$(".css-truncate-target, .assignee", section)
          .map(el => clean(el.textContent)).filter(Boolean);
        if (names.length) result.reviewers = [...new Set(names)];
      }

      if (heading === "assignees") {
        const names = $$(".css-truncate-target, .assignee", section)
          .map(el => clean(el.textContent)).filter(Boolean);
        // "No one" or empty means no assignees
        const filtered = names.filter(n => !n.toLowerCase().includes("no one"));
        if (filtered.length) result.assignees = [...new Set(filtered)];
      }

      if (heading === "labels") {
        const labels = $$(".IssueLabel, .js-issue-labels a", section)
          .map(l => clean(l.textContent)).filter(Boolean);
        if (labels.length) result.labels = labels;
      }

      if (heading === "milestone") {
        const ms = $(".milestone-name, a", section);
        if (ms) {
          const text = clean(ms.textContent);
          if (text && !text.toLowerCase().includes("no milestone") &&
              !text.toLowerCase().includes("reload this page") &&
              !text.toLowerCase().includes("uh oh")) result.milestone = text;
        }
      }

      if (heading === "projects") {
        const projs = $$("a", section).map(a => clean(a.textContent)).filter(Boolean);
        const filtered = projs.filter(p =>
          !p.toLowerCase().includes("none") &&
          !p.toLowerCase().includes("reload this page") &&
          !p.toLowerCase().includes("uh oh")
        );
        if (filtered.length) result.projects = filtered;
      }
    }

    return Object.keys(result).length ? result : null;
  }

  // ── 9. Checks status ──────────────────────────────────────────────

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
    version: "1.6.0",
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
    timeline: timeline,
    sidebar: extractSidebar(),
    checks: extractChecks(),
  };
})();
