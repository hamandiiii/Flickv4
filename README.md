# 🎬 CoFFe House IPTV

[![Expo](https://img.shields.io/badge/Expo-57-000020?logo=expo)](https://expo.dev)
[![React Native](https://img.shields.io/badge/React%20Native-0.86-61DAFB?logo=react)](https://reactnative.dev)
[![Platforms](https://img.shields.io/badge/Platforms-iOS%20%7C%20Android%20%7C%20Web%20%7C%20macOS-lightgrey)]()
[![License](https://img.shields.io/badge/License-Private-red)]()

> A personal Expo and React Native media client for **Movies & Series** (and Xtream live TV).
> No media is provided — bring your own M3U / Xtream Codes / Stremio add-ons.

---

## ✨ Highlights

- 🎞️ **Movies & Series** browsing with genre filters (Action, Horror, Romance, …)
- 📺 **Xtream Codes** support (live TV + VOD + series episodes) + multi-account manager
- 🧩 **Stremio add-ons** — Cinemeta, OpenSubtitles, MediaFusion, Torrentio (YTS), Comet
- ▶️ **Better Player** default + **VLC** alternate, PiP, subtitles, audio tracks, speed, Skip Intro
- ⬇️ **Direct downloads** with progress/cancel + download manager
- ❤️ **Favorites + Watchlist + Continue Watching** (resume position)
- 🌐 **Web (PWA) + iOS** first (Android/Windows supported) — installable PWA
- 🌙 **Light / Dark / System** theme, **RTL (Arabic)** + English
- ⚡ **DNS picker** (1.1.1.1 / 8.8.8.8 / 9.9.9.9) for faster streaming
- 🔍 **Explore** + **Genres** + **Trending** + **What to watch now?** + **Smart collections**
- 🛡️ Secure storage for credentials, local Drift DB, EPG (XMLTV), Debrid, Trakt
- ⌨️ **Keyboard shortcuts** (web): Space = play/pause, ←/→ = seek, F = fullscreen
- 💤 **Sleep timer**, **auto-next episode**, **hide-watched**, **sort by rating/year/title**
- 🎨 **Shimmer skeletons**, **Hero animations**, **splash intro** ("developed by hanadi")
- 📡 **AirPlay / Chromecast** UI scaffolding (native SDK integration pending)

---

## 📸 Screenshots

<!-- Add screenshots here -->
| Home | Details | Player |
|------|---------|--------|
| _coming soon_ | _coming soon_ | _coming soon_ |

---

## 🚀 Quick start

```shell
flutter pub get
dart run build_runner build --delete-conflicting-outputs

```

### Web build
```shell
flutter build web --release   # output: build/web/
```

### iOS build
```shell
flutter build ios --release --no-codesign
```

---

## 🏗️ How it works

```




```

- **Xtream** → parsed into live/movie/series catalogs (Drift DB).
- **Player** → Better Player (default) / VLC (alternate) with subtitles, PiP, speed, skip intro.


---

## 📁 Project layout



---

## 🔧 Development

```shell
flutter pub get
dart run build_runner build --delete-conflicting-outputs



**iOS** target iOS 15+, Xcode + macOS.
**Web** → PWA installable (manifest + service worker).

---

## 📜 Notes




---

## 👨‍💻 Developed by

**hanadi** — CoFFe House IPTV

> _"Watch what you love, your way."_
