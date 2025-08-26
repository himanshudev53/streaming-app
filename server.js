const express = require("express");
const NodeMediaServer = require("node-media-server");
const path = require("path");
const fs = require("fs");
const { execSync, spawn } = require("child_process");
const cors = require("cors");
const ffmpegStatic = require("ffmpeg-static");
const os = require("os");

console.log("🔧 Setting up environment...");

let ffmpegPath = "ffmpeg"; // Default to system ffmpeg

// Check if we're in a production environment (like Render)
const isProduction =
  process.env.NODE_ENV === "production" || process.env.RENDER;

if (isProduction) {
  console.log("🏭 Production environment detected");

  // Try to use system ffmpeg first in production
  try {
    execSync("which ffmpeg || where ffmpeg", { encoding: "utf-8" });
    console.log("✅ Using system FFmpeg");
    ffmpegPath = "ffmpeg";
  } catch (systemError) {
    console.log("⚠️ System FFmpeg not found, trying ffmpeg-static...");

    // Try ffmpeg-static as fallback
    try {
      if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
        // Make the binary executable (important for Linux environments)
        try {
          fs.chmodSync(ffmpegStatic, 0o755);
          console.log("✅ Made ffmpeg-static binary executable");
        } catch (chmodError) {
          console.warn(
            "⚠️ Could not set executable permissions:",
            chmodError.message
          );
        }

        // Test if the binary works
        execSync(`"${ffmpegStatic}" -version`, { encoding: "utf-8" });
        ffmpegPath = ffmpegStatic;
        console.log("✅ Using ffmpeg-static:", ffmpegPath);
      } else {
        throw new Error("ffmpeg-static path not valid");
      }
    } catch (staticError) {
      console.error("❌ ffmpeg-static also failed:", staticError.message);
      console.log("🔍 Attempting to install ffmpeg via apt-get...");

      // Try to install ffmpeg on Linux systems
      try {
        execSync("apt-get update && apt-get install -y ffmpeg", {
          encoding: "utf-8",
          stdio: "inherit",
        });
        ffmpegPath = "ffmpeg";
        console.log("✅ Installed system FFmpeg successfully");
      } catch (installError) {
        console.error(
          "❌ Failed to install FFmpeg. Please ensure FFmpeg is available:"
        );
        console.error("   On Render: Add FFmpeg in your build command");
        console.error(
          "   Alternatively: Use a Docker image with FFmpeg pre-installed"
        );
        process.exit(1);
      }
    }
  }
} else {
  // Development environment - prefer ffmpeg-static
  try {
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      // Make executable in development too
      try {
        fs.chmodSync(ffmpegStatic, 0o755);
      } catch (e) {
        /* ignore */
      }

      execSync(`"${ffmpegStatic}" -version`, { encoding: "utf-8" });
      ffmpegPath = ffmpegStatic;
      console.log("✅ Using ffmpeg-static in development:", ffmpegPath);
    } else {
      throw new Error("ffmpeg-static not available");
    }
  } catch (error) {
    console.log("⚠️ ffmpeg-static failed, falling back to system FFmpeg");
    try {
      execSync("which ffmpeg || where ffmpeg", { encoding: "utf-8" });
      ffmpegPath = "ffmpeg";
      console.log("✅ Using system FFmpeg");
    } catch (systemError) {
      console.error("❌ No FFmpeg found. Please install FFmpeg:");
      console.error("   macOS: brew install ffmpeg");
      console.error("   Ubuntu: sudo apt install ffmpeg");
      console.error("   Windows: Download from ffmpeg.org");
      process.exit(1);
    }
  }
}

// Final test
try {
  const version = execSync(`"${ffmpegPath}" -version`, {
    encoding: "utf-8",
  }).split("\n")[0];
  console.log("✅ FFmpeg verified:", version);
} catch (finalError) {
  console.error("❌ FFmpeg final verification failed:", finalError.message);
  process.exit(1);
}

const mediaRoot = path.resolve(__dirname, "media");
const publicRoot = path.resolve(__dirname, "public");

console.log("📁 Media Root:", mediaRoot);
console.log("🌐 Public Root:", publicRoot);

// Ensure directories exist
const setupDirectory = (dir) => {
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn("⚠️ Could not remove directory:", err.message);
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
  } catch (err) {
    console.warn("⚠️ Could not set directory permissions:", err.message);
  }
};

// Create necessary directories
setupDirectory(mediaRoot);
setupDirectory(publicRoot);
setupDirectory(path.join(mediaRoot, "live"));

const config = {
  rtmp: {
    port: process.env.RTMP_PORT || 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 10,
    ping_timeout: 60,
  },
  http: {
    port: process.env.HTTP_PORT || 8000,
    mediaroot: mediaRoot,
    allow_origin: "*",
    webroot: publicRoot,
    api: true,
  },
};

console.log("NMS Config:", config);

const nms = new NodeMediaServer(config);
const activeStreams = {};

