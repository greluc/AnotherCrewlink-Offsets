# AnotherCrewLink Offsets

Memory offsets for [AnotherCrewLink](https://github.com/greluc/AnotherCrewLink). Every
client reads `lookup.json` from this repository's `main` branch on start, and then the
offsets file that the lookup names for the Among Us build it found.

## What is trusted here

**Whatever is on `main` is what every client reads.** The bundle carries no signature —
that trade is written up in the client's `docs/rust-port/09-technology-migration.md` §2.1,
and the short version is that an Among Us update is a burst rather than a trickle, and
anything that puts a human holding an offline key between that burst and the players is
what keeps them out of the game.

What replaces the key is review. Two rules, and they are the whole trust model:

1. **Nothing lands on `main` without a pull request and a review.** Branch protection
   enforces it, including for administrators.
2. **The sync workflow proposes; it never pushes.** It opens a pull request and records
   which upstream commit the change came from.

If those two stop being true, this repository is a machine for shipping arbitrary memory
offsets to every player, since the offsets decide where the client reads inside another
process — and on 32-bit Windows, where an injection stub writes.

## Layout

| Path | What it is |
| --- | --- |
| `lookup.json` | Maps an Among Us build to an offsets file. Read first, by every client. |
| `offsets/x64/<version>/offsets.json` | The offsets for one 64-bit build. |
| `offsets/x86/<version>/offsets.json` | The same for 32-bit. |
| `.upstream-sync.json` | Which upstream commit the last sync was taken from. |

### The envelope in `lookup.json`

| Field | What it does |
| --- | --- |
| `bundle_version` | Moves whenever the contents do. A client refuses a bundle older than the one it already holds, so reverting a bad merge here cannot be undone by replaying the old file at someone. |
| `min_client_version` | The oldest client that can read this bundle correctly. An older one falls back to the copy built into it and says so. |
| `upstream_commit` | Which upstream commit the offsets were last synced from. |

Clients that predate these fields ignore them, and a client that has them treats a bundle
without them as data rather than an error — so publishing them was not a flag day and
removing them would not be either.

## Workflows

**`sync-upstream.yml`** looks at
[`OhMyGuus/BetterCrewlink-Offsets`](https://github.com/OhMyGuus/BetterCrewlink-Offsets)
four times a day and opens a pull request when it has offsets files this mirror does not.

It is deliberately narrow, because this mirror is no longer a copy of upstream — the
generator was rewritten here and the files produced are newer:

- a file upstream has and this mirror does not is **copied in**;
- a file both have, which upstream has edited since the last sync, is **reported and left
  alone**;
- `lookup.json` is **never** copied, because it is authored here.

**`purge-cdn.yml`** purges jsDelivr for every path a push to `main` changed. The client
falls back to `cdn.jsdelivr.net` when `raw.githubusercontent.com` cannot be reached, and
jsDelivr caches a branch reference for up to twelve hours. Without the purge, the fallback
serves the previous bundle for half a day — and the fallback is reached exactly when
GitHub is having a bad day, which after an Among Us update is when everyone is refetching
at once. Offsets for the previous build parse cleanly and report nothing; the app just
reads the wrong fields.

## Publishing an update by hand

```bash
# 1. Generate or edit the offsets, then bump the envelope.
#    bundle_version must go up, or clients that already hold the current one refuse it.
# 2. Open a pull request. Do not push to main.
# 3. After merge, check that both mirrors agree:
curl -s https://raw.githubusercontent.com/greluc/AnotherCrewlink-Offsets/main/lookup.json | head
curl -s https://cdn.jsdelivr.net/gh/greluc/AnotherCrewlink-Offsets@main/lookup.json | head
```

`purge-cdn.yml` does step 3's purge automatically; the `curl`s are how you confirm it
worked.

## Licence

Offsets data, mirrored from and contributed back to
[BetterCrewlink-Offsets](https://github.com/OhMyGuus/BetterCrewlink-Offsets).
