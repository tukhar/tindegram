# Tindegram

Swipe through Wikipedia one subject at a time and grow your own tree of rabbit holes.

Live: https://tukhar.github.io/tindegram/

- Swipe left to pass on a subject.
- Swipe up (or tap) for another fact about it.
- Swipe right to keep it in your tree and pick a related subject to go deeper.

Your tree is stored in your browser only.

## Run locally

```bash
node server.mjs
```

Then open http://localhost:5173. To try it on a phone on the same Wi-Fi:

```bash
HOST=0.0.0.0 node server.mjs
```

There is no build step. The app is plain HTML, CSS and JavaScript modules.

## Content

Subjects, text and images come live from the English Wikipedia API. Fresh subjects
are drawn from Featured and Good articles. Wikipedia text is available under
CC BY-SA 4.0; each card links to its source article.
