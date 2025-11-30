# PROJECT SPECIFICATION: Peer. Desktop (P2P Streamer)

You are an expert Senior Software Engineer specializing in Electron, TypeScript, and Rust/Node.js performance. Your task is to build the MVP for "Peer. Desktop", a Netflix-like desktop application that streams video content directly from BitTorrent networks.

**Core Philosophy:** "Click & Play." No waiting for downloads. The app acts as a streaming client using a custom "Sliding Window" buffer strategy to minimize RAM/Disk usage (max ~50MB active buffer).

---

## 🛠️ Tech Stack (Strict Requirements)

* **Framework:** Electron + Vite + React + TypeScript (Use `electron-vite` template).
* **Styling:** Tailwind CSS **v3.4.17** (Strict version requirement).
* **Torrent Engine:** `webtorrent` (Node.js version).
* **Storage:** `memory-chunk-store` (For RAM-only buffering) & `better-sqlite3` (For persistent metadata).
* **Routing:** `react-router-dom` (HashRouter).
* **Language:** TypeScript (Strict mode enabled).

---

## 🏗️ Architecture Overview

The app must follow the standard Electron process separation model:

1.  **Main Process (Backend / Node.js):**
    * Manages the `WebTorrent` client.
    * Runs a local HTTP server to stream video to the renderer.
    * Handles the SQLite database (`better-sqlite3`).
    * Implements the "Sliding Window" logic to manage memory usage.
2.  **Renderer Process (Frontend / React):**
    * Minimal UI (for now).
    * Video Player (`<video>` tag).
    * Communicates with Main via `ipcRenderer`.
3.  **IPC Bridge:**
    * Secure communication using `contextBridge` in `preload/index.ts`.

---

## 📅 Implementation Phases

Execute these phases step-by-step. Do not proceed to the next phase until the current one is verified.

### PHASE 1: Scaffolding & Configuration

**Goal:** Initialize the project structure and install dependencies.

1.  **Initialize:** Create a new project using `npm create @quick-start/electron` with React & TypeScript.
2.  **Install Deps:**
    * `npm install webtorrent memory-chunk-store better-sqlite3 fs-extra`
    * `npm install -D tailwindcss@3.4.17 postcss autoprefixer`
3.  **Configure Tailwind:**
    * Initialize Tailwind config.
    * Add the directives to `src/renderer/src/assets/main.css` (or equivalent).
    * **Constraint:** Ensure Tailwind scans files in `./src/renderer/index.html` and `./src/renderer/src/**/*.{js,ts,jsx,tsx}`.
4.  **Configure SQLite Build:**
    * Ensure `better-sqlite3` is rebuilt for the Electron version. Add a `postinstall` script: `"electron-builder install-app-deps"`.

---

### PHASE 2: The Streaming Engine (Main Process - CRITICAL)

**Goal:** Create the backend logic that streams torrents without full download.

1.  **Create `src/main/torrent-engine.ts`:**
    * Initialize `WebTorrent` with `{ store: require('memory-chunk-store') }` to force RAM usage.
2.  **Implement Local HTTP Server:**
    * Create a Node.js `http` server inside the Main process.
    * It must handle the `magnet` or `.torrent` file input.
    * It must support HTTP `Range` headers (206 Partial Content) to allow the video player to seek (jump forward/backward).
    * Pipe the file stream (`file.createReadStream({ start, end })`) to the response.
3.  **Implement "Sliding Window" Buffer Logic:**
    * **Requirement:** Do not keep the whole file in RAM.
    * Create a loop (setInterval 1s) that monitors playback position.
    * Logic:
        * Calculate the current piece index based on video playback time.
        * Define a window: `[CurrentPiece - 2]` to `[CurrentPiece + 15]`.
        * Call `file.select(start, end)` for pieces inside the window (High Priority).
        * Call `file.deselect(0, start-1)` and `file.deselect(end+1, total)` to clear old/future data from RAM.
4.  **IPC Handlers:**
    * `torrent:start(magnetOrPath)` -> Returns `http://localhost:PORT/...` URL.
    * `torrent:update-status` -> Sends download speed/progress to UI.

---

### PHASE 3: Data Persistence (SQLite)

**Goal:** Save library and watch history.

1.  **Database Setup `src/main/db.ts`:**
    * Initialize `better-sqlite3`.
    * **Important:** Use `app.getPath('userData')` to store the `.sqlite` file, ensuring it works in the production `.exe` build.
2.  **Schema:**
    * Table `movies`: `id`, `infoHash` (unique), `title`, `magnetURI`, `posterPath`, `duration`.
    * Table `history`: `movieId`, `stoppedAt` (seconds), `lastWatched` (timestamp).
3.  **IPC Handlers:**
    * `db:add-movie(magnetURI)`
    * `db:get-library`
    * `db:save-progress(infoHash, time)`
    * `db:get-progress(infoHash)`

---

### PHASE 4: Minimal Frontend (Renderer)

**Goal:** A "Bare Bones" UI to test functionality (User will rewrite UI later).

1.  **Layout:** Use a simple full-screen dark background (`bg-zinc-950`).
2.  **Input Section:**
    * A large text input for Magnet Links with a "Play" button.
    * A drag-and-drop zone that accepts `.torrent` files.
3.  **Player Section:**
    * A standard HTML5 `<video>` tag.
    * It must accept the `http://localhost...` URL from the Main process.
    * **Synchronization:** Add an event listener on `timeupdate` to send the current timestamp to the Main process via IPC (for the Sliding Window logic).
4.  **Library List:**
    * A simple `<ul>` list below the player showing saved movies from SQLite. Clicking one starts the stream.
5.  **Styling:** Use standard Tailwind utility classes (e.g., `p-4`, `rounded-lg`, `text-white`, `flex`, `gap-4`). No custom CSS.

---

## ✅ Definition of Done

The project is ready when:
1.  I can run `npm run dev` and the app opens.
2.  I can paste a magnet link (e.g., Big Buck Bunny) OR drag a `.torrent` file.
3.  The video starts playing within seconds.
4.  I can seek (jump) to the middle of the video, and it buffers/plays correctly.
5.  The RAM usage stays stable (around ~100-200MB) even for large files.
6.  If I restart the app, my added movies are still there (SQLite works).