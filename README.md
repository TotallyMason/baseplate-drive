# Baseplate Drive

A 3D driving simulator on an empty baseplate. Real-time vehicle physics, PBR materials,
sun shadows, image-based lighting, bloom, skid marks and procedural engine audio.

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | Throttle |
| S / ↓ | Brake / reverse |
| A D / ← → | Steer |
| Space | Handbrake |
| E / Q | Shift up / down (manual) |
| T | Toggle auto / manual gearbox |
| C | Chase / cockpit camera |
| R | Reset car |
| M | Mute |
| Esc | Pause |

## Tech

- Three.js — rendering, PBR, PMREM image-based lighting, post-processing
- Rapier3D — rigid bodies and the raycast vehicle controller
- Vanilla HTML/CSS/JS, no build step, fully static

The lighting and post stack take cues from
[abhayexe/realism-three.js](https://github.com/abhayexe/realism-three.js) — HDR-style
environment lighting, ACES tone mapping, soft shadows and restrained bloom.
