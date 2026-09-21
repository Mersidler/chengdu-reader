/**
 * TTS 端到端验证（Node 侧，稳定可重复）。
 *
 * 为什么需要它：真机浏览器验证（tests/devtools/verify-tts.html）已经确认了
 * **decodeAudioData 能解码官方 API 的 MP3**，但 Firefox headless 在本机
 * 会偶发崩溃（Exiting due to channel error），不适合作为每次都能跑的回归。
 *
 * 这个脚本用真实 API 稳定地验证整条链路的**数据层面**：
 *   1. background.js 的 synthesizeSpeech 逻辑（复刻其请求构造）
 *   2. 返回的 base64 能否正确解码
 *   3. 解码出的 MP3 结构是否完整（帧同步连续、时长与文本相符）
 *   4. 两种粒度的文本切分是否都产出合理大小的请求
 *
 * 需要 API Key。用法：
 *   MIMO_API_KEY=sk-xxx node tests/devtools/verify-e2e.cjs
 * 或把 key 写在 .tts-key（已 gitignore）里。
 */
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const HERE = __dirname;
const ROOT = path.join(HERE, "..", "..");

function readKey() {
  if (process.env.MIMO_API_KEY) return process.env.MIMO_API_KEY.trim();
  const f = path.join(ROOT, ".tts-key");
  try {
    return fs.readFileSync(f, "utf8").trim();
  } catch (_) {
    return "";
  }
}

const KEY = readKey();

/** 复刻 background.js 的 synthesizeSpeech（保持字段一致）。 */
function synthesize(text, voice, format) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: "mimo-v2.5-tts",
      messages: [
        { role: "user", content: "请朗读下面这段话。" },
        { role: "assistant", content: text },
      ],
      audio: { voice: voice, format: format },
    });
    const req = https.request(
      {
        hostname: "api.xiaomimimo.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + KEY,
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 300000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            let detail = "";
            try {
              const j = JSON.parse(body);
              detail = (j.error && (j.error.param || j.error.message)) || "";
            } catch (_) { /* 非 JSON */ }
            resolve({ ok: false, status: res.statusCode, message: detail });
            return;
          }
          try {
            const j = JSON.parse(body);
            const audio = j.choices && j.choices[0] && j.choices[0].message
              && j.choices[0].message.audio;
            if (!audio || !audio.data) {
              resolve({ ok: false, reason: "no-audio" });
              return;
            }
            resolve({ ok: true, audio: audio.data, chars: text.length });
          } catch (e) {
            resolve({ ok: false, reason: "parse-error", message: e.message });
          }
        });
      }
    );
    req.on("error", (e) => resolve({ ok: false, reason: "network-error", message: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, reason: "timeout" }); });
    req.write(payload);
    req.end();
  });
}

/** 解析 MP3 结构：帧数、估算时长、是否连续同步。 */
function analyzeMp3(buf) {
  const BR_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const BR_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const SR_V1 = [44100, 48000, 32000, 0];
  const SR_V2 = [22050, 24000, 16000, 0];
  let frames = 0;
  let samples = 0;
  let off = 0;
  let resyncs = 0;
  let firstRate = 0;

  while (off < buf.length - 4) {
    if (buf[off] === 0xff && (buf[off + 1] & 0xe0) === 0xe0) {
      const verBits = (buf[off + 1] >> 3) & 3; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
      const layer = (buf[off + 1] >> 1) & 3;   // 1=LayerIII
      if (layer === 1 && verBits !== 1) {
        const brIdx = (buf[off + 2] >> 4) & 0xf;
        const srIdx = (buf[off + 2] >> 2) & 3;
        const pad = (buf[off + 2] >> 1) & 1;
        const isV1 = verBits === 3;
        const br = (isV1 ? BR_V1L3 : BR_V2L3)[brIdx] * 1000;
        const sr = (isV1 ? SR_V1 : SR_V2)[srIdx];
        if (br > 0 && sr > 0) {
          const frameLen = Math.floor((isV1 ? 144 : 72) * br / sr) + pad;
          if (frameLen > 4 && off + frameLen <= buf.length + 4) {
            frames++;
            // MPEG1 LayerIII 每帧 1152 样本，MPEG2/2.5 为 576
            samples += isV1 ? 1152 : 576;
            if (!firstRate) firstRate = sr;
            off += frameLen;
            continue;
          }
        }
      }
      resyncs++;
    }
    off++;
  }
  // 用实际采样率算时长（比固定 12000 更准）
  const seconds = firstRate ? samples / firstRate : 0;
  return { frames, resyncs, seconds, sampleRate: firstRate };
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "✔ " : "✘ ") + name + (detail ? "  — " + detail : ""));
}

