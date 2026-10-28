# The North Pole, a Sogni World

An interactive, cinematic world of gingerbread, elves and northern lights. Play it at
https://natalieart.github.io/sogni-north-pole/

Pictures painted with Krea 2 and Dark Beast Krea 2, films rendered with MiniMax H3, objects traced
with Segment Anything 3, voices and music made on the Sogni Supernet.

## Building and checking

The approved originals (PNG stills, H3 films) stay in the repository root and are never served.
`np-world.source.json` names them; `node tools/deliver.mjs` writes the served copies into `served/`
(WebP stills; every film twice, at full size and 1280x720, through the Sogni Worlds Kit streaming
profile) and writes `np-world.json` from it, then checks every served file. `node tools/deliver.mjs --check`
only checks. Run it after adding or changing any picture or film.

Player regression tests (headless Chrome, macOS): serve the folder with `node tools/test/serve.mjs "$PWD" 8790`, then
`node tools/test/t1-snowman.mjs http://127.0.0.1:8790/` (add `touch` for a phone), `t2-traverse.mjs` (every place,
hotspot and choice) and `t3-network.mjs` (4 Mbps link, failed files, stalls, rejected playback).
