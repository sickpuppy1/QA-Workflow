# Workflow Automator: Macro Recorder, Record & Replay

Automate repetitive tasks, auto-fill forms, and record web workflows with a no-code macro recorder. A Chrome extension that records, replays, and screenshots workflows across any web app — no coding required.

## Installation

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `workflow-automator` folder
4. The extension icon appears in your toolbar

## How to Use

### Recording a Workflow

1. Click the extension icon → **Start Recording**
2. Interact with any web app (clicks, scrolls, typing, tab switches are all captured)
3. A red **REC** badge appears in the top-right of every page while recording
4. Click **Take Screenshot Checkpoint** in the popup anytime you want a saved screenshot
5. Click **Stop & Save** → the workflow is saved to the Dashboard automatically

### Playing Back a Workflow

1. Click the extension icon → **Load Workflow JSON** → select your `workflow.json`
2. Click **Play Workflow**
3. A green HUD overlay shows progress in the active tab
4. All checkpoints are automatically screenshotted and exported when playback ends



## Exported Files

All exports land in `Downloads/workflow-exports/<name>_<timestamp>/`:

```
workflow-exports/
└── my-workflow_2026-03-17T10-30-00/
    ├── workflow.json          ← Full event log (replayable)
    ├── checkpoint_0.png       ← Screenshot at checkpoint 0
    ├── checkpoint_1.png       ← Screenshot at checkpoint 1
    └── checkpoint_2.png
```

## Workflow JSON Format

```json
{
  "name": "my-workflow",
  "recordedAt": 1710000000000,
  "events": [
    { "type": "click", "selector": "#btn-submit", "x": 340, "y": 210, "timestamp": 1000 },
    { "type": "scroll", "scrollX": 0, "scrollY": 450, "timestamp": 1200 },
    { "type": "keydown", "key": "Enter", "timestamp": 1500 },
    { "type": "input", "selector": "#search", "value": "burger", "timestamp": 2000 },
    { "type": "tab_switch", "url": "https://...", "timestamp": 3000 },
    { "type": "checkpoint", "label": "Order placed", "screenshotIndex": 0, "timestamp": 4000 }
  ]
}
```

## File Structure

```
workflow-automator/
├── manifest.json                  Chrome MV3 manifest
├── background/
│   └── service-worker.js          Orchestration: record, play, screenshot, tab tracking
├── content/
│   ├── recorder.js                DOM event capture (injected into every page)
│   └── player.js                  Playback HUD overlay
├── popup/
│   ├── popup.html / .js / .css    Extension popup UI
└── icons/
    ├── icon16.png / icon48.png / icon128.png
```
