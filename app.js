// ===== Helpers =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const imageInput = $("#imageInput");
const dropzone = $("#dropzone");
const thumbs = $("#thumbs");
const btnAnalyze = $("#btnAnalyze");
const btnClear = $("#btnClear");
const statusEl = $("#status");

const tableBody = $("#table tbody");
const btnFill = $("#btnFill");
const btnDedupe = $("#btnDedupe");
const btnExport = $("#btnExport");
const btnPrint = $("#btnPrint");
const btnPdf = $("#btnPdf");

let entries = []; // { word, corrected, meaning, confidence }

// ---- Fetch helper with timeout & better errors ----
async function fetchJSONWithErrors(url, options = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) {
      const cause = data?.error || text || `${res.status} ${res.statusText}`;
      throw new Error(cause.slice(0, 500));
    }
    return data ?? text;
  } finally {
    clearTimeout(id);
  }
}

// ---- Image previews ----
imageInput.addEventListener("change", () => renderThumbs(imageInput.files));
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith("image/"));
  if (!files.length) return;
  imageInput.files = filesToFileList(files);
  renderThumbs(imageInput.files);
});

function renderThumbs(fileList) {
  thumbs.innerHTML = "";
  Array.from(fileList || []).forEach(f => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.src = url;
    img.alt = f.name;
    img.onload = () => URL.revokeObjectURL(url);
    thumbs.appendChild(img);
  });
}
function filesToFileList(files) { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); return dt.files; }

// ---- AI Analyze ----
btnAnalyze.addEventListener("click", async () => {
  const files = Array.from(imageInput.files || []);
  if (!files.length) return alert("이미지를 선택하세요.");
  btnAnalyze.disabled = true; btnClear.disabled = true;
  try {
    statusEl.textContent = "AI 1차 분석 중…";
    const items = await analyzeWithAI(files);
    // items: [{word, meaning_ko, source, confidence, corrected_word?}]
    entries = items.map(it => ({
      word: it.word || "",
      corrected: it.corrected_word || it.word || "",
      meaning: it.meaning_ko || "",
      confidence: typeof it.confidence === "number" ? it.confidence : null,
    }));

    // 낮은 신뢰도만 2차 검토
    const lows = entries.filter(e => (e.confidence ?? 0) < 0.85).map(e => e.word);
    if (lows.length) {
      statusEl.textContent = `신뢰도 낮은 항목 재검토 중 (${lows.length}개)…`;
      const refined = await recheckWithAI(files, lows);
      // refined = [{word, corrected_word, confidence}]
      for (const r of refined) {
        const idx = entries.findIndex(e => e.word.toLowerCase() === (r.word||"").toLowerCase());
        if (idx >= 0) {
          entries[idx].corrected = r.corrected_word || entries[idx].corrected;
          entries[idx].confidence = r.confidence ?? entries[idx].confidence;
        }
      }
    }

    // 옵션: 뜻 자동 채우기
    const option = document.querySelector('input[name="meaningOption"]:checked').value;
    if (option === "auto") {
      statusEl.textContent = "사전으로 빈 뜻 채우는 중…";
      for (const e of entries) {
        if (!e.meaning) {
          try {
            const def = await fetchDefinitionEN(e.corrected || e.word);
            const meaning = def?.meaning || "";
            if (meaning) {
              const ko = await translateToKO(meaning).catch(()=>null);
              e.meaning = ko || `${meaning} (번역 실패: 직접 수정)`;
            }
          } catch {}
        }
      }
    }

    renderTable();
    statusEl.textContent = "완료";
  } catch (err) {
    console.error(err);
    statusEl.textContent = "실패: " + (err.message || err);
    alert("AI 분석 실패:\n" + (err.message || err));
  } finally {
    btnAnalyze.disabled = false; btnClear.disabled = false;
  }
});

btnClear.addEventListener("click", () => {
  imageInput.value = "";
  entries = [];
  renderTable();
  thumbs.innerHTML = "";
  statusEl.textContent = "대기 중…";
});

async function analyzeWithAI(files) {
  const fd = new FormData();
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) throw new Error(`이미지 ${f.name}가 10MB를 초과합니다.`);
    fd.append("image", f);
  }
  const j = await fetchJSONWithErrors("/api/analyze", { method:"POST", body: fd });
  return (j.items || []).map(x => ({
    word: x.word, meaning_ko: x.meaning_ko, confidence: x.confidence, corrected_word: x.corrected_word
  }));
}

async function recheckWithAI(files, lowWords) {
  const fd = new FormData();
  for (const f of files) fd.append("image", f);
  fd.append("lowWords", JSON.stringify(lowWords));
  const j = await fetchJSONWithErrors("/api/analyze?mode=recheck", { method:"POST", body: fd });
  return j.items || [];
}

