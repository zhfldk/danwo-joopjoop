// /api/analyze.js
// Vercel Serverless Function (Node.js 런타임)
// multipart → formidable, OpenAI Chat Completions (이미지+JSON)

export const config = { api: { bodyParser: false } };

import formidable from "formidable";
import fs from "fs";

// ---------- helpers ----------
const parseForm = (req) =>
  new Promise((resolve, reject) => {
    const form = formidable({
      multiples: true,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      keepExtensions: true,
    });
    form.parse(req, (err, fields, files) =>
      err ? reject(err) : resolve({ fields, files })
    );
  });

const toArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
function collectImages(files) {
  const cands = [
    ...toArray(files?.image),
    ...toArray(files?.images),
    ...toArray(files?.file),
    ...toArray(files?.upload),
  ].filter(Boolean);
  return cands;
}

// 모델이 가끔 텍스트를 섞어줄 수 있어 첫 번째 {..} 블록만 파싱
function strictJSON(text) {
  if (!text) return null;
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}
function safeParseJSON(str) { try { return JSON.parse(str); } catch { return null; } }

// ---------- prompts ----------
function makeAnalyzeMessages(imgs) {
  return [
    {
      role: "system",
      content:
        "You are a meticulous OCR+lexicon assistant. Extract English words and their Korean meanings if they visibly appear in the image. Keep the exact Korean if shown. If no Korean meaning is shown for a word, return meaning_ko as null. Deduplicate, fix obvious typos (return corrected_word), and include confidence 0–1."
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
`Return ONLY valid JSON (no fences, no commentary):
{
 "items":[
   {"word":"string","corrected_word":"string","meaning_ko":"string|null","source":"image","confidence":0.0}
 ],
 "notes":{"low_confidence":["..."], "duplicates":["..."]}
}
Rules:
- If an English–Korean pair appears, copy the Korean verbatim (do NOT translate).
- If a word has no visible Korean meaning, set meaning_ko: null.
- word must be A–Z only (allow apostrophes).
- Merge duplicates; prefer corrected spelling.`
        },
        ...imgs.map(({ b64, mime }) => ({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${b64}` }
        }))
      ]
    }
  ];
}

function makeRecheckMessages(lowWords, imgs) {
  return [
    {
      role: "system",
      content:
        "You re-verify uncertain words against the images. For each input word, confirm corrected spelling and give a confidence score. Do NOT invent new words."
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
`Recheck only these words: ${JSON.stringify(lowWords)}
Return ONLY JSON (no fences, no commentary):
{ "items":[ {"word":"string","corrected_word":"string","confidence":0.0} ] }`
        },
        ...imgs.map(({ b64, mime }) => ({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${b64}` }
        }))
      ]
    }
  ];
}

// ---------- main ----------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("POST only");
  try {
    const { fields, files } = await parseForm(req);
    const mode = (req.query.mode || "analyze").toString();

    const rawImages = collectImages(files);
    if (!rawImages.length) return res.status(400).json({ error: "No image files" });

    const imgs = await Promise.all(
      rawImages.map(async (f) => {
        const b64 = await fs.promises.readFile(f.filepath, { encoding: "base64" });
        const mime = f.mimetype || "image/png";
        return { b64, mime };
      })
    );

    const messages =
      mode === "recheck"
        ? makeRecheckMessages(safeParseJSON(fields?.lowWords || "[]") || [], imgs)
        : makeAnalyzeMessages(imgs);

    // 1차: gpt-4o (안정성), 실패 시 4o-mini 폴백
    let raw;
    try {
      raw = await callOpenAI("gpt-4o", messages, true); // JSON 모드 ON
    } catch (e) {
      // 폴백 시도 (원인 파악용 메시지를 유지)
      raw = await callOpenAI("gpt-4o-mini", messages, true);
    }

    const parsed = strictJSON(raw);
    if (!parsed) throw new Error("Invalid JSON from AI");
    return res.status(200).json(parsed);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}

async function callOpenAI(model, messages, wantJSON) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      ...(wantJSON ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`OpenAI error ${r.status} [${model}]: ${t.slice(0, 800)}`);
  return t;
}
