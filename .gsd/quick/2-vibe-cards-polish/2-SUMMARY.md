# Quick Task: Vibe cards polish

**Date:** 2026-05-12
**Branch:** gsd/quick/2-vibe-cards-polish

## What Changed

- Fixed title input clearing on modal open — inputs had no oninput/onchange handlers so keystrokes never updated vibeModalState; added handlers to all fields plus a focus guard in renderVibeModal so async renders don't reset focused inputs
- Replaced VIBE_LANES with one lane per board phase (Discussing→Done) so lane dropdown matches column names exactly; added LEGACY_LANE_MAP to remap old ids (backlog→discussing, in-progress→executing, review→validating) on existing cards
- Removed status field from modal UI and card chip renderer (preserved in API payload for server compat)
- Fixed create/delete not closing the modal — saving/deleting flags were true when closeVibeModal was called (guard blocked it); moved close to finally after clearing flags using a succeeded boolean
- Removed Card ID field from modal entirely
- Added hide/unhide for milestone cards and quick chips — localStorage-persisted Set, ✕ button on hover, "Show hidden (N)" header toggle with dimmed card-hidden style
- Fixed instance delete X button — e.currentTarget was null for inline onclick handlers; switched to addEventListener so currentTarget is populated and the two-step confirm flow works
- Added native macOS folder picker for Add Instance via GET /api/pick-folder (osascript choose folder → POSIX path); Browse… button auto-fills name from last path component
- Added Vibe Card comments: POST/DELETE /api/vibe-cards/:id/comments endpoints, comments[] field on card model (allowedKeys + normalization roundtrip fixed), full comment thread in modal below description with timestamps and hover-delete
- Moved "+ Vibe" button from Discussing column header to main app header
- Fixed drag to empty Researching/Planning columns — moved dragover/drop listeners from col (.phase-column) to colEl (.col-cards) with min-height:80px so empty columns have a real drop target; also renamed loop variable to avoid shadowing
- Fixed all field-input width — added width:100%; box-sizing:border-box to .field-input so textareas fill their container
- Added linked quick task ID field on Vibe Card — stores numeric ID in metadata.linkedQuickTaskId; at render time suppresses the standalone quick chip and shows a merged "Vibe + Task" card with ⚡ badge and branch; live match hint in modal shows green confirmed or waiting state
- Changed quick task discovery in reader.js to surface tasks as soon as their directory exists (not just when summary is written); in-progress tasks show with 🔧 icon, amber border, and "in progress" badge in Executing column; completed tasks remain in Done
- Fixed comments lost on server restart — validateVibeCardsPayload was not preserving comments[] during normalization; comments field was also missing from allowedKeys causing startup validation failure

## Files Modified

- `dashboard/public/index.html` — all frontend changes
- `dashboard/server.js` — folder picker endpoint, comment CRUD endpoints, allowedKeys fix, comments normalization fix
- `dashboard/reader.js` — quick task directory-first discovery, done field

## Verification

- Modal input persistence: typed title stays across poll cycles and session load callbacks
- Lane dropdown matches board column names exactly; existing cards with old lane ids render in correct columns
- Create and delete both close the modal on success
- Instance X button: first click shows "Sure?", second click fires DELETE and removes from sidebar and instances.json
- Browse… button opens native macOS folder picker and fills path + name fields
- Comments: add persists to vibe-cards.json and survives server restart; delete removes immediately
- Quick task #2 (this task) appeared on board in Executing column as in-progress before summary was written; Vibe Card with linkedQuickTaskId=2 showed ⚡ merge badge once task was discovered
- Server restarts no longer drop comments from loaded cards
