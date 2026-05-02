const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/auth");
const { router: coachingRouter } = require("./routes/coaching");
const { router: autoRecordRouter } = require("./routes/autorecord");

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