// NMS event handlers
nms.on("preConnect", (id, args) => {
  console.log(`\n🔌 New connection from ${args.ip}`);
});

nms.on("postConnect", (id, args) => {
  console.log(`✅ Client connected: ${id}`);
});

nms.on("prePublish", (data) => {
  const streamKey = data.streamPath.split("/")[2];
  console.log(`\n🎬 Stream starting: ${streamKey}`);
  console.log(
    `📹 RTMP: rtmp://localhost:${config.rtmp.port}/live/${streamKey}`
  );
  console.log(
    `📺 HLS: http://localhost:${config.http.port}/live/${streamKey}/index.m3u8`
  );

  const streamDir = path.join(mediaRoot, "live", streamKey);
  setupDirectory(streamDir);
});

nms.on("postPublish", (data) => {
  const streamKey = data.streamPath.split("/")[2];
  const outputPath = path.join(mediaRoot, "live", streamKey, "index.m3u8");

  console.log(`\n🔍 Starting FFmpeg for ${streamKey}`);
  console.log(`📂 Output: ${outputPath}`);
  console.log(`🔧 Using FFmpeg at: ${ffmpegPath}`);

  const ffmpegArgs = [
    "-i",
    `rtmp://localhost:${config.rtmp.port}/live/${streamKey}`,
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
    "0",
    "-hls_flags",
    "program_date_time",
    "-hls_segment_filename",
    path.join(mediaRoot, "live", streamKey, "segment_%03d.ts"),
    outputPath,
  ];

  console.log("FFmpeg command:", ffmpegPath, ffmpegArgs.join(" "));

  try {
    activeStreams[data.id] = spawn(ffmpegPath, ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeStreams[data.id].stdout.on("data", (data) => {
      console.log(`FFMPEG OUT: ${data.toString().trim()}`);
    });

    activeStreams[data.id].stderr.on("data", (data) => {
      const str = data.toString();
      if (str.match(/error|fail|missing/i)) {
        console.error(`FFMPEG ERR: ${str.trim()}`);
      } else if (str.match(/frame|fps|bitrate/)) {
        console.log(`FFMPEG: ${str.trim()}`);
      }
    });

    activeStreams[data.id].on("error", (err) => {
      console.error("FFMPEG PROCESS ERROR:", err);
    });

    activeStreams[data.id].on("close", (code) => {
      console.log(`FFMPEG exited with code ${code}`);
      delete activeStreams[data.id];
    });
  } catch (spawnError) {
    console.error("Failed to spawn FFmpeg:", spawnError);
  }

  const checkFiles = () => {
    if (fs.existsSync(outputPath)) {
      const files = fs.readdirSync(path.dirname(outputPath));
      console.log("✅ HLS files created:", files.join(", "));
    } else {
      setTimeout(checkFiles, 1000);
    }
  };
  checkFiles();
});

nms.on("donePublish", (req) => {
  const streamKey = req.streamPath.split("/")[2];
  console.log(`\n⏹️ Stream ending: ${streamKey}`);
  if (activeStreams[req.id]) {
    activeStreams[req.id].kill();
    delete activeStreams[req.id];
  }
});

// Express setup
const app = express();
const webPort = process.env.PORT || 3000;

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.static(publicRoot));

app.use(
  "/live",
  express.static(path.join(mediaRoot, "live"), {
    setHeaders: (res, path) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "no-cache");
      if (path.endsWith(".m3u8")) {
        res.set("Content-Type", "application/vnd.apple.mpegurl");
      }
      if (path.endsWith(".ts")) {
        res.set("Content-Type", "video/MP2T");
      }
    },
  })
);

// API routes
app.get("/api/streams", (req, res) => {
  const streams = [];
  const liveDir = path.join(mediaRoot, "live");

  if (fs.existsSync(liveDir)) {
    const streamDirs = fs.readdirSync(liveDir);
    streamDirs.forEach((stream) => {
      const m3u8Path = path.join(liveDir, stream, "index.m3u8");
      if (fs.existsSync(m3u8Path)) {
        streams.push({
          name: stream,
          url: `/live/${stream}/index.m3u8`,
          rtmp: `rtmp://${req.hostname}:${config.rtmp.port}/live/${stream}`,
          hls_url: `http://${req.hostname}:${config.http.port}/live/${stream}/index.m3u8`,
        });
      }
    });
  }
  res.json(streams);
});
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
    ffmpeg: ffmpegPath,
    platform: os.platform(),
  });
});

// Start servers
nms.run();
app.listen(webPort, () => {
  console.log("\n🚀 Servers are running!");
  console.log(`👉 RTMP Server: rtmp://localhost:${config.rtmp.port}/live`);
  console.log(`👉 HLS Server: http://localhost:${config.http.port}`);
  console.log(`👉 Web Interface: http://localhost:${webPort}`);
  console.log(`🔧 Using FFmpeg: ${ffmpegPath}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  Object.values(activeStreams).forEach((process) => process.kill());
  process.exit(0);
});
