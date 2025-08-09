// /api/analyze.js – Vercel serverless function (Chat Completions 버전)
export const config = { api: { bodyParser: false } };

import formidable from "formidable";
import fs from "fs";

const parseForm = (req) =>
  new Promise((resolve, reject) =>
    formidable({ multiples: true }).parse(req, (err, fields, files) =>
      err ? reject(err) : resolve({ fields, files })
    )
  );

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("POST only");
  try {
    const { fields, files } = await parseForm(req);
    const mode = (req.query.mode || "analyze").toString();

    const rawImages = Array.isArray(files.image) ? files.image : [files.image].filter(Boolean);
    if (!rawImages.length) return res.status(400).json({ error: "No image files" });

    // base64 + 올바른 MIME 타입 확보
    const imgs = await Promise.all(
      rawImages.map(async (f) => {
        const b64 = await fs.promises.readFile(f.filepath, { encoding: "base64" });
        const mime = f.mimetype || "image/png";
        return { b64, mime };
      })
    );

    const messages =
      mode === "recheck"
        ? makeRecheckMessages(safeParseJSON(fields.lowWords || "[]") || [], imgs)
        : makeAnalyzeMessages(imgs);

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        // ✅ 문자열만! 필요시 "o3-mini"로 바꿔도 됨
        model: "gpt-4o",
        messages,
        temperature: 0,
        response_format: { type: "json_object" }
      })
    });

    if (!openaiRes.ok) {
      const t = await openaiRes.text();
      throw new Error(`OpenAI error ${openaiRes.status}: ${t}`);
    }

    const data = await openaiRes.json();
    const content = data?.choices?.[0]?.message?.content;
    const parsed = safeParseJSON(content);
    if (!parsed) throw new Error("Invalid JSON from AI");
    return res.status(200).json(parsed);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
}

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
`Return ONLY valid JSON:
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
Return ONLY JSON:
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

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

