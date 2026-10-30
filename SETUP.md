# Smackdown Roster: setup

Live page: https://smackdown-roster.vercel.app (Vercel project `smackdown-roster` on Nikhil's account).
Source: `index.html` and `config.js` in this folder. Until `config.js` has Firebase values, the page runs in demo mode (each phone keeps its own copy).

## Connect the shared list (Firebase, free Spark plan, about 5 minutes)

1. Go to https://console.firebase.google.com and sign in with your Google account.
2. Click **Create a project**, name it `smackdown`, turn Google Analytics off, and create it.
3. Left menu: **Build > Firestore Database > Create database**. Pick location **asia-south1 (Mumbai)**, choose **Start in production mode**, and click Create.
4. Open the **Rules** tab, replace everything with the rules below, and click **Publish**.
5. Click the gear icon > **Project settings**. Under "Your apps" click the **</>** (Web) icon, name it `smackdown`, skip Hosting, and click Register.
6. Copy the `firebaseConfig = { ... }` block it shows and send it to Claude. It is not secret: it only names the project.

## Firestore rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Everyone is signed in: Google, or an automatic anonymous sign-in the app does on open.
    function signedIn() { return request.auth != null; }
    function google() { return signedIn() && request.auth.token.firebase.sign_in_provider != 'anonymous'; }

    // What kind of doc games/{id} is
    function isGameId(id) { return id == 'current' || id.matches('^([a-z0-9-]+--)?g-[0-9]{4}-[0-9]{2}-[0-9]{2}$'); }
    function isBox(id, box) { return !isGameId(id) && (id == box || id.matches('^' + box + '-.+$')); }
    function isConfig(id) { return isBox(id, 'config'); }
    function isGame(id) { return isGameId(id) || !(isConfig(id) || isBox(id, 'feedback') || isBox(id, 'activity') || id == 'users'); }

    // Which group config a doc belongs to: games/config (Friday) or games/config-<group>
    function cfgOfGame(id) { return id.matches('^.+--g-.*$') ? 'config-' + id.split('--g-')[0] : 'config'; }
    function cfgOfBox(id, box) { return id == box ? 'config' : id.replace('^' + box + '-', 'config-'); }
    function adminMap(cfg) {
      let p = /databases/$(database)/documents/games/$(cfg);
      let a = exists(p) ? get(p).data.get('admins', null) : null;
      return a is map ? a : {};
    }
    function isAdmin(cfg) { return signedIn() && request.auth.uid in adminMap(cfg); }
    // A group with no admins yet still runs on the old page-side PIN, so it stays open to everyone signed in.
    function canRun(cfg) { return signedIn() && (adminMap(cfg).size() == 0 || isAdmin(cfg)); }

    // ---- Group config: name, day, time, court, PIN hash, admins ----
    function adminsOk(a) { return a == null || (a is map && (a.size() == 0 || (google() && a.keys().hasOnly([request.auth.uid])))); }
    function cfgUpdateOk() {
      let before = resource.data.get('admins', null);
      let after = request.resource.data.get('admins', null);
      let had = before is map && before.size() > 0;
      // Once a group has admins, only an admin changes it, and it can't go back to no admins.
      // Before that, anyone signed in can change it, and the only admin they can add is themselves (the first-admin claim).
      return signedIn() && (had ? (request.auth.uid in before && after is map && after.size() > 0) : adminsOk(after));
    }

    // ---- Game doc: date, time, court, spots, lock, teams result, bill ----
    function gameShapeOk(id) {
      let d = request.resource.data;
      let g = d.get('group', null);
      return d.size() < 30 && d.get('kind', null) != 'config'
        && (id.matches('^.+--g-.*$') ? g == id.split('--g-')[0] : (g == null || g == 'friday'));
    }
    // A player who paid the court can add the bill; after that only they (or an admin) can change or remove it.
    function billOnly() {
      let b0 = resource.data.get('bill', null);
      let b1 = request.resource.data.get('bill', null);
      return request.resource.data.diff(resource.data).affectedKeys().hasOnly(['bill'])
        && resource.data.get('completed', false) != true
        && (b0 == null || (b0 is map && b0.get('owner', null) == request.auth.uid))
        && (b1 == null || (b1 is map && b1.get('owner', null) == request.auth.uid && b1.get('upi', '') is string && b1.get('by', '') is string));
    }

    // ---- Player rows ----
    function nameOk() {
      let n = request.resource.data.get('name', null);
      return n is string && n.size() > 0 && n.size() <= 40;
    }
    // Joining: your own row, not paid, not on a team
    function newRowOk() {
      let d = request.resource.data;
      return d.get('owner', null) == request.auth.uid && d.get('paid', false) == false && d.get('team', null) == null
        && (d.get('uid', null) == null || d.get('uid', null) == request.auth.uid);
    }
    // Your own row (made on this phone, or carrying your Google account). Rows from before owners existed stay editable.
    function ownRowOk() {
      let r = resource.data;
      let d = request.resource.data;
      let ch = d.diff(r).affectedKeys();
      let mine = !('owner' in r) || r.owner == request.auth.uid || (r.get('uid', null) != null && r.get('uid', null) == request.auth.uid);
      return mine
        && (!ch.hasAny(['team']) || d.get('team', null) == null)
        && (!ch.hasAny(['owes']) || d.get('owes', false) == true)
        && (!ch.hasAny(['owner']) || d.get('owner', null) == request.auth.uid)
        && (!ch.hasAny(['uid']) || d.get('uid', null) == null || d.get('uid', null) == request.auth.uid);
    }

    match /games/{game} {
      allow read: if true;
      // group config
      allow create: if isConfig(game) && signedIn() && adminsOk(request.resource.data.get('admins', null));
      allow update: if isConfig(game) && cfgUpdateOk();
      // games: organisers (admins, or anyone while the group has no admins); the bill as above
      allow create, delete: if isGame(game) && canRun(cfgOfGame(game)) && (request.method == 'delete' || gameShapeOk(game));
      allow update: if isGame(game) && signedIn() && gameShapeOk(game) && (canRun(cfgOfGame(game)) || billOnly());

      match /players/{p} {
        allow read: if true;
        // Profiles (games/users/players/{uid}): only that Google account
        allow create, update, delete: if game == 'users' && google() && request.auth.uid == p;
        // Activity log: add only, never edit or delete
        allow create: if isBox(game, 'activity') && signedIn()
          && request.resource.data.get('text', null) is string && request.resource.data.text.size() <= 300
          && (request.resource.data.get('uid', null) == null || request.resource.data.get('uid', null) == request.auth.uid);
        // Feedback: anyone signed in sends; organisers delete
        allow create: if isBox(game, 'feedback') && signedIn()
          && request.resource.data.get('text', null) is string && request.resource.data.text.size() <= 1000;
        allow delete: if isBox(game, 'feedback') && canRun(cfgOfBox(game, 'feedback'));
        // Game list rows
        allow create: if isGame(game) && signedIn() && nameOk() && (canRun(cfgOfGame(game)) || newRowOk());
        allow update: if isGame(game) && signedIn() && nameOk() && (canRun(cfgOfGame(game)) || ownRowOk());
        allow delete: if isGame(game) && canRun(cfgOfGame(game));
      }
    }
    // Saved weeks (Friday stats): organisers add, nobody edits or deletes
    match /history/{week} {
      allow read: if true;
      allow create: if canRun('config');
      allow update, delete: if false;
    }
  }
}
```

## How it works

- Anyone with the link can join, drop out, or say "I've paid". No sign-in.
- Captain actions (tick payments, pick teams, winner, game details, lock, new week) need the captain PIN. The first person to open **Captain** sets it. The PIN is checked in the page, not by Firebase, so it stops mistakes rather than a determined prankster. Fine for a friends group.
- Each player is a separate database record, so two people editing at the same time don't overwrite each other. Order on the list uses the server's clock.
- "Start next week's list" saves the week to Past games (feeds the stats table), clears players, and moves the date on 7 days.

## Games and groups (data layout)

No rule changes are needed; everything lives under `games/{doc}`.

- Each game is its own doc with a `players` subcollection. The Friday group uses `games/current` (the original game) and `games/g-YYYY-MM-DD`.
- Other groups are opened with a link like `/?g=monday`. Their game docs carry `group: "monday"` and use ids like `games/monday--g-2026-11-02`.
- Group settings and the captain PIN hash: `games/config` (Friday) and `games/config-<group>` (others), with `kind: "config"`, `name`, `weekday` (0 = Sunday), `time`, `court`, `pinHash`.
- Feedback: `games/feedback/players` (Friday) and `games/feedback-<group>/players`.
- A game completes by itself once the bill is in and everyone has paid (`completed: true` plus a `summary` used by Stats). The app always keeps one upcoming game open on the group's usual day.
