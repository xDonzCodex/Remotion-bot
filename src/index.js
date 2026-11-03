require("dotenv").config();

const { Telegraf } = require("telegraf");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const unzipper = require("unzipper");

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN is missing");

const allowedIds = new Set(
  (process.env.ALLOWED_USER_IDS || "")
    .split(",").map(x => x.trim()).filter(Boolean)
);
const MAX_ZIP_MB = Number(process.env.MAX_ZIP_MB || 100);
const TIMEOUT_MIN = Number(process.env.RENDER_TIMEOUT_MIN || 30);
const bot = new Telegraf(token);
const jobs = new Map();

function allowed(ctx) {
  const id = String(ctx.from?.id || "");
  return allowedIds.size > 0 && allowedIds.has(id);
}

function run(command, args, cwd, timeoutMs, onOutput = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: "1", npm_config_yes: "true" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      reject(new Error("Render/install timeout reached."));
    }, timeoutMs);

    const collect = chunk => {
      const s = chunk.toString();
      output = (output + s).slice(-12000);
      onOutput(s);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`Command exited with code ${code}\n${output.slice(-4000)}`));
    });
  });
}

async function safeExtract(zipPath, dest) {
  const directory = await unzipper.Open.file(zipPath);
  if (directory.files.length > 5000) throw new Error("ZIP contains too many files.");
  let total = 0;
  for (const entry of directory.files) {
    const name = entry.path.replace(/\\/g, "/");
    if (name.startsWith("/") || name.split("/").includes(".."))
      throw new Error("Unsafe ZIP path detected.");
    total += Number(entry.uncompressedSize || 0);
    if (total > 2 * 1024 * 1024 * 1024)
      throw new Error("ZIP expands beyond 2 GB.");
  }
  await directory.extract({ path: dest, concurrency: 8 });
}

async function findProjectRoot(dir, depth = 0) {
  if (depth > 3) return null;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  if (entries.some(e => e.isFile() && e.name === "package.json")) return dir;
  for (const e of entries) {
    if (e.isDirectory() && !["node_modules", ".git"].includes(e.name)) {
      const found = await findProjectRoot(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function cleanup(dir) {
  if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

bot.start(ctx => ctx.reply(
  "🎬 Remotion Render Bot\n\n" +
  "Reply ke ZIP project Remotion dengan /remotion untuk render MP4.\n" +
  "Gunakan hanya ZIP project milik sendiri/tepercaya.\n\n" +
  "/help — bantuan"
));

bot.help(ctx => ctx.reply(
  "Cara pakai:\n" +
  "1. Kirim ZIP project Remotion (berisi package.json dan entry point).\n" +
  "2. Reply pesan ZIP tersebut dengan /remotion.\n" +
  "3. Tunggu proses render dan bot mengirim MP4.\n\n" +
  "/cancel — batalkan job aktif.\n\n" +
  "Catatan: project ZIP menjalankan kode dan dependency. Hanya gunakan project tepercaya."
));

bot.command("remotion", async ctx => {
  if (!allowed(ctx)) return ctx.reply("⛔ Akses tidak diizinkan. Admin bot perlu memasukkan Telegram ID kamu ke ALLOWED_USER_IDS.");
  const reply = ctx.message.reply_to_message;
  const doc = reply?.document;
  if (!doc) return ctx.reply("Reply pesan yang berisi ZIP project Remotion dengan /remotion.");
  const filename = doc.file_name || "project.zip";
  if (!filename.toLowerCase().endsWith(".zip"))
    return ctx.reply("File harus berupa ZIP.");
  if ((doc.file_size || 0) > MAX_ZIP_MB * 1024 * 1024)
    return ctx.reply(`ZIP terlalu besar. Batas konfigurasi: ${MAX_ZIP_MB} MB.`);
  const userId = String(ctx.from.id);
  if (jobs.has(userId)) return ctx.reply("Kamu masih memiliki job aktif. Gunakan /cancel terlebih dahulu.");

  const jobId = `${Date.now()}-${userId}`;
  const workDir = path.join(os.tmpdir(), `remotion-${jobId}`);
  jobs.set(userId, { workDir, cancelled: false });
  await fsp.mkdir(workDir, { recursive: true });
  const status = await ctx.reply("📥 Mengunduh ZIP project...");
  let lastUpdate = 0;

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const zipPath = path.join(workDir, "project.zip");
    const response = await fetch(fileLink.href);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ZIP_MB * 1024 * 1024) throw new Error("File melebihi batas ukuran.");
    await fsp.writeFile(zipPath, buffer);

    const job = jobs.get(userId);
    if (!job || job.cancelled) throw new Error("Job dibatalkan.");
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, "📦 Mengekstrak ZIP...");
    const extracted = path.join(workDir, "project");
    await fsp.mkdir(extracted, { recursive: true });
    await safeExtract(zipPath, extracted);

    const projectRoot = await findProjectRoot(extracted);
    if (!projectRoot) throw new Error("package.json tidak ditemukan di ZIP.");
    const pkg = JSON.parse(await fsp.readFile(path.join(projectRoot, "package.json"), "utf8"));
    const remotionPkg = pkg.dependencies?.remotion || pkg.devDependencies?.remotion;
    if (!remotionPkg) throw new Error("Project tidak memiliki dependency 'remotion' di package.json.");

    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      "📚 Menginstall dependency...\nPastikan ZIP berasal dari project tepercaya.");
    
    const lockExists = fs.existsSync(path.join(projectRoot, "package-lock.json"));
    await run("npm", lockExists ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"],
      projectRoot, 10 * 60 * 1000);

    const job2 = jobs.get(userId);
    if (!job2 || job2.cancelled) throw new Error("Job dibatalkan.");
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      "🎬 Memulai Remotion render...");

    const settings = pkg.remotionBot || {};
    const outputName = path.basename(settings.output || "rendered-video.mp4");
    const outputPath = path.join(workDir, outputName);
    const entry = settings.entry || "src/index.js";
    const entryPath = path.join(projectRoot, entry);
    if (!fs.existsSync(entryPath)) {
      const candidates = ["src/index.ts", "src/index.tsx", "src/index.js", "src/index.jsx", "index.ts", "index.js"];
      const found = candidates.find(f => fs.existsSync(path.join(projectRoot, f)));
      if (!found) throw new Error("Entry Remotion tidak ditemukan. Atur remotionBot.entry di package.json.");
      settings.entry = found;
    }
    const composition = settings.composition;
    if (!composition) throw new Error("Tambahkan remotionBot.composition (ID Composition) di package.json.");

    // Fix parameters untuk Railway headless environment & audio re-encode
    const renderArgs = [
      "render", settings.entry || entry,
      composition, outputPath,
      "--codec", "h264",
      "--audio-codec", "aac",
      "--gl", "angle",
      "--log", "error"
    ];

    // Gunakan binary remotion lokal yang terinstall di node_modules project
    const localRemotionBin = path.join(projectRoot, "node_modules", ".bin", "remotion");
    const execBin = fs.existsSync(localRemotionBin) ? localRemotionBin : "npx";
    const execArgs = fs.existsSync(localRemotionBin) ? renderArgs : ["remotion", ...renderArgs];

    await run(execBin, execArgs, projectRoot, TIMEOUT_MIN * 60 * 1000, () => {
      const now = Date.now();
      if (now - lastUpdate > 15000) {
        lastUpdate = now;
        ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
          "🎬 Rendering video... Mohon tunggu.").catch(() => {});
      }
    });

    const job3 = jobs.get(userId);
    if (!job3 || job3.cancelled) throw new Error("Job dibatalkan.");
    const stat = await fsp.stat(outputPath);
    if (!stat.size) throw new Error("File MP4 hasil render kosong.");
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      `✅ Render selesai (${(stat.size / 1024 / 1024).toFixed(1)} MB). Mengirim video...`);
    await ctx.replyWithVideo({ source: outputPath }, {
      caption: `🎬 Remotion Render selesai\n📦 ${(stat.size / 1024 / 1024).toFixed(1)} MB`,
      supports_streaming: true
    });
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, "✅ Selesai! Video MP4 sudah dikirim.");
  } catch (err) {
    const msg = String(err.message || err).slice(0, 3500);
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      `❌ Render gagal\n\n${msg}`).catch(() => {});
  } finally {
    jobs.delete(userId);
    await cleanup(workDir);
  }
});

bot.command("cancel", async ctx => {
  if (!allowed(ctx)) return ctx.reply("⛔ Akses tidak diizinkan.");
  const job = jobs.get(String(ctx.from.id));
  if (!job) return ctx.reply("Tidak ada job aktif.");
  job.cancelled = true;
  await ctx.reply("Permintaan cancel diterima. Proses akan berhenti saat mencapai checkpoint.");
});

bot.catch((err, ctx) => {
  console.error("Telegram bot error:", err);
  ctx.reply("Terjadi error pada bot.").catch(() => {});
});

bot.launch();
console.log("Remotion Telegram bot started.");
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
