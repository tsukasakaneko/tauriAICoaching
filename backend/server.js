const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");

// Fail fast if required secrets are missing or insecure
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error(
    "FATAL: JWT_SECRET environment variable must be set and at least 32 characters long.\n" +
    "Set it in backend/.env before starting the server."
  );
  process.exit(1);
}
if (process.env.JWT_SECRET === 'your-super-secret-jwt-key-change-this-in-production-min-32-chars') {
  console.error(
    "FATAL: JWT_SECRET が .env.example のデフォルト値のままです。必ず変更してください。"
  );
  process.exit(1);
}

// If Riot OAuth is configured, the encryption key must also be set
if (process.env.RIOT_CLIENT_ID && !process.env.RIOT_ENCRYPTION_KEY) {
  console.error(
    "FATAL: RIOT_CLIENT_ID が設定されていますが RIOT_ENCRYPTION_KEY が未設定です。\n" +
    "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" で生成して .env に追加してください。"
  );
  process.exit(1);
}
if (process.env.RIOT_ENCRYPTION_KEY && process.env.RIOT_ENCRYPTION_KEY.length !== 64) {
  console.error("FATAL: RIOT_ENCRYPTION_KEY は64文字のhex文字列（32バイト）である必要があります。");
  process.exit(1);
}

const authRoutes = require("./routes/auth");
const { router: coachingRouter } = require("./routes/coaching");
const { router: autoRecordRouter } = require("./routes/autorecord");
const { sweepOrphanFrames } = require("./services/videoAnalyzer");

// Reclaim disk from frame-extraction temp dirs left by crashed runs.
try {
  const removed = sweepOrphanFrames();
  if (removed > 0) console.log(`[startup] swept ${removed} orphan frame dir(s)`);
} catch (err) {
  console.warn("[startup] orphan frame sweep failed:", err.message);
}

const app = express();
const PORT = process.env.PORT || 3001;

// Allow Tauri webview origins (production: tauri://localhost, dev: http://localhost:1420)
const allowedOrigins = [
  "tauri://localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
  "http://localhost",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/auth", authRoutes);
app.use("/", coachingRouter);
app.use("/", autoRecordRouter);

app.use((_req, res) => res.status(404).json({ message: "Not found" }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Backend running on http://127.0.0.1:${PORT}`);
});
