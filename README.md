# GitHub PR Exporter

One-click, local-only export of GitHub Pull Requests to structured JSON.

## What it does
- Exports the currently open PR page into a downloadable JSON file
- Captures: PR metadata, timeline (comments, reviews, events), review threads with code context, suggested changes, sidebar info (reviewers, labels, milestone)
- Runs locally in your browser (no server, no analytics)

## Install (developer mode)
1) Open `chrome://extensions`
2) Enable **Developer mode**
3) Click **Load unpacked**
4) Select this folder

## Use
1) Open any GitHub Pull Request
2) Click the extension icon
3) A JSON file downloads automatically (named `owner-repo-pr123-[sha]-timestamp.json`)

## Permissions (why they exist)
- `activeTab`: read the current PR page you are viewing
- `scripting`: inject the extractor into the page

## Privacy
- No accounts, no analytics, no telemetry
- No data leaves your machine
- Exports only what is already visible in the page

## License
MIT
