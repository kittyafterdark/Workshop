<p align="center">
  <img src="assets/workshop-icon.png" alt="Workshop mascot holding a wrench and preset controls" width="300">
</p>

<h1 align="center">Workshop</h1>

<p align="center">A fullscreen preset workspace for Lumiverse.<br>Edit prompts, test variables, review issues, and keep recovery snapshots—all before one final Apply.</p>

Workshop extends Lumi's Loom preset editor with room to work on large presets. It brings prompt navigation, native editing, variable diagnostics and a live assembly preview into one workspace. An optional assistant can explain and edit the mounted preset using built-in tools. **No MCP server is required.**

## What you can do

| Feature | Use it to… |
| --- | --- |
| Prompt workspace | Search prompts, collapse categories, and edit two prompts side by side. |
| Manage prompts | Add prompts, markers and categories; reorder or delete items without leaving Workshop. |
| Preset find and replace | Preview literal text replacements across prompt content, choose specific prompts or replace all, then Apply with a “Before Find and Replace” recovery backup. |
| Unsynced editing | Work across multiple prompts while keeping changes local until Apply. |
| Variable sandbox | Try mock values in grouped controls without changing real variable selections. |
| Reference preset | Browse and copy a second saved preset read-only alongside your editable draft. |
| Assembly preview | Inspect the resolved messages or assembly stack using your local edits and mocks. |
| Issue reviewer | Step through diagnostics, fix prompts, and apply the finished batch together. |
| Preset backups | Create recovery snapshots, restore locally, and configure timed backups and retention. |
| Agent mode | Ask questions about your preset or let an assistant prepare changes for review. |

## Install and open

Workshop needs a Lumiverse build with Spindle extensions and the controlled Loom editor APIs. It is built against `lumiverse-spindle-types` **0.6.31**. The repository includes the compiled extension, so installing it through Lumi does not require a local build.

1. Open Lumi's **Extensions** tab and choose **Install from Source**.
2. Enter this repository URL and select the **main** branch:

   ```text
   https://github.com/kittyafterdark/Workshop
   ```

3. Enable Workshop and review its permissions. Allow transient storage and give the extension enough storage allocation for backups; Apply creates a recovery snapshot before writing changes.
4. Open a preset in **Loom**, then choose **Workshop** from the preset toolbar.
5. Open a chat if you want to use the live assembly preview.

Reference preset is available in the stable release on **main**.

Built releases are pushed to **main**. Install updates from Lumi's **Extensions** tab.

### Permissions

| Permission | Used for |
| --- | --- |
| `presets` | Reading the mounted preset and applying your finished edits. |
| `ui_panels` | Opening the Workshop workspace and review panels. |
| `ephemeral_storage` | Recovery snapshots in Lumi's transient storage. |
| `generation` | Connection access and model requests for the optional assistant. |
| `mcp_servers` | Optional PresetTools compatibility discovery; built-in assistant tools work without it. |

## Edit locally, Apply when ready

Select a prompt from the left rail and edit it with Lumi's native editor. Search and collapsible categories help navigate large presets. On desktop, a prompt's beside-current control opens a second editor. The rails can be collapsed to give the editor more room; smaller screens use drawers.

**Save keeps a prompt in Workshop's local draft batch.** You can move between prompts and continue editing without applying each one separately. The preview and diagnostics follow the local batch.

When you're finished, choose **Apply** in the Workshop header. Workshop first backs up the previous preset state, then writes your draft batch and asks Lumi to persist it. The header may show **Apply (count)**, **Apply changes**, **Apply restore**, or **Apply drafts**, depending on the work you have staged. Agent drafts require confirmation.

**Discard drafts** returns to the current preset. If the preset changes outside Workshop, a conflicting Apply is refused and your local work is retained.

Local drafts belong to the open Workshop session. They do not survive closing Workshop or reloading the page. Create a backup if you want a recoverable copy of unfinished work.

## Manage the prompt list

Choose **Manage prompts** (+) in the PROMPTS header. The modal shows titles and type/status badges; content editing stays in Workshop's main editor.

- Use **Add prompt**, **Add marker**, or **Add category**. Choose a category for the new prompt or marker, or leave it ungrouped. New items start enabled, with empty content; markers use Lumi's native defaults.
- Drag a handle to reorder. Dropping below a category title inserts a prompt into that category. Categories move with their children. Clear the title search to use drag handles.
- For keyboard or touch use, select a title and choose **Move up**, **Move down**, or a category under **Move to**, then **Move**. Moving an ungrouped prompt up/down skips complete categories; it keeps the prompt ungrouped.
- To move several prompts or markers, check their boxes, choose **Move to**, and select **Move selected**. Items append to the category in preset order. **Select visible prompts** checks the unlocked prompts matching the current search; checked items stay selected when the search changes. **Clear selection** returns to the single-item controls. Category headers are moved separately.
- **Delete** asks for confirmation. For categories, choose **Keep prompts ungrouped** or **Delete category and prompts**. Locked prompts and locked categories are protected; insertion markers can still be organized even when their content is locked.

