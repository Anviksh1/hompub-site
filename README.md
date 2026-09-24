# HomPub site

Static site for HomPub (independent Android/iOS app studio) — app
showcase + privacy policy. Plain landing page, no dashboard, no
backend: just HTML/CSS, free to host forever.

## HomPub Routine (web app)

`apps/hompub-routine/` is a working web app, not just a landing page:
a daily routine + schedule with reminders. Plain HTML/CSS/JS, no build
step, no backend — data lives in the browser's localStorage. It is an
installable PWA (`manifest.webmanifest` + `sw.js` for offline use and
notification clicks). Reminders fire while the page is open (a
background tab or installed app is fine); there's no push server.

Run it locally with any static server from the repo root, e.g.
`python3 -m http.server` → http://localhost:8000/apps/hompub-routine/
(service workers and notifications need http://localhost or https,
not `file://`).

## Deploy (one-time)

1. Create a new **public** repo on GitHub, e.g. `hompub-site`
   (github.com/new). Don't initialize it with a README.
2. From this folder:
   ```
   git remote add origin https://github.com/<your-username>/hompub-site.git
   git branch -M main
   git push -u origin main
   ```
3. On GitHub: repo → Settings → Pages → Source: "Deploy from a branch"
   → Branch: `main` / `(root)` → Save.
4. GitHub gives you a URL like
   `https://<your-username>.github.io/hompub-site/` within a minute or two.

## Later updates

Edit the HTML/CSS here, then:
```
git add -A && git commit -m "update site"
git push
```
GitHub Pages redeploys automatically within a minute.

## Custom domain (hompub.com or similar) — ~$10–11/year, the only cost

1. **Buy the domain.** Porkbun (~$10.99/yr, no renewal markup games) or
   Cloudflare Registrar (~$10.44/yr, sold at their literal cost) are
   the cheapest honest options. Avoid registrars with a cheap first
   year that jumps on renewal.
2. **Add a `CNAME` file** to this repo containing just the domain
   name (e.g. `hompub.com`), commit, and push.
3. **At the registrar's DNS settings**, add:
   - Four `A` records for the apex (`@`) pointing to:
     `185.199.108.153`, `185.199.109.153`,
     `185.199.110.153`, `185.199.111.153`
   - One `CNAME` record for `www` pointing to
     `<your-username>.github.io`
4. **In GitHub → Settings → Pages**, enter the domain under "Custom
   domain" and save. GitHub auto-provisions a free TLS certificate
   once DNS resolves (minutes to a few hours) — then tick
   "Enforce HTTPS".

Total ongoing cost: the domain only (~$10-11/yr). Hosting stays free.