// ---- Table ----
function renderTable() {
  tableBody.innerHTML = "";
  entries.forEach((e, idx) => {
    const tr = document.createElement("tr");
    if ((e.confidence ?? 0) < 0.85) tr.classList.add("low-conf");

    tr.innerHTML = `
      <td>${idx+1}</td>
      <td><input value="${e.word || ""}" data-idx="${idx}" data-key="word"/></td>
      <td><input value="${e.corrected || ""}" data-idx="${idx}" data-key="corrected"/></td>
      <td><textarea rows="2" data-idx="${idx}" data-key="meaning">${e.meaning || ""}</textarea></td>
      <td>${e.confidence != null ? e.confidence.toFixed(2) : "-"}</td>
      <td><button class="del" data-idx="${idx}">삭제</button></td>
    `;
    tableBody.appendChild(tr);
  });

  tableBody.querySelectorAll("input, textarea").forEach(el => {
    el.addEventListener("input", (ev) => {
      const i = parseInt(ev.target.dataset.idx, 10);
      const k = ev.target.dataset.key;
      entries[i][k] = ev.target.value;
    });
  });
  tableBody.querySelectorAll("button.del").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      const i = parseInt(ev.target.dataset.idx, 10);
      entries.splice(i, 1);
      renderTable();
    });
  });
}

// ---- Dedupe ----
btnDedupe.addEventListener("click", () => {
  const map = new Map();
  for (const e of entries) {
    const key = (e.corrected || e.word || "").toLowerCase();
    if (!key) continue;
    if (!map.has(key)) map.set(key, {...e});
    else {
      const prev = map.get(key);
      map.set(key, {
        word: prev.word,
        corrected: prev.corrected,
        meaning: prev.meaning || e.meaning,
        confidence: Math.max(prev.confidence ?? 0, e.confidence ?? 0)
      });
    }
  }
  entries = Array.from(map.values());
  renderTable();
});

// ---- Fill meanings (manual trigger) ----
btnFill.addEventListener("click", async () => {
  for (const e of entries) {
    if (!e.meaning) {
      try {
        const def = await fetchDefinitionEN(e.corrected || e.word);
        const meaning = def?.meaning || "";
        if (meaning) {
          const ko = await translateToKO(meaning).catch(()=>null);
          e.meaning = ko || `${meaning} (번역 실패: 직접 수정)`;
        }
      } catch {}
    }
  }
  renderTable();
});

// ---- CSV / Print / PDF ----
btnExport.addEventListener("click", () => {
  if (!entries.length) return alert("데이터가 없습니다.");
  const rows = [["word","corrected","meaning(ko)","confidence"],
    ...entries.map(e => [e.word, e.corrected, e.meaning, e.confidence ?? ""])];
  const csv = rows.map(r => r.map(v => `"${(v||"").toString().replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "danwojoopjoop_accuracy.csv"; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
});

btnPrint.addEventListener("click", () => window.print());

btnPdf.addEventListener("click", () => {
  if (!entries.length) return alert("데이터가 없습니다.");
  const layout = document.querySelector("input[name='layout']:checked").value;
  if (layout === "list") return savePdfList();
  if (layout === "flash") return savePdfFlashcards();
  if (layout === "worksheet") return savePdfWorksheet();
});

function savePdfList() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setFontSize(14);
  doc.text("단어줍줍 · 정확도 모드 – Word List", 40, 40);
  const head = [["#", "Word", "Corrected", "Meaning(KO)", "Confidence"]];
  const body = entries.map((e, idx) => [idx+1, e.word, e.corrected, e.meaning, e.confidence ?? ""]);
  doc.autoTable({
    head, body, startY: 60, styles: { fontSize: 10, cellPadding: 6 },
    headStyles: { fillColor: [91, 141, 239] }
  });
  doc.save("danwojoopjoop_accuracy_list.pdf");
}

function savePdfFlashcards() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const cardW = (pageW - 80 - 20) / 2;
  const cardH = 120;
  let x = 40, y = 40;
  entries.forEach((e) => {
    doc.roundedRect(x, y, cardW, cardH, 8, 8);
    doc.setFontSize(16);
    doc.text(e.corrected || e.word || "", x + 16, y + 30);
    doc.setFontSize(12);
    doc.text((e.meaning || "").toString().slice(0, 120), x + 16, y + 56, { maxWidth: cardW - 32 });
    x += cardW + 20;
    if (x + cardW > pageW - 40) { x = 40; y += cardH + 20; }
    if (y + cardH > pageH - 40) { doc.addPage(); x = 40; y = 40; }
  });
  doc.save("danwojoopjoop_accuracy_flashcards.pdf");
}

function savePdfWorksheet() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setFontSize(14);
  doc.text("단어줍줍 Worksheet: Fill in the meanings", 40, 40);
  const rows = entries.map((e, i) => [i+1, e.corrected || e.word, "______________"]);
  doc.autoTable({
    head: [["#", "Word", "Meaning(blank)"]],
    body: rows,
    startY: 60,
    styles: { fontSize: 12, cellPadding: 8 },
    headStyles: { fillColor: [91, 141, 239] }
  });
  doc.save("danwojoopjoop_accuracy_worksheet.pdf");
}

// ---- Dictionary (EN→def) + Basic translation to KO ----
async function fetchDefinitionEN(word) {
  const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  if (!r.ok) throw new Error("dict error " + r.status);
  const j = await r.json();
  const m = j?.[0]?.meanings?.[0];
  return {
    pos: m?.partOfSpeech || "",
    meaning: m?.definitions?.[0]?.definition || "",
    example: m?.definitions?.[0]?.example || ""
  };
}
async function translateToKO(text) {
  const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ko`);
  if (!r.ok) throw new Error("trans error " + r.status);
  const j = await r.json();
  return j?.responseData?.translatedText?.trim();
}