**Done** keeps the list changes in Workshop and selects the last surviving new item for editing. **Cancel** or Escape discards only the current modal session. Existing prompt drafts are retained. Choose **Apply changes** in Workshop to back up and persist the completed batch, or **Discard drafts** to return to the current preset. Manage prompts is unavailable during Agent mode.

If the preset changes outside Workshop while organizing, Done refuses the stale result. Cancel and reopen the modal against the current preset. Changes after Done are also checked by the final Apply.

## Test variables and inspect the preview

The variable rail starts with sections for **All variables** and **Diagnostics**. The mock form groups variables by their owning prompts and uses the appropriate controls for switches, sliders, text, numbers and selections.

- Change a mock value to test its effect on assembly. Commit text and numeric fields with Tab or by leaving the field.
- Use **Reset mock** for one value or **Reset mocks** to clear all overrides.
- Switch to **Variable map** to inspect definitions, current/default values, references and owning prompts. Dependency links jump to the related prompt.

Mocks affect preview only. They do not change real variable selections, are excluded from backups, and clear when Workshop closes. If a definition changes or becomes ambiguous, its stale mock is dropped.

The preview combines the active chat with your local prompt edits and mocks. **Stack** shows assembly entries; **Resolved** shows the resulting messages. Search, collapse or hide the preview, and resize it to suit your workspace. Assembly preview does not send a model request.

### Work through diagnostics

Choose **Review issues** beside Diagnostics to open the issue reviewer. It covers unknown variable references, duplicate definitions, unused variables and ambiguous block IDs.

Use **Previous** and **Next** to move through the queue, edit with the mounted native prompt editor, and **Save** locally. **Recheck** rebuilds the diagnostic queue from your edits. Closing the reviewer retains those edits in the open Workshop session. **Apply** writes the shared draft batch, including any other local prompt edits.

## Read a second preset

Choose **Reference** beside **Resolved** and **Stack** in the preview panel, then pick a second preset. Browse its collapsible prompt sections, search names and content, and select a prompt to read or copy its text. **Copy reference prompt** copies the full raw prompt, including macros. The text is selectable and read-only.

Reference uses a saved snapshot, so unsynced edits in another editor are not included. **Refresh reference preset** reloads the list and selected preset. The same hide, resize and docking controls apply; phones keep the panel at the bottom. Switching back to Stack or Resolved resumes dry-run assembly. Your reference selection lasts until Workshop closes.

The reference cannot be edited, applied or passed to the assistant. It does not change the mounted preset, local drafts, mocks or backups, and reading it never resolves its macros. Dry-run assembly pauses while Reference is selected.

## Backups and recovery

Open **Preset backups** from the archive icon in the Workshop header.

- **Create backup** captures your current local work, including unsynced prompt edits.
- Every **Apply** creates a snapshot of the previous preset state first. If storage fails, Apply stops and local edits remain available.
- **Restore locally** saves a recovery snapshot of your current work, then stages the selected backup. Inspect or edit it and choose **Apply restore** when ready. **Discard drafts** cancels the staged restore.

Snapshots include the preset name, prompt blocks and variable definitions, preset parameters, prompts and metadata. Lumi retains control of live variable selections; preview mocks are not backed up.

Files live in Workshop's transient storage under `storage/<preset-name>/backups/`, with readable UTC dates and times in their filenames. Backups expire after **seven days**, including across browser restarts. Expired files are cleaned up while the extension is running. Renaming a preset does not hide its earlier backups.

### Automatic backups and count limits

Choose **Settings** beside Create backup and Refresh.

| Setting | Default | Behavior |
| --- | --- | --- |
| Automatic timed backups | Off | Captures local work while Workshop is open; skips unchanged snapshots. |
| Interval in minutes | 15 | Accepts 1–1440 minutes. Closing Workshop stops the timer; reopening resumes it. |
| Maximum backups to keep | 0 | 0 means unlimited. A positive count keeps the newest snapshots for this preset. |

Settings persist per user and preset across restarts. The count includes manual, timed and pre-Apply backups, including snapshots under earlier preset names. **Saving a smaller limit removes older snapshots immediately.** New backups are written before count pruning; the seven-day expiry still applies.

A failed timed backup marks the backup icon and shows details in the backup panel. Timed backups never Apply your edits to the live preset.

## Agent mode

