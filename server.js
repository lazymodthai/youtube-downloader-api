const express = require("express");
const ytdl = require("@distube/ytdl-core");
const { exec } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const execPromise = promisify(exec);
const app = express();
const PORT = 4000;

// Middleware
app.use(cors());
app.use(express.json());

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 นาที
  max: 10, // จำกัด 10 requests ต่อ 15 นาที
  message: { error: "คำขอมากเกินไป กรุณาลองใหม่ในภายหลัง" },
});

app.use("/video-info", limiter);
app.use("/download", limiter);

// สร้างโฟลเดอร์สำหรับเก็บไฟล์ชั่วคราว
const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// ฟังก์ชันทำความสะอาดชื่อไฟล์
function sanitizeFilename(filename) {
  return (
    filename
      .replace(/[^\x00-\x7F]/g, "") // ลบอักขระที่ไม่ใช่ ASCII
      .replace(/[<>:"/\\|?*]/g, "") // ลบอักขระที่ห้ามใช้
      .replace(/\s+/g, "_")
      .trim()
      .substring(0, 100) || "video"
  );
}

// ฟังก์ชันตรวจสอบว่ามี yt-dlp หรือไม่
async function checkYtDlp() {
  try {
    await execPromise("yt-dlp --version");
    return true;
  } catch {
    return false;
  }
}

// Endpoint สำหรับดึงข้อมูลวิดีโอ
app.post("/video-info", async (req, res) => {
  const { videoLink } = req.body;

  if (!videoLink) {
    return res.status(400).json({ error: "กรุณาระบุลิงก์วิดีโอ" });
  }

  try {
    // ลองใช้ ytdl-core ก่อน
    if (ytdl.validateURL(videoLink)) {
      try {
        const info = await ytdl.getInfo(videoLink);
        const thumbnails = info.videoDetails.thumbnails;

        return res.json({
          title: info.videoDetails.title,
          author: info.videoDetails.author.name,
          lengthSeconds: parseInt(info.videoDetails.lengthSeconds),
          viewCount: parseInt(info.videoDetails.viewCount),
          thumbnailUrl: thumbnails[thumbnails.length - 1].url,
        });
      } catch (ytdlError) {
        console.log("ytdl-core failed, trying yt-dlp:", ytdlError.message);
      }
    }

    // ถ้า ytdl-core ไม่ได้ ให้ลอง yt-dlp
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) {
      return res.status(500).json({
        error: "ไม่สามารถดึงข้อมูลวิดีโอได้",
        details: "กรุณาติดตั้ง yt-dlp: pip install yt-dlp",
      });
    }

    const { stdout } = await execPromise(
      `yt-dlp --no-warnings --extractor-args "youtube:player_client=android,web" --dump-json "${videoLink}"`
    );

    const info = JSON.parse(stdout);

    res.json({
      title: info.title,
      author: info.uploader || info.channel,
      lengthSeconds: info.duration,
      viewCount: info.view_count || 0,
      thumbnailUrl: info.thumbnail,
    });
  } catch (error) {
    console.error("Error fetching video info:", error);
    res.status(500).json({
      error: "ไม่สามารถดึงข้อมูลวิดีโอได้",
      details: error.message,
    });
  }
});

// Endpoint สำหรับดาวน์โหลดด้วย yt-dlp (แนะนำ)
app.get("/download", async (req, res) => {
  const { videoLink, format = "video" } = req.query;

  if (!videoLink) {
    return res.status(400).json({ error: "กรุณาระบุลิงก์วิดีโอ" });
  }

  const hasYtDlp = await checkYtDlp();
  if (!hasYtDlp) {
    return res.status(500).json({
      error: "ต้องการ yt-dlp",
      details: "กรุณาติดตั้ง: pip install yt-dlp หรือ brew install yt-dlp",
    });
  }

  try {
    // ดึงข้อมูลวิดีโอเพื่อเอาชื่อ
    const { stdout: infoJson } = await execPromise(
      `yt-dlp --no-warnings --extractor-args "youtube:player_client=android,web" --dump-json "${videoLink}"`
    );
    const info = JSON.parse(infoJson);
    const title = sanitizeFilename(info.title);

    // สร้างชื่อไฟล์ชั่วคราว
    const timestamp = Date.now();
    const outputPath = path.join(tempDir, `${timestamp}_${title}`);

    if (format === "audio") {
      // ดาวน์โหลดเฉพาะเสียง
      const audioFile = `${outputPath}.mp3`;

      await execPromise(
        `yt-dlp --no-warnings --extractor-args "youtube:player_client=android,web" -x --audio-format mp3 --audio-quality 128K -o "${audioFile}" "${videoLink}"`
      );

      const encodedFilename = encodeURIComponent(`${title}.mp3`);
      res.header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodedFilename}`
      );
      res.header("Content-Type", "audio/mpeg");

      const fileStream = fs.createReadStream(audioFile);
      fileStream.pipe(res);

      fileStream.on("end", () => {
        fs.unlinkSync(audioFile);
      });

      fileStream.on("error", (error) => {
        console.error("Stream error:", error);
        if (fs.existsSync(audioFile)) {
          fs.unlinkSync(audioFile);
        }
      });
    } else {
      // ดาวน์โหลดวิดีโอ + เสียง
      const videoFile = `${outputPath}.mp4`;

      await execPromise(
        `yt-dlp --no-warnings --extractor-args "youtube:player_client=android,web" -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${videoFile}" "${videoLink}"`
      );

      const encodedFilename = encodeURIComponent(`${title}.mp4`);
      res.header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodedFilename}`
      );
      res.header("Content-Type", "video/mp4");

      const fileStream = fs.createReadStream(videoFile);
      fileStream.pipe(res);

      fileStream.on("end", () => {
        fs.unlinkSync(videoFile);
      });

      fileStream.on("error", (error) => {
        console.error("Stream error:", error);
        if (fs.existsSync(videoFile)) {
          fs.unlinkSync(videoFile);
        }
      });
    }
  } catch (error) {
    console.error("Download error:", error);
    res.status(500).json({
      error: "เกิดข้อผิดพลาดในการดาวน์โหลด",
      details: error.message,
    });
  }
});

// Endpoint สำหรับดาวน์โหลดแบบเร็ว
app.get("/download-fast", async (req, res) => {
  const { videoLink } = req.query;

  if (!videoLink) {
    return res.status(400).json({ error: "กรุณาระบุลิงก์วิดีโอ" });
  }

  const hasYtDlp = await checkYtDlp();
  if (!hasYtDlp) {
    return res.status(500).json({
      error: "ต้องการ yt-dlp",
      details: "กรุณาติดตั้ง: pip install yt-dlp",
    });
  }

  try {
    const { stdout: infoJson } = await execPromise(
      `yt-dlp --no-warnings --extractor-args "youtube:player_client=android,web" --dump-json "${videoLink}"`
    );
    const info = JSON.parse(infoJson);
    const title = sanitizeFilename(info.title);

    const timestamp = Date.now();
    const videoFile = path.join(tempDir, `${timestamp}_${title}.mp4`);

    // ดาวน์โหลดแบบเร็ว (คุณภาพปานกลาง)
    await execPromise(
      `yt-dlp --no-warnings --extractor-args "youtube:player_client=android,web" -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best" --merge-output-format mp4 -o "${videoFile}" "${videoLink}"`
    );

    const encodedFilename = encodeURIComponent(`${title}.mp4`);
    res.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodedFilename}`
    );
    res.header("Content-Type", "video/mp4");

    const fileStream = fs.createReadStream(videoFile);
    fileStream.pipe(res);

    fileStream.on("end", () => {
      fs.unlinkSync(videoFile);
    });

    fileStream.on("error", (error) => {
      console.error("Stream error:", error);
      if (fs.existsSync(videoFile)) {
        fs.unlinkSync(videoFile);
      }
    });
  } catch (error) {
    console.error("Fast download error:", error);
    res.status(500).json({
      error: "เกิดข้อผิดพลาดในการดาวน์โหลด",
      details: error.message,
    });
  }
});

// ทำความสะอาดไฟล์เก่าทุก 1 ชั่วโมง
setInterval(() => {
  const files = fs.readdirSync(tempDir);
  const now = Date.now();

  files.forEach((file) => {
    const filePath = path.join(tempDir, file);
    const stats = fs.statSync(filePath);
    const fileAge = now - stats.mtimeMs;

    // ลบไฟล์ที่เก่ากว่า 1 ชั่วโมง
    if (fileAge > 3600000) {
      fs.unlinkSync(filePath);
      console.log(`Cleaned up old file: ${file}`);
    }
  });
}, 3600000);

// Health check endpoint
app.get("/health", async (req, res) => {
  const hasYtDlp = await checkYtDlp();
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    ytdlp: hasYtDlp ? "installed" : "not found",
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์",
    details: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "ไม่พบ endpoint ที่ร้องขอ" });
});

app.listen(PORT, async () => {
  console.log(`✅ Backend server is running on http://localhost:${PORT}`);
  console.log(`📋 Endpoints:`);
  console.log(`   POST /video-info - ดึงข้อมูลวิดีโอ`);
  console.log(`   GET  /download?videoLink=URL&format=video|audio - ดาวน์โหลด`);
  console.log(`   GET  /download-fast?videoLink=URL - ดาวน์โหลดแบบเร็ว`);
  console.log(`   GET  /health - ตรวจสอบสถานะเซิร์ฟเวอร์`);

  const hasYtDlp = await checkYtDlp();
  if (!hasYtDlp) {
    console.log(`\n⚠️  WARNING: yt-dlp not found!`);
    console.log(`   Install with: pip install yt-dlp`);
    console.log(`   Or on Mac: brew install yt-dlp`);
  } else {
    console.log(`\n✅ yt-dlp is installed`);
  }
});
