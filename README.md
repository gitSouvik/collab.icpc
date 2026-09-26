# collab.cpp — 3-person C++ online IDE

Ace editor (left) + live shared terminal (right). Everyone who opens the same
room URL sees the same code update live and shares one run/compile output.

## What it actually does
- **Editing**: broadcasts the full document on every change (Socket.io). Fine
  for 2–3 people; it's not operational-transform, so if two people type the
  *exact same instant* the last write wins — good enough for pair/trio coding,
  not for a Google-Docs-scale editor.
- **Compiling**: server writes your code to a temp file, runs
  `g++ -O2 -std=c++17`, then runs the binary with an 8s timeout and streams
  stdout/stderr back to everyone in the room.
- **Rooms**: `?room=anything` in the URL. Same room = same session.

## Run it locally first (2 minutes)
Requires Node.js 18+ and g++ installed.
```bash
npm install
npm start
```
Open `http://localhost:3000`. To test multi-user, open two more tabs.

## Get it live tonight so 3 people on different networks can use it

**Fastest: Render.com (free tier, has Docker support, ~5 min)**
1. Push this folder to a new GitHub repo.
2. On render.com → New → Web Service → connect the repo.
3. Render will detect the `Dockerfile` automatically — leave build/start
   commands blank, it uses the Dockerfile's `CMD`.
4. Deploy. You'll get a URL like `https://your-app.onrender.com`.
5. Share `https://your-app.onrender.com/?room=yourteam` with the other two.

**Alternative: Railway.app** — same idea, "Deploy from GitHub", it also reads
the Dockerfile automatically.

**Alternative: your own VPS** — `docker build -t collab-ide . && docker run -p 3000:3000 collab-ide`,
then point a domain or just share `http://your-server-ip:3000`.

> Free-tier note: Render/Railway free instances sleep after inactivity and can
> take ~30s to wake on the first request — worth a heads-up to your teammates.

## Customizing
- Colors/theme: CSS variables at the top of `public/index.html` (`:root` =
  dark, `html[data-theme="light"]` = light). Dark is the default.
- Timeout / memory limits for run: `spawn(binPath, [], { timeout: 8000 })` in
  `server.js`.
- More languages later: add another branch in `compileAndRun` keyed by a
  language field from the client.