Choose **Agent** in the Workshop header. Its prompt sidebar and local editor work without an MCP server or a model connection.

To use the assistant:

1. Select a **Lumi connection**.
2. Leave **Model** empty to use that connection's current default, choose a model suggestion, or type a model ID. **Refresh models** reloads the connection's catalogue. Changing connection clears the override; it does not change your saved connection settings.
3. Describe a question or edit and send it. Enter sends; Shift+Enter adds a line. Send becomes **Stop** during a run.
4. Review the **Draft changes** card and assembly preview, then choose **Apply drafts** when ready. Successful edits select the first added or affected prompt, clear a hiding search filter and expand its category.

For example:

> Explain what `{{var::gabi_dependency_load}}` controls and which prompts reference it.
>
> Review unknown variable references and propose fixes without changing the tone of the prompts.

Assistant requests and requested preset context go through your selected Lumi connection. The assistant can inspect the mounted preset, variables, diagnostics, preview and local changes. Its draft tools can edit prompt content, names, role/depth, enabled state and order, and insert or delete prompts. Insert and move can target an existing category by exact name; placement beside a prompt inherits its category by default. An empty category requests ungrouped placement. Inconsistent placements that would regroup other prompts are refused.

The assistant can search Lumi's macro catalogue for syntax, arguments and descriptions using a read-only reference tool. Workshop refreshes this catalogue when sending a request; if it is unavailable, a bundled variable-scope guide remains available. Documentation lookup never evaluates macros. Preset input controls, local runtime variables (`setvar`/`getvar`), persisted chat variables (`setchatvar`/`getchatvar`) and global variables are distinct: writing macro text does not create a preset input or immediately set a live variable. Some aliases and preset/request dynamic macros may be absent from the catalogue.

The current tools do not edit locked prompts or locked categories, create/rename/delete category blocks, or edit variable definitions, live selections, mocks, preset settings or regex metadata. The assistant has no Apply tool. Generated changes are staged only when the run finishes successfully and its draft and host snapshots are still current. Stop or a failed run leaves earlier local drafts intact.

The review card lists added, edited, reordered and removed prompts, with line diffs and settings changes such as role, depth and category. **Open prompt** jumps to an affected prompt. Diffs compare the actual drafts before and after the run; tools still send complete replacement content, without requiring a patch format. Long diffs can reveal the remaining lines on demand.

Replies support Markdown. **Thinking** shows reasoning the provider returns after each generation call; it is not a live token stream. Expand **Tool activity** to inspect completed or rejected calls. **Retry last request** resends a failed instruction using the current draft, connection and model, while preserving the next message you've typed.

Leaving agent mode asks whether to keep drafts in Workshop, discard unsynced edits, or stay. Kept agent drafts still need confirmation on Apply. The conversation lasts only for the current agent session.

### Optional PresetTools compatibility

Under **Tool activity → PresetTools compatibility**, you can select an enabled Lumi MCP server for discovery of compatible tool names. Supported operations are translated to Workshop's local draft tools. Remote file tools are not executed, and arbitrary filesystem paths, unified diffs and save/Apply commands are unsupported.

Compatibility covers a subset of PresetTools operations. Built-in tools provide the editing workflow on their own.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| No Workshop launcher | Enable the extension, check its permissions, and open a preset in Loom. Your Lumi build must expose the controlled preset editor APIs. |
| Preview asks for a chat | Open a chat so Lumi can resolve runtime macros and assemble messages. |
| Apply or backup storage fails | Check transient-storage permission and Workshop's pool allocation. Local drafts remain available; retry after resolving storage access. |
| Apply reports a conflict | The preset changed outside Workshop. Keep a recovery backup of local work before discarding drafts and restarting from the current preset. |
| No model suggestions | Retry Refresh models or enter a model ID. Catalogue loading uses Lumi's standard `/api/v1` endpoint and can fail independently of generation. |
| Assistant request fails | Check the selected connection/model and provider access, then use Retry last request. A connection needs a configured model or a Workshop model override. |

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` runs TypeScript checks, unit tests and the build. Build output is committed at `dist/frontend.js` and `dist/backend.js` for Lumi's extension update workflow.

With Playwright and Chromium available to Node, run the controlled browser fixtures:

```bash
node scripts/check-variable-sandbox.mjs
node scripts/check-issue-review.mjs
node scripts/check-agent-workspace.mjs
node scripts/check-backup-settings.mjs
node scripts/check-reference-view.mjs
```

Set `PLAYWRIGHT_MODULE` to an absolute path to Playwright's `index.mjs` if it is installed outside this project. The fixtures use mocked host components, storage and providers, and cover desktop/mobile interaction without modifying personal presets or calling a live model.

See the [changelog](CHANGELOG.md) for release history.
