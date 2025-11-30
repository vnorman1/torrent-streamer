1. Telepítés

Nyisd meg a terminált a projekt mappában:

Bash
npm install fluent-ffmpeg ffmpeg-static
2. Kód (Main Process)

Ezt másold be a Node.js szerveredbe (src/main/index.ts vagy ahol a http.createServer van).

A legfontosabb trükk a replace függvény, különben a kész .exe nem találja majd az FFmpeget!

JavaScript
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

// 1. ELÉRÉSI ÚT JAVÍTÁSA (Kritikus az Electron buildhez!)
// Az Electron "app.asar" fájljából nem futtatható bináris, ezért ki kell csomagolni.
const binaryPath = ffmpegPath
  ? ffmpegPath.replace('app.asar', 'app.asar.unpacked')
  : '';

ffmpeg.setFfmpegPath(binaryPath);

// ... A http szervereden belül, amikor jön a kérés: ...

// 2. A TRANSZKÓDOLÁS (Remuxing)
// 'file' = a webtorrent file objektum
const stream = ffmpeg(file.createReadStream())
  .videoCodec('copy')             // Videót csak másoljuk (0 CPU terhelés)
  .audioCodec('aac')              // Hangot AAC-re konvertáljuk (hogy szóljon)
  .audioChannels(2)               // Sztereó
  .format('mp4')                  // MP4 konténerbe csomagoljuk
  .outputOptions([
    '-movflags frag_keyframe+empty_moov', // Fontos: ettől lesz streamelhető
    '-preset ultrafast'           // Hogy azonnal induljon
  ])
  .on('error', (err) => console.log('FFmpeg hiba:', err.message));

// 3. KÜLDÉS A LEJÁTSZÓNAK
res.writeHead(200, { 'Content-Type': 'video/mp4' });
stream.pipe(res, { end: true });
3. Build Konfiguráció (package.json)

Hogy az .exe készítésekor az electron-builder tudja, hogy az FFmpeget ne csomagolja be a titkosított fájlba, hanem hagyja mellette (hogy futtatható legyen), add hozzá ezt a package.json-hoz:

JSON
"build": {
  "asarUnpack": [
    "**/node_modules/ffmpeg-static/**"
  ]
}
Ennyi. Ezzel a 3 lépéssel megoldottad, hogy bármilyen MKV/AC3 filmet lejátsszon az appod, minimális CPU használattal.