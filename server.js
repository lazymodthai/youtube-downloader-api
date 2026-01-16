require("dotenv").config();
const express = require("express");
const ytdl = require("@distube/ytdl-core");
const { exec } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { GoogleGenAI } = require("@google/genai");
const { Pool } = require("pg");

const execPromise = promisify(exec);
const app = express();
const PORT = 4000;

// Initialize Gemini AI
const genai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;
const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";

// Initialize PostgreSQL connection pool
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

// Database helper functions
async function logUsage(data) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      `INSERT INTO usage_logs (endpoint, video_url, video_title, video_author, video_duration, format, status, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        data.endpoint,
        data.videoUrl || null,
        data.videoTitle || null,
        data.videoAuthor || null,
        data.videoDuration || null,
        data.format || null,
        data.status || "pending",
        data.ipAddress || null,
        data.userAgent || null,
      ]
    );
    return result.rows[0].id;
  } catch (error) {
    console.error("Error logging usage:", error.message);
    return null;
  }
}

async function updateUsageLog(id, data) {
  if (!pool || !id) return;
  try {
    await pool.query(
      `UPDATE usage_logs 
       SET status = $1, 
           error_message = $2, 
           processing_time_ms = $3, 
           video_title = COALESCE($4, video_title),
           video_author = COALESCE($5, video_author),
           video_duration = COALESCE($6, video_duration),
           completed_at = CURRENT_TIMESTAMP
       WHERE id = $7`,
      [
        data.status,
        data.errorMessage || null,
        data.processingTimeMs || null,
        data.videoTitle || null,
        data.videoAuthor || null,
        data.videoDuration || null,
        id,
      ]
    );
  } catch (error) {
    console.error("Error updating usage log:", error.message);
  }
}

async function saveSummaryResult(logId, data) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO summary_results (
        usage_log_id, 
        video_url, 
        video_title, 
        conclusion, 
        market_highlights, 
        papers, 
        transcript_length,
        transcript_source,
        raw_result
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        logId,
        data.videoUrl,
        data.videoTitle,
        data.conclusion,
        JSON.stringify(data.marketHighlights || []),
        JSON.stringify(data.papers || []),
        data.transcriptLength,
        data.transcriptSource,
        JSON.stringify(data.rawResult || {}),
      ]
    );
  } catch (error) {
    console.error("Error saving summary result:", error.message);
  }
}

// Swagger configuration
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "YouTube Downloader API",
      version: "1.0.0",
      description: "API สำหรับดาวน์โหลดและสรุปวิดีโอจาก YouTube",
      contact: {
        name: "API Support",
      },
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: "Development server",
      },
    ],
  },
  apis: ["./server.js"],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Middleware
app.use(cors());
app.use(express.json());

// Swagger UI
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

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

/**
 * @swagger
 * /video-info:
 *   post:
 *     summary: ดึงข้อมูลวิดีโอ
 *     description: ดึงข้อมูลเมตาดาต้าของวิดีโอ YouTube เช่น ชื่อ, ผู้สร้าง, ความยาว
 *     tags: [Video Info]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - videoLink
 *             properties:
 *               videoLink:
 *                 type: string
 *                 description: URL ของวิดีโอ YouTube
 *                 example: https://www.youtube.com/watch?v=dQw4w9WgXcQ
 *     responses:
 *       200:
 *         description: ข้อมูลวิดีโอ
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 title:
 *                   type: string
 *                 author:
 *                   type: string
 *                 lengthSeconds:
 *                   type: integer
 *                 viewCount:
 *                   type: integer
 *                 thumbnailUrl:
 *                   type: string
 *       400:
 *         description: ไม่ระบุลิงก์วิดีโอ
 *       500:
 *         description: เกิดข้อผิดพลาด
 */
app.post("/video-info", async (req, res) => {
  const { videoLink } = req.body;
  const startTime = Date.now();

  // Log usage
  const logId = await logUsage({
    endpoint: "video-info",
    videoUrl: videoLink,
    status: "pending",
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  if (!videoLink) {
    await updateUsageLog(logId, {
      status: "error",
      errorMessage: "ไม่ระบุลิงก์วิดีโอ",
    });
    return res.status(400).json({ error: "กรุณาระบุลิงก์วิดีโอ" });
  }

  try {
    // ลองใช้ ytdl-core ก่อน
    if (ytdl.validateURL(videoLink)) {
      try {
        const info = await ytdl.getInfo(videoLink);
        const thumbnails = info.videoDetails.thumbnails;

        await updateUsageLog(logId, {
          status: "success",
          videoTitle: info.videoDetails.title,
          videoAuthor: info.videoDetails.author.name,
          videoDuration: parseInt(info.videoDetails.lengthSeconds),
          processingTimeMs: Date.now() - startTime,
        });

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
      await updateUsageLog(logId, {
        status: "error",
        errorMessage: "yt-dlp not installed",
      });
      return res.status(500).json({
        error: "ไม่สามารถดึงข้อมูลวิดีโอได้",
        details: "กรุณาติดตั้ง yt-dlp: pip install yt-dlp",
      });
    }

    const { stdout } = await execPromise(
      `yt-dlp --no-warnings --extractor-args "youtube:player_client=android,web" --dump-json "${videoLink}"`
    );

    const info = JSON.parse(stdout);

    await updateUsageLog(logId, {
      status: "success",
      videoTitle: info.title,
      videoAuthor: info.uploader || info.channel,
      videoDuration: info.duration,
      processingTimeMs: Date.now() - startTime,
    });

    res.json({
      title: info.title,
      author: info.uploader || info.channel,
      lengthSeconds: info.duration,
      viewCount: info.view_count || 0,
      thumbnailUrl: info.thumbnail,
    });
  } catch (error) {
    console.error("Error fetching video info:", error);
    await updateUsageLog(logId, {
      status: "error",
      errorMessage: error.message,
      processingTimeMs: Date.now() - startTime,
    });
    res.status(500).json({
      error: "ไม่สามารถดึงข้อมูลวิดีโอได้",
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /download:
 *   get:
 *     summary: ดาวน์โหลดวิดีโอหรือเสียง
 *     description: ดาวน์โหลดวิดีโอ (MP4) หรือเสียง (MP3) จาก YouTube
 *     tags: [Download]
 *     parameters:
 *       - in: query
 *         name: videoLink
 *         required: true
 *         schema:
 *           type: string
 *         description: URL ของวิดีโอ YouTube
 *         example: https://www.youtube.com/watch?v=dQw4w9WgXcQ
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [video, audio]
 *           default: video
 *         description: รูปแบบไฟล์ที่ต้องการ (video = MP4, audio = MP3)
 *     responses:
 *       200:
 *         description: ไฟล์วิดีโอหรือเสียง
 *         content:
 *           video/mp4:
 *             schema:
 *               type: string
 *               format: binary
 *           audio/mpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: ไม่ระบุลิงก์วิดีโอ
 *       500:
 *         description: เกิดข้อผิดพลาด
 */
app.get("/download", async (req, res) => {
  const { videoLink, format = "video" } = req.query;
  const startTime = Date.now();

  // Log usage
  const logId = await logUsage({
    endpoint: "download",
    videoUrl: videoLink,
    format: format,
    status: "pending",
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  if (!videoLink) {
    await updateUsageLog(logId, {
      status: "error",
      errorMessage: "ไม่ระบุลิงก์วิดีโอ",
    });
    return res.status(400).json({ error: "กรุณาระบุลิงก์วิดีโอ" });
  }

  const hasYtDlp = await checkYtDlp();
  if (!hasYtDlp) {
    await updateUsageLog(logId, {
      status: "error",
      errorMessage: "yt-dlp not installed",
    });
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

    // อัปเดต log ด้วยข้อมูลวิดีโอ
    await updateUsageLog(logId, {
      status: "downloading",
      videoTitle: info.title,
      videoAuthor: info.uploader || info.channel,
      videoDuration: info.duration,
    });

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

      fileStream.on("end", async () => {
        fs.unlinkSync(audioFile);
        await updateUsageLog(logId, {
          status: "success",
          processingTimeMs: Date.now() - startTime,
        });
      });

      fileStream.on("error", async (error) => {
        console.error("Stream error:", error);
        if (fs.existsSync(audioFile)) {
          fs.unlinkSync(audioFile);
        }
        await updateUsageLog(logId, {
          status: "error",
          errorMessage: error.message,
          processingTimeMs: Date.now() - startTime,
        });
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

      fileStream.on("end", async () => {
        fs.unlinkSync(videoFile);
        await updateUsageLog(logId, {
          status: "success",
          processingTimeMs: Date.now() - startTime,
        });
      });

      fileStream.on("error", async (error) => {
        console.error("Stream error:", error);
        if (fs.existsSync(videoFile)) {
          fs.unlinkSync(videoFile);
        }
        await updateUsageLog(logId, {
          status: "error",
          errorMessage: error.message,
          processingTimeMs: Date.now() - startTime,
        });
      });
    }
  } catch (error) {
    console.error("Download error:", error);
    await updateUsageLog(logId, {
      status: "error",
      errorMessage: error.message,
      processingTimeMs: Date.now() - startTime,
    });
    res.status(500).json({
      error: "เกิดข้อผิดพลาดในการดาวน์โหลด",
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /download-fast:
 *   get:
 *     summary: ดาวน์โหลดวิดีโอแบบเร็ว
 *     description: ดาวน์โหลดวิดีโอจาก YouTube ด้วยคุณภาพปานกลาง (720p) เพื่อความรวดเร็ว
 *     tags: [Download]
 *     parameters:
 *       - in: query
 *         name: videoLink
 *         required: true
 *         schema:
 *           type: string
 *         description: URL ของวิดีโอ YouTube
 *         example: https://www.youtube.com/watch?v=dQw4w9WgXcQ
 *     responses:
 *       200:
 *         description: ไฟล์วิดีโอ MP4
 *         content:
 *           video/mp4:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: ไม่ระบุลิงก์วิดีโอ
 *       500:
 *         description: เกิดข้อผิดพลาด
 */
app.get("/download-fast", async (req, res) => {
  const { videoLink } = req.query;
  const startTime = Date.now();

  // Log usage
  const logId = await logUsage({
    endpoint: "download-fast",
    videoUrl: videoLink,
    format: "video-fast",
    status: "pending",
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  if (!videoLink) {
    await updateUsageLog(logId, {
      status: "error",
      errorMessage: "ไม่ระบุลิงก์วิดีโอ",
    });
    return res.status(400).json({ error: "กรุณาระบุลิงก์วิดีโอ" });
  }

  const hasYtDlp = await checkYtDlp();
  if (!hasYtDlp) {
    await updateUsageLog(logId, {
      status: "error",
      errorMessage: "yt-dlp not installed",
    });
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

    // อัปเดต log ด้วยข้อมูลวิดีโอ
    await updateUsageLog(logId, {
      status: "downloading",
      videoTitle: info.title,
      videoAuthor: info.uploader || info.channel,
      videoDuration: info.duration,
    });

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

    fileStream.on("end", async () => {
      fs.unlinkSync(videoFile);
      await updateUsageLog(logId, {
        status: "success",
        processingTimeMs: Date.now() - startTime,
      });
    });

    fileStream.on("error", async (error) => {
      console.error("Stream error:", error);
      if (fs.existsSync(videoFile)) {
        fs.unlinkSync(videoFile);
      }
      await updateUsageLog(logId, {
        status: "error",
        errorMessage: error.message,
        processingTimeMs: Date.now() - startTime,
      });
    });
  } catch (error) {
    console.error("Fast download error:", error);
    await updateUsageLog(logId, {
      status: "error",
      errorMessage: error.message,
      processingTimeMs: Date.now() - startTime,
    });
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

/**
 * @swagger
 * /summarize:
 *   post:
 *     summary: สรุปเนื้อหาวิดีโอด้วย AI
 *     description: ดาวน์โหลด audio จากวิดีโอ, transcribe ด้วย Whisper และสรุปด้วย Google Gemini AI
 *     tags: [AI Summary]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - videoLink
 *             properties:
 *               videoLink:
 *                 type: string
 *                 description: URL ของวิดีโอ YouTube
 *                 example: https://www.youtube.com/watch?v=dQw4w9WgXcQ
 *     responses:
 *       200:
 *         description: ผลสรุปวิดีโอ
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 title:
 *                   type: string
 *                   description: ชื่อวิดีโอ
 *                 author:
 *                   type: string
 *                   description: ชื่อช่อง/ผู้สร้าง
 *                 duration:
 *                   type: integer
 *                   description: ความยาววิดีโอ (วินาที)
 *                 summary:
 *                   type: string
 *                   description: สรุปเนื้อหาแบบ paragraph
 *                 keyPoints:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: ประเด็นสำคัญแบบ bullet points
 *                 transcriptLength:
 *                   type: integer
 *                   description: จำนวนตัวอักษรของ transcript
 *       400:
 *         description: ไม่ระบุลิงก์วิดีโอ
 *       500:
 *         description: เกิดข้อผิดพลาด
 */
app.post("/summarize", async (req, res) => {
  const { videoLink } = req.body;
  const startTime = Date.now();

  // Log usage
  const logId = await logUsage({
    endpoint: "summarize",
    videoUrl: videoLink,
    status: "pending",
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  if (!videoLink) {
    await updateUsageLog(logId, {
      status: "error",
      errorMessage: "ไม่ระบุลิงก์วิดีโอ",
    });
    return res.status(400).json({ error: "กรุณาระบุลิงก์วิดีโอ" });
  }

  if (!genai) {
    await updateUsageLog(logId, {
      status: "error",
      errorMessage: "GEMINI_API_KEY not configured",
    });
    return res.status(500).json({
      error: "ไม่ได้ตั้งค่า GEMINI_API_KEY",
      details: "กรุณาตั้งค่า GEMINI_API_KEY ใน environment variables",
    });
  }

  const hasYtDlp = await checkYtDlp();
  if (!hasYtDlp) {
    await updateUsageLog(logId, {
      status: "error",
      errorMessage: "yt-dlp not installed",
    });
    return res.status(500).json({
      error: "ต้องการ yt-dlp",
      details: "กรุณาติดตั้ง: pip install yt-dlp",
    });
  }

  try {
    // 1. ดึงข้อมูลวิดีโอ
    console.log("[Summarize] Fetching video info...");
    const { stdout: infoJson } = await execPromise(
      `yt-dlp --no-warnings --extractor-args "youtube:player_client=android,web" --dump-json "${videoLink}"`
    );
    const info = JSON.parse(infoJson);
    const title = info.title;
    const sanitizedTitle = sanitizeFilename(title);

    // อัปเดต log ด้วยข้อมูลวิดีโอ
    await updateUsageLog(logId, {
      status: "processing",
      videoTitle: info.title,
      videoAuthor: info.uploader || info.channel,
      videoDuration: info.duration,
    });

    const timestamp = Date.now();
    let transcript = "";
    let transcriptSource = "whisper"; // "subtitle" or "whisper"

    // 2. ตรวจสอบว่ามี subtitles หรือไม่
    console.log("[Summarize] Checking for subtitles...");
    const availableSubtitles = info.subtitles || {};
    const availableAutoCaptions = info.automatic_captions || {};

    // ลำดับความสำคัญของภาษา (th > en > อื่นๆ)
    const preferredLangs = ["th", "en", "th-TH", "en-US", "en-GB"];
    let subtitleLang = null;
    let useAutoCaptions = false;

    // ตรวจสอบ manual subtitles ก่อน
    for (const lang of preferredLangs) {
      if (availableSubtitles[lang]) {
        subtitleLang = lang;
        break;
      }
    }

    // ถ้าไม่มี manual subtitles ให้ใช้ auto-generated captions
    if (!subtitleLang) {
      for (const lang of preferredLangs) {
        if (availableAutoCaptions[lang]) {
          subtitleLang = lang;
          useAutoCaptions = true;
          break;
        }
      }
    }

    // ถ้าไม่มีภาษาที่ต้องการ ให้ใช้ภาษาแรกที่มี
    if (!subtitleLang) {
      const allLangs = Object.keys(availableSubtitles);
      if (allLangs.length > 0) {
        subtitleLang = allLangs[0];
      } else {
        const autoLangs = Object.keys(availableAutoCaptions);
        if (autoLangs.length > 0) {
          subtitleLang = autoLangs[0];
          useAutoCaptions = true;
        }
      }
    }

    if (subtitleLang) {
      // มี subtitles ให้ดาวน์โหลด
      console.log(
        `[Summarize] Found ${
          useAutoCaptions ? "auto-captions" : "subtitles"
        } in: ${subtitleLang}`
      );
      const subtitleFile = path.join(
        tempDir,
        `${timestamp}_${sanitizedTitle}.${subtitleLang}.vtt`
      );

      try {
        const subFlag = useAutoCaptions ? "--write-auto-sub" : "--write-sub";
        await execPromise(
          `yt-dlp --no-warnings --extractor-args "youtube:player_client=android,web" ${subFlag} --sub-lang "${subtitleLang}" --sub-format vtt --skip-download -o "${path.join(
            tempDir,
            `${timestamp}_${sanitizedTitle}`
          )}" "${videoLink}"`,
          { maxBuffer: 50 * 1024 * 1024 }
        );

        // หาไฟล์ subtitle ที่ดาวน์โหลดมา
        const files = fs.readdirSync(tempDir);
        const vttFile = files.find(
          (f) =>
            f.startsWith(`${timestamp}_`) &&
            (f.endsWith(".vtt") || f.endsWith(".srt"))
        );

        if (vttFile) {
          const rawSubtitle = fs.readFileSync(
            path.join(tempDir, vttFile),
            "utf-8"
          );
          // แปลง VTT/SRT เป็น plain text (ลบ timestamps และ formatting)
          transcript = rawSubtitle
            .replace(/WEBVTT\n\n/g, "")
            .replace(
              /\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\n/g,
              ""
            )
            .replace(
              /\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/g,
              ""
            )
            .replace(/<[^>]+>/g, "") // ลบ HTML tags
            .replace(/^\d+\n/gm, "") // ลบ sequence numbers
            .replace(/\n{2,}/g, "\n")
            .trim();

          transcriptSource = "subtitle";
          console.log(
            `[Summarize] Using ${
              useAutoCaptions ? "auto-captions" : "subtitles"
            } (${transcript.length} chars)`
          );
        }
      } catch (subError) {
        console.log(
          "[Summarize] Failed to download subtitles:",
          subError.message
        );
      }
    }

    // 3. ถ้าไม่มี subtitles หรือดาวน์โหลดไม่สำเร็จ ให้ใช้ Whisper
    if (!transcript || transcript.trim().length === 0) {
      console.log("[Summarize] No subtitles available, using Whisper...");

      const audioFile = path.join(
        tempDir,
        `${timestamp}_${sanitizedTitle}.mp3`
      );

      console.log("[Summarize] Downloading audio...");
      await execPromise(
        `yt-dlp --no-warnings --extractor-args "youtube:player_client=android,web" -x --audio-format mp3 --audio-quality 64K -o "${audioFile}" "${videoLink}"`
      );

      console.log(
        `[Summarize] Transcribing with Whisper (model: ${WHISPER_MODEL})...`
      );
      try {
        await execPromise(
          `whisper "${audioFile}" --model ${WHISPER_MODEL} --output_format txt --output_dir "${tempDir}" --language Thai`,
          { maxBuffer: 50 * 1024 * 1024 }
        );
      } catch (whisperError) {
        console.log(
          "[Summarize] Retrying Whisper without language specification..."
        );
        await execPromise(
          `whisper "${audioFile}" --model ${WHISPER_MODEL} --output_format txt --output_dir "${tempDir}"`,
          { maxBuffer: 50 * 1024 * 1024 }
        );
      }

      // อ่าน transcript
      const expectedTranscript = audioFile.replace(".mp3", ".txt");
      if (fs.existsSync(expectedTranscript)) {
        transcript = fs.readFileSync(expectedTranscript, "utf-8");
      } else {
        const files = fs.readdirSync(tempDir);
        const txtFile = files.find(
          (f) => f.startsWith(`${timestamp}_`) && f.endsWith(".txt")
        );
        if (txtFile) {
          transcript = fs.readFileSync(path.join(tempDir, txtFile), "utf-8");
        }
      }

      transcriptSource = "whisper";
    }

    if (!transcript || transcript.trim().length === 0) {
      throw new Error("ไม่สามารถ transcribe วิดีโอได้");
    }

    // 4. ส่งให้ Gemini สรุป
    console.log("[Summarize] Generating summary with Gemini...");
    const prompt = `คุณคืออัจฉริยะด้านการวิเคราะห์การลงทุนและเศรษฐศาสตร์ หน้าที่ของคุณคือสรุปเนื้อหาจากวิดีโอนี้ให้ "ละเอียดครบถ้วนที่สุด" และ "ทรงพลัง" เหมือนตัวอย่างที่กำหนด

ชื่อวิดีโอ: ${title}

เนื้อหา (transcript):
${transcript.substring(0, 1000000)}

กฎเหล็กในการสรุป:
1. **ห้ามสรุปแบบย่อเกินไป**: ให้ดึงข้อมูลมาให้ครบทุกประเด็นที่วิทยากรพูด
2. **ความยาวและรายละเอียด**: แต่ละหัวข้อต้องมีความยาวและข้อมูลที่เพียงพอ เห็นภาพชัดเจน ไม่ใช่แค่สรุปสั้นๆ 1 ประโยค
3. **เจาะลึกเนื้อหา**: หากมีการพูดถึงสถิติ ตัวเลข ชื่อหุ้น ชื่อกลุ่มอุตสาหกรรม หรือมุมมองเฉพาะตัวของนักลงทุน (เช่น Buffett, Trump) ให้ใส่มาให้หมด

โครงสร้างที่ต้องทำ:

1. **สถานการณ์ตลาดและภาพรวมที่น่าสนใจ (marketHighlights)**:
   - ดึงทุกประเด็นเด่นที่พูดถึง เช่น Sector Rotation, นิยามตลาดหมี vs การปรับฐาน, ความเคลื่อนไหวรายประเทศ (ญี่ปุ่น, ไทย, สหรัฐฯ), ผลประกอบการกลุ่มธนาคาร ฯลฯ
   - แต่ละประเด็นต้องมี "title" ที่สื่อสารชัดเจน และ "description" ที่อธิบายเนื้อหาอย่างละเอียดและน่าติดตาม

2. **เจาะลึกเนื้อหาจาก Paper / Research Reports (papers)**:
   - สกัดเนื้อหาจากทุก Paper ที่มีการอ้างอิงในคลิป แยกสรุปตามเจ้าของ Paper (เช่น BlackRock, Robeco, Franklin Templeton ฯลฯ)
   - แต่ละ Paper ต้องประกอบด้วย:
     - "source": ชื่อสถาบัน/เจ้าของ Paper
     - "title": หัวข้อหลักของ Paper นั้นๆ
     - "keyFindings": รายการประเด็นสำคัญทั้งหมดที่อยู่ใน Paper นั้น (ต้องมีหลายประเด็นตามที่พูดในคลิป)
     - แต่ละ Finding ต้องมี "title" และ "description" ที่ลงรายละเอียดเจาะลึก

3. **บทสรุป (conclusion)**:
   - เขียนสรุปภาพรวมและสไตล์การลงทุนที่เหมาะสมกับสถานการณ์นี้ในรูปแบบ 1-2 ย่อหน้า โดยเน้นกลยุทธ์ที่นักลงทุนควรนำไปใช้จริง

รูปแบบ JSON ที่ต้องตอบ (ห้ามมี markdown code block):
{
  "marketHighlights": [
    { "title": "ชื่อหัวข้อประเด็น", "description": "รายละเอียดแบบเจาะลึกและน่าติดตาม" }
  ],
  "papers": [
    {
      "source": "ชื่อสถาบัน",
      "title": "หัวข้อหลักของ Paper",
      "keyFindings": [
        { "title": "ใจความแม่บท", "description": "รายละเอียดข้อมูลแบบจัดเต็ม" }
      ]
    }
  ],
  "conclusion": "สรุปภาพรวมและกลยุทธ์การลงทุนแบบมืออาชีพ"
}`;

    const response = await genai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
    });

    let summaryData;
    try {
      const responseText = response.text
        .replace(/```json\n?|```\n?/g, "")
        .trim();
      summaryData = JSON.parse(responseText);
    } catch (parseError) {
      summaryData = {
        summary: response.text,
        keyPoints: [],
      };
    }

    // 5. ลบไฟล์ชั่วคราว
    const tempFiles = fs.readdirSync(tempDir);
    tempFiles
      .filter((f) => f.startsWith(`${timestamp}_`))
      .forEach((f) => {
        const filePath = path.join(tempDir, f);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });

    console.log(`[Summarize] Done! (source: ${transcriptSource})`);

    // อัปเดต log และบันทึกผลสรุป
    await updateUsageLog(logId, {
      status: "success",
      processingTimeMs: Date.now() - startTime,
    });

    await saveSummaryResult(logId, {
      videoUrl: videoLink,
      videoTitle: title,
      conclusion: summaryData.conclusion,
      marketHighlights: summaryData.marketHighlights,
      papers: summaryData.papers,
      transcriptLength: transcript.length,
      transcriptSource: transcriptSource,
      rawResult: summaryData,
    });

    res.json({
      title: title,
      author: info.uploader || info.channel,
      duration: info.duration,
      marketHighlights: summaryData.marketHighlights || [],
      papers: summaryData.papers || [],
      conclusion: summaryData.conclusion || null,
      transcriptLength: transcript.length,
      transcriptSource: transcriptSource,
    });
  } catch (error) {
    console.error("Summarize error:", error);
    await updateUsageLog(logId, {
      status: "error",
      errorMessage: error.message,
      processingTimeMs: Date.now() - startTime,
    });
    res.status(500).json({
      error: "เกิดข้อผิดพลาดในการสรุปวิดีโอ",
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: ตรวจสอบสถานะเซิร์ฟเวอร์
 *     description: แสดงสถานะของ dependencies ต่างๆ เช่น yt-dlp, Gemini AI, Database
 *     tags: [System]
 *     responses:
 *       200:
 *         description: สถานะเซิร์ฟเวอร์
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: OK
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 ytdlp:
 *                   type: string
 *                   enum: [installed, not found]
 *                 gemini:
 *                   type: string
 *                   enum: [configured, not configured]
 *                 database:
 *                   type: string
 *                   enum: [connected, not configured, error]
 */
app.get("/health", async (req, res) => {
  const hasYtDlp = await checkYtDlp();

  // Check database connection
  let dbStatus = "not configured";
  if (pool) {
    try {
      await pool.query("SELECT 1");
      dbStatus = "connected";
    } catch (error) {
      dbStatus = "error: " + error.message;
    }
  }

  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    ytdlp: hasYtDlp ? "installed" : "not found",
    gemini: genai ? "configured" : "not configured",
    database: dbStatus,
  });
});

/**
 * @swagger
 * /usage-logs:
 *   get:
 *     summary: ดึงประวัติการใช้งาน
 *     description: ดึงข้อมูล log การใช้งาน API ทั้งหมด
 *     tags: [History]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: จำนวน records สูงสุดที่ต้องการ
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: ตำแหน่งเริ่มต้น (สำหรับ pagination)
 *       - in: query
 *         name: endpoint
 *         schema:
 *           type: string
 *           enum: [video-info, download, download-fast, summarize]
 *         description: กรองตาม endpoint
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, success, error]
 *         description: กรองตามสถานะ
 *     responses:
 *       200:
 *         description: รายการประวัติการใช้งาน
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:
 *                   type: integer
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *       500:
 *         description: Database not configured
 */
app.get("/usage-logs", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ error: "Database not configured" });
  }

  const { limit = 50, offset = 0, endpoint, status } = req.query;

  try {
    let whereClause = "";
    const params = [];
    let paramIndex = 1;

    if (endpoint) {
      whereClause += ` WHERE endpoint = $${paramIndex}`;
      params.push(endpoint);
      paramIndex++;
    }

    if (status) {
      whereClause += whereClause
        ? ` AND status = $${paramIndex}`
        : ` WHERE status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM usage_logs${whereClause}`,
      params
    );

    // Get data with pagination
    const dataResult = await pool.query(
      `SELECT * FROM usage_logs${whereClause} 
       ORDER BY created_at DESC 
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    res.json({
      total: parseInt(countResult.rows[0].total),
      limit: parseInt(limit),
      offset: parseInt(offset),
      data: dataResult.rows,
    });
  } catch (error) {
    console.error("Error fetching usage logs:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch usage logs", details: error.message });
  }
});

/**
 * @swagger
 * /summaries:
 *   get:
 *     summary: ดึงประวัติการสรุปวิดีโอ
 *     description: ดึงข้อมูลผลสรุปวิดีโอที่เคยทำไว้
 *     tags: [History]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: จำนวน records สูงสุดที่ต้องการ
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: ตำแหน่งเริ่มต้น (สำหรับ pagination)
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: ค้นหาจากชื่อวิดีโอ
 *     responses:
 *       200:
 *         description: รายการประวัติการสรุป
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:
 *                   type: integer
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       video_url:
 *                         type: string
 *                       video_title:
 *                         type: string
 *                       summary:
 *                         type: string
 *                       key_points:
 *                         type: array
 *                       created_at:
 *                         type: string
 *       500:
 *         description: Database not configured
 */
app.get("/summaries", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ error: "Database not configured" });
  }

  const { limit = 20, offset = 0, search } = req.query;

  try {
    let whereClause = "";
    const params = [];
    let paramIndex = 1;

    if (search) {
      whereClause = ` WHERE s.video_title ILIKE $${paramIndex} OR s.video_url ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM summary_results s${whereClause}`,
      params
    );

    // Get data with pagination
    const dataResult = await pool.query(
      `SELECT 
        s.id,
        s.video_url,
        s.video_title,
        s.conclusion,
        s.market_highlights,
        s.papers,
        s.transcript_length,
        s.transcript_source,
        s.created_at,
        u.video_author,
        u.video_duration
       FROM summary_results s
       JOIN usage_logs u ON s.usage_log_id = u.id
       ${whereClause}
       ORDER BY s.created_at DESC 
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    res.json({
      total: parseInt(countResult.rows[0].total),
      limit: parseInt(limit),
      offset: parseInt(offset),
      data: dataResult.rows,
    });
  } catch (error) {
    console.error("Error fetching summaries:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch summaries", details: error.message });
  }
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
  console.log(`   POST /summarize - สรุปเนื้อหาวิดีโอด้วย AI`);
  console.log(`   GET  /health - ตรวจสอบสถานะเซิร์ฟเวอร์`);
  console.log(`\n📚 Swagger Docs: http://localhost:${PORT}/api-docs`);

  const hasYtDlp = await checkYtDlp();
  if (!hasYtDlp) {
    console.log(`\n⚠️  WARNING: yt-dlp not found!`);
    console.log(`   Install with: pip install yt-dlp`);
    console.log(`   Or on Mac: brew install yt-dlp`);
  } else {
    console.log(`\n✅ yt-dlp is installed`);
  }

  if (pool) {
    try {
      await pool.query("SELECT 1");
      console.log(`✅ Database connected`);
    } catch (error) {
      console.log(`⚠️  WARNING: Database connection failed: ${error.message}`);
    }
  } else {
    console.log(`⚠️  WARNING: DATABASE_URL not configured`);
  }
});
