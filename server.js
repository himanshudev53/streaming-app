const express = require("express");
const NodeMediaServer = require("node-media-server");
const path = require("path");
const fs = require("fs");
const { execSync, spawn } = require("child_process");
const cors = require("cors");
const ffmpegStatic = require("ffmpeg-static");

console.log("🔧 Setting up environment...");

// Use ffmpeg-static's path
const ffmpegPath = ffmpegStatic;
console.log("✅ FFmpeg found at:", ffmpegPath);

// Test if the FFmpeg binary works
try {
  execSync(`"${ffmpegPath}" -version`, { encoding: "utf-8" });
  console.log("✅ FFmpeg is working correctly");
} catch (e) {
  console.error("❌ FFmpeg binary is not executable:", e.message);
  process.exit(1);
}

const mediaRoot = path.resolve(__dirname, "media");
const publicRoot = path.resolve(__dirname, "public");

console.log("📁 Media Root:", mediaRoot);
console.log("🌐 Public Root:", publicRoot);

const setupDirectory = (dir) => {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o777);
  } catch (err) {
    console.warn("⚠️ Could not set permissions:", err.message);
  }
};

const config = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 10,
    ping_timeout: 60,
  },
  http: {
    port: 8000,
    mediaroot: mediaRoot,
    allow_origin: "*",
    webroot: publicRoot,
    api: true,
  },
};

console.log("NMS Config:", config);

const nms = new NodeMediaServer(config);

const activeStreams = {};

nms.on("preConnect", (id, args) => {
  console.log(`\n🔌 New connection from ${args.ip}`);
});

nms.on("postConnect", (id, args) => {
  console.log(`✅ Client connected: ${id}`);
});

nms.on("prePublish", (data) => {
  const streamKey = data.streamPath.split("/")[2];
  console.log(`\n🎬 Stream starting: ${streamKey}`);
  console.log(`📹 RTMP: rtmp://localhost:1935/live/${streamKey}`);
  console.log(`📺 HLS: http://localhost:8000/live/${streamKey}/index.m3u8`);

  const streamDir = path.join(mediaRoot, "live", streamKey);
  setupDirectory(streamDir);
});