(async function main() {
  if (!KEY) {
    console.log("缺少 API Key。请设置 MIMO_API_KEY 环境变量或写入 .tts-key 文件。");
    process.exit(2);
  }
  console.log("=== TTS 端到端验证 ===\n");

  // ---- 1) 短文本（验证基本链路）
  const short = "今天天气很好，我们一起去公园散步吧。";
  const r1 = await synthesize(short, "茉莉", "mp3");
  if (!r1.ok) {
    record("短文本合成", false, JSON.stringify(r1));
  } else {
    record("短文本合成", true, `base64 ${r1.audio.length} 字符`);
    const buf = Buffer.from(r1.audio, "base64");
    record("base64 解码", buf.length > 0, `${buf.length} 字节`);
    const m = analyzeMp3(buf);
    record(
      "MP3 结构完整（帧连续）",
      m.frames > 10 && m.resyncs / m.frames < 0.5,
      `${m.frames} 帧 @${m.sampleRate}Hz，${m.seconds.toFixed(2)}s，重同步 ${m.resyncs} 处`
    );
    record(
      "时长与文本相符（未被截断）",
      m.seconds > 1.5 && m.seconds < 8,
      `${short.length} 字 → ${m.seconds.toFixed(2)}s`
    );
  }

  // ---- 2) 长文本（验证「整页」模式：这是中转服务失败的地方）
  const unit = "这是一段用于测试长文本合成的中文内容，大约二十四个字。";
  let long = "";
  for (let i = 0; i < 42; i++) long += unit; // 约 1000 字
  const r2 = await synthesize(long, "茉莉", "mp3");
  if (!r2.ok) {
    record("长文本合成（约1000字）", false, JSON.stringify(r2));
  } else {
    const buf = Buffer.from(r2.audio, "base64");
    const m = analyzeMp3(buf);
    record(
      "★ 长文本合成（约1000字）",
      m.seconds > 150,
      `${long.length} 字 → ${buf.length} 字节 / ${m.seconds.toFixed(0)}s（中转服务在此只返回 8~43s，被截断）`
    );
  }

  // ---- 3) 各音色可用性
  const voices = ["茉莉", "冰糖", "苏打", "白桦", "mimo_default"];
  const voiceOk = [];
  for (const v of voices) {
    const r = await synthesize("测试音色。", v, "mp3");
    voiceOk.push(v + (r.ok ? "✔" : "✘"));
  }
  record("中文音色可用", voiceOk.filter((s) => s.endsWith("✔")).length === voices.length, voiceOk.join(" "));

  // ---- 4) 格式
  for (const fmt of ["mp3", "wav"]) {
    const r = await synthesize("测试格式。", "茉莉", fmt);
    if (!r.ok) { record(`格式 ${fmt}`, false, JSON.stringify(r)); continue; }
    const buf = Buffer.from(r.audio, "base64");
    const magic = buf.slice(0, 4).toString("hex");
    const expect = fmt === "wav" ? magic.startsWith("52494646") : true;
    record(`格式 ${fmt}`, expect, `${buf.length} 字节，魔数 ${magic}`);
  }

  // ---- 5) 错误处理：非法音色应给出可读原因
  const rErr = await synthesize("测试。", "不存在的音色", "mp3");
  record(
    "非法音色返回可读错误",
    !rErr.ok && /voice/i.test(rErr.message || ""),
    rErr.ok ? "意外成功" : rErr.message
  );

  const failed = results.filter((r) => !r.pass);
  console.log("");
  console.log(
    failed.length === 0
      ? `E2E_ALL_PASS (${results.length}/${results.length})`
      : `E2E_FAILED (${failed.length} 项失败)`
  );
  fs.writeFileSync(
    path.join(HERE, "verify-e2e-result.json"),
    JSON.stringify({ at: new Date().toISOString(), results, summary: failed.length === 0 ? "pass" : "fail" }, null, 2)
  );
  process.exit(failed.length === 0 ? 0 : 1);
})();
