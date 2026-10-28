# Project skills

Claude Code loads these automatically when working in this repo. All are third-party and
copied verbatim; nothing here ships in the game build.

| Skill | Source | License |
|---|---|---|
| `game-ui-ux`, `input-systems`, `game-feel`, `camera-systems`, `performance-optimization`, `threejs-scene-setup` | [gamedev-skills/awesome-gamedev-agent-skills](https://github.com/gamedev-skills/awesome-gamedev-agent-skills) @ `19d93f9` | Apache-2.0 — see `LICENSE-awesome-gamedev-agent-skills`, `NOTICE-awesome-gamedev-agent-skills` |
| `ui-ux-game` (SKILL.md + accessibility checklist only) | [fcsouza/agent-skills](https://github.com/fcsouza/agent-skills) @ `a06a4d1` | **GPL-3.0** — see `ui-ux-game/LICENSE` |

Only the skills that fit this project (three.js, browser, touch + keyboard racing) were
taken; the engine-specific ones (Godot, Unity, Unreal, Roblox…) were left out. Their
examples are mostly Godot/Unity — apply the patterns, not the APIs.

**Licensing note:** `ui-ux-game` is GPL-3.0. It is kept as guidance only. Do not copy
code from it (or from its upstream `boilerplate/`, deliberately not imported) into `src/`,
or the game code would have to be released under the GPL.