nms.on("postPublish", (data) => {
  const streamKey = data.streamPath.split("/")[2];
  const outputPath = path.join(mediaRoot, "live", streamKey, "index.m3u8");

  console.log(`\n🔍 Starting FFmpeg for ${streamKey}`);
  console.log(`📂 Output: ${outputPath}`);

  const ffmpegArgs = [
    "-i",
    `rtmp://localhost:1935/live/${streamKey}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "2",
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_list_size",
    "0", // 0 = keep all segments in playlist
    "-hls_flags",
    "program_date_time", // keep timestamp metadata, no deletion
    "-hls_segment_filename",
    path.join(mediaRoot, "live", streamKey, "segment_%03d.ts"),
    path.join(mediaRoot, "live", streamKey, "index.m3u8"),
  ];

  // Use ffmpeg-static path instead of system FFmpeg
  activeStreams[data.id] = spawn(ffmpegPath, ffmpegArgs);

  activeStreams[data.id].stdout.on("data", (data) => {
    console.log(`FFMPEG: ${data}`);
  });

  activeStreams[data.id].stderr.on("data", (data) => {
    const str = data.toString();
    if (str.match(/error|fail/i)) {
      console.error(`FFMPEG ERR: ${str}`);
    }
  });

  activeStreams[data.id].on("error", (err) => {
    console.error("FFMPEG PROCESS ERROR:", err);
  });

  activeStreams[data.id].on("close", (code) => {
    console.log(`FFMPEG exited with code ${code}`);
    delete activeStreams[data.id];
  });

  const checkFiles = () => {
    try {
      if (fs.existsSync(outputPath)) {
        const files = fs.readdirSync(path.dirname(outputPath));
        console.log("✅ HLS files created:", files.join(", "));
      } else {
        setTimeout(checkFiles, 1000);
      }
    } catch (err) {
      console.error("Error checking files:", err);
    }
  };
  checkFiles();
});

nms.on("donePublish", (req) => {
  console.log(`\n⏹️ Stream ending: ${req.streamPath.split("/")[2]}`);
  if (activeStreams[req.id]) {
    activeStreams[req.id].kill();
    delete activeStreams[req.id];
  }
});

nms.on("donePlay", (req) => {
  console.log(`[NMS] File served: ${req.streamPath}`);
});

nms.on("prePlay", (req) => {
  console.log(`[NMS] Request for: ${req.streamPath}`);
});

const app = express();
const webPort = 3000;

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    exposedHeaders: [
      "Access-Control-Allow-Origin",
      "Access-Control-Allow-Credentials",
    ],
  })
);

app.use(express.static(publicRoot));

app.use(
  "/live",
  express.static(path.join(__dirname, "media", "live"), {
    setHeaders: (res, path) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "no-cache");
      res.set("Access-Control-Expose-Headers", "*");
      if (path.endsWith(".m3u8")) {
        res.set("Content-Type", "application/vnd.apple.mpegurl");
      }
      if (path.endsWith(".ts")) {
        res.set("Content-Type", "video/MP2T");
      }
    },
  })
);

app.get("/api/streams", (req, res) => {
  const streams = [];
  const liveDir = path.join(mediaRoot, "live");

  if (fs.existsSync(liveDir)) {
    const streamDirs = fs.readdirSync(liveDir);
    streamDirs.forEach((stream) => {
      if (fs.existsSync(path.join(liveDir, stream, "index.m3u8"))) {
        streams.push({
          name: stream,
          url: `/live/${stream}/index.m3u8`,
          rtmp: `rtmp://localhost:1935/live/${stream}`,
          embed_url: `${req.protocol}://${req.get("host")}/embed/${stream}`,
          hls_url: `${req.protocol}://${req.get(
            "host"
          )}/live/${stream}/index.m3u8`,
          iframe_embed: `<iframe src="${req.protocol}://${req.get(
            "host"
          )}/embed/${stream}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`,
        });
      }
    });
  }
  res.json(streams);
});

app.get("/embed/:streamKey", (req, res) => {
  const streamKey = req.params.streamKey;
  const streamPath = path.join(mediaRoot, "live", streamKey, "index.m3u8");

  if (fs.existsSync(streamPath)) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${streamKey} - Live Stream</title>
        <script src="https://cdn.jsdelivr.net/npm/hls.js@1.0.0/dist/hls.min.js"></script>
        <style>
          body, html { margin: 0; padding: 0; background: #000; }
          #videoPlayer { width: 100%; height: 100vh; }
        </style>
      </head>
      <body>
        <video id="videoPlayer" controls autoplay></video>
        <script>
          const video = document.getElementById('videoPlayer');
          const streamUrl = '/live/${streamKey}/index.m3u8';
          
          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = streamUrl;
          } else if (Hls.isSupported()) {
            const hls = new Hls();
            hls.loadSource(streamUrl);
            hls.attachMedia(video);
          }
        </script>
      </body>
      </html>
    `);
  } else {
    res.status(404).send("Stream not found");
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    server: "Live Streaming Server",
    version: "1.0.0",
  });
});

nms.run();
app.listen(webPort, () => {
  console.log("\n🚀 Servers are running!");
  console.log("👉 RTMP Server: rtmp://localhost:1935/live");
  console.log("👉 HLS Server: http://localhost:8000");
  console.log(`👉 Web Interface: http://localhost:${webPort}`);
  console.log("\n📋 Third-party integration URLs:");
  console.log("   Streams API: http://localhost:3000/api/streams");
  console.log("   Embed Player: http://localhost:3000/embed/[stream_key]");
  console.log("   Health Check: http://localhost:3000/api/health");
});
