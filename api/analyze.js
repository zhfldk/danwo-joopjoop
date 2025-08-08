// /api/analyze.js – Vercel serverless function
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
    const images = Array.isArray(files.image) ? files.image : [files.image];
    const base64s = await Promise.all(images.map(f => fs.promises.readFile(f.filepath, { encoding:"base64" })));

    if (mode === "recheck") {
      const lowWords = JSON.parse(fields.lowWords || "[]");
      const resp = await callOpenAI(base64s, makeRecheckPrompt(lowWords));
      return res.status(200).json(resp);
    } else {
      const resp = await callOpenAI(base64s, makeAnalyzePrompt());
      // 2-pass 내부에서 바로 할 수도 있으나, 프런트에서 저신뢰만 재검토하는 방식으로 분리
      return res.status(200).json(resp);
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
}

function makeAnalyzePrompt() {
  return {
    system:
      "You are a meticulous OCR+lexicon assistant. Extract English words and their Korean meanings if they visibly appear in the image. Keep the exact Korean if shown. If no Korean meaning is shown for a word, return meaning_ko as null. Deduplicate, and provide corrected_word if you fix a typo. Include a confidence score 0–1.",
    userInstruction:
`Return ONLY valid JSON:
{
 "items":[
   {"word":"string","corrected_word":"string","meaning_ko": "string|null","source":"image","confidence": 0.0}
 ],
 "notes":{"low_confidence":["..."], "duplicates":["..."]}
}

Rules:
- If an English–Korean pair appears, copy the Korean verbatim (do NOT translate).
- If a word has no visible Korean meaning, set meaning_ko: null.
- word must be A–Z only (allow apostrophes).
- Merge duplicates; prefer the corrected spelling.
`
  };
}

function makeRecheckPrompt(lowWords) {
  return {
    system:
      "You re-verify uncertain words against the images. For each input word, confirm corrected spelling and give a confidence score. Do NOT invent new words.",
    userInstruction:
`Recheck only these words: ${JSON.stringify(lowWords)}
Return ONLY JSON:
{ "items":[ {"word":"string","corrected_word":"string","confidence":0.0} ] }`
  };
}

async function callOpenAI(base64s, prompt) {
  const input = [
    { role: "system", content: prompt.system },
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt.userInstruction },
        ...base64s.map(b64 => ({ type: "input_image", image_url: `data:image/png;base64,${b64}` }))
      ]
    }
  ];

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o", // higher-accuracy vision
      input,
      response_format: { type: "json_object" }
    })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error("OpenAI error: " + t);
  }
  const data = await r.json();
  // responses API returns { output_text, output, ... } depending on version;
  // We expect a JSON object in output[0]?.content[0]?.json or similar; fall back to parse
  let out = null;
  try {
    // Try best-effort to locate a JSON object in any field
    out = data.output || data;
  } catch { /* noop */ }
  return out;
}
