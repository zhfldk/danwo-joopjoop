
// Helpers
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const imageInput = $("#imageInput");
const dropzone = $("#dropzone");
const startBtn = $("#startOcrBtn");
const clearBtn = $("#clearBtn");
const minLenEl = $("#minLen");
const caseModeEl = $("#caseMode");
const meaningLangEl = $("#meaningLang");
const progress = $("#progress");
const progressBar = $("#progressBar");
const progressLabel = $("#progressLabel");

const tableBody = $("#wordTable tbody");
const fillBtn = $("#fillMeaningsBtn");
const dedupeBtn = $("#dedupeBtn");
const exportCsvBtn = $("#exportCsvBtn");
const printBtn = $("#printBtn");
const savePdfBtn = $("#savePdfBtn");

let ocrTexts = []; // Array of strings per image
let entries = [];  // { word, meaning, pos, example }

// Drag&Drop
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  const files = Array.from(e.dataTransfer.files || []);
  imageInput.files = new FileListItems(files);
});

function FileListItems(files) {
  const b = new ClipboardEvent("").clipboardData || new DataTransfer();
  for (const file of files) b.items.add(file);
  return b.files;
}

// OCR pipeline
startBtn.addEventListener("click", async () => {
  const files = Array.from(imageInput.files || []);
  if (!files.length) return alert("이미지를 선택해 주세요.");
  progress.classList.remove("hidden");
  progressLabel.textContent = "OCR 준비 중…";
  progressBar.style.width = "0%";

  entries = [];
  tableBody.innerHTML = "";

  for (let i=0; i<files.length; i++) {
    const file = files[i];
    progressLabel.textContent = `인식 중 (${i+1}/${files.length})…`;
    progressBar.style.width = `${Math.round(((i)/files.length)*100)}%`;

    const text = await ocrImage(file);
    ocrTexts.push(text);
    const parsed = parseTextToEntries(text);
    entries.push(...parsed);
    renderTable();
  }

  progressBar.style.width = "100%";
  progressLabel.textContent = "완료";
  setTimeout(()=>progress.classList.add("hidden"), 700);
});

clearBtn.addEventListener("click", () => {
  imageInput.value = "";
  ocrTexts = [];
  entries = [];
  tableBody.innerHTML = "";
  progress.classList.add("hidden");
});

async function ocrImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const { createWorker } = Tesseract;
        const worker = await createWorker("eng"); // English only by default
        const ret = await worker.recognize(reader.result);
        await worker.terminate();
        resolve(ret.data.text || "");
      } catch (e) { console.error(e); resolve(""); }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Parse text into entries (detect word-meaning if present)
function parseTextToEntries(text) {
  const minLen = parseInt(minLenEl.value || "2", 10);
  const caseMode = caseModeEl.value;
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  const results = [];
  for (let line of lines) {
    // common separators: "-", "—", ":", "=", "->", "\t"
    const pair = line.split(/\s[-—:=]\s|[-—:=]\s|\s[-—:=]|->|\t/);
    if (pair.length >= 2) {
      const word = normalizeWord(pair[0], caseMode);
      const meaning = pair.slice(1).join(" - ").trim();
      if (isValidWord(word, minLen)) {
        results.push({ word, meaning, pos: "", example: "" });
      }
    } else {
      // single token candidates (filter non-letters)
      const tokens = line.split(/[^A-Za-z']/).map(s => s.trim()).filter(Boolean);
      for (let token of tokens) {
        const word = normalizeWord(token, caseMode);
        if (isValidWord(word, minLen)) {
          results.push({ word, meaning: "", pos: "", example: "" });
        }
      }
    }
  }
  return results;
}

function normalizeWord(w, mode) {
  if (!w) return w;
  if (mode === "lower") return w.toLowerCase();
  if (mode === "upper") return w.toUpperCase();
  return w;
}

function isValidWord(w, minLen) {
  if (!w) return false;
  // Only alphabetical (allow apostrophes)
  if (!/^[A-Za-z][A-Za-z']*$/.test(w)) return false;
  return w.length >= minLen;
}

// Render table
function renderTable() {
  tableBody.innerHTML = "";
  entries.forEach((e, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx+1}</td>
      <td><input value="${e.word || ""}" data-idx="${idx}" data-key="word"/></td>
      <td><textarea rows="2" data-idx="${idx}" data-key="meaning">${e.meaning || ""}</textarea></td>
      <td><input value="${e.pos || ""}" data-idx="${idx}" data-key="pos"/></td>
      <td><textarea rows="2" data-idx="${idx}" data-key="example">${e.example || ""}</textarea></td>
      <td><button class="del" data-idx="${idx}">삭제</button></td>
    `;
    tableBody.appendChild(tr);
  });

  // edits
  tableBody.querySelectorAll("input, textarea").forEach(el => {
    el.addEventListener("input", (ev) => {
      const i = parseInt(ev.target.dataset.idx, 10);
      const k = ev.target.dataset.key;
      entries[i][k] = ev.target.value;
    });
  });
  // delete
  tableBody.querySelectorAll("button.del").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      const i = parseInt(ev.target.dataset.idx, 10);
      entries.splice(i, 1);
      renderTable();
    });
  });
}

// Dictionary fill for empty meanings
fillBtn.addEventListener("click", async () => {
  const lang = meaningLangEl.value; // en or ko
  const targets = entries
    .map((e, i) => ({...e, i}))
    .filter(e => !e.meaning || !e.meaning.trim());

  if (!targets.length) {
    alert("비어있는 뜻이 없습니다. 👍");
    return;
  }

  for (let t of targets) {
    try {
      const def = await fetchDefinition(t.word, lang);
      if (def) {
        entries[t.i].meaning = def.meaning;
        entries[t.i].pos = entries[t.i].pos || def.pos || "";
        entries[t.i].example = entries[t.i].example || def.example || "";
        renderTable();
      }
    } catch (e) {
      console.warn("사전 조회 실패:", t.word, e);
    }
  }
});

async function fetchDefinition(word, lang) {
  // Free dictionary: dictionaryapi.dev
  // en: return first definition (English)
  // ko: attempt a quick translation via unofficial endpoint (fallback: mark as "(의미)")
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!res.ok) throw new Error("dict not ok");
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    const first = data[0];
    let pos = "", meaning = "", example = "";
    if (first.meanings?.length) {
      pos = first.meanings[0].partOfSpeech || "";
      if (first.meanings[0].definitions?.length) {
        meaning = first.meanings[0].definitions[0].definition || "";
        example = first.meanings[0].definitions[0].example || "";
      }
    }
    if (!meaning) meaning = first.phonetic || "";

    if (lang === "ko" && meaning) {
      // quick & naive translation using a free endpoint is unreliable; we keep English meaning
      // and tag for manual translation. For production, integrate Papago/Kakao with user API key.
      meaning = meaning + " (번역 필요)";
    }
    return { pos, meaning, example };
  } catch (e) {
    return null;
  }
}

// Dedupe by word (keep first, merge empty fields)
dedupeBtn.addEventListener("click", () => {
  const map = new Map();
  for (const e of entries) {
    const key = e.word.toLowerCase();
    if (!map.has(key)) map.set(key, {...e});
    else {
      const prev = map.get(key);
      map.set(key, {
        word: prev.word,
        meaning: prev.meaning || e.meaning,
        pos: prev.pos || e.pos,
        example: prev.example || e.example
      });
    }
  }
  entries = Array.from(map.values());
  renderTable();
});

// Export CSV
exportCsvBtn.addEventListener("click", () => {
  if (!entries.length) return alert("데이터가 없습니다.");
  const rows = [["word","meaning","pos","example"], ...entries.map(e => [e.word, e.meaning, e.pos, e.example])];
  const csv = rows.map(r => r.map(v => `"${(v||"").replace(/"/g,'""')}"`).join(",")).join("\n");
  downloadText("wordbook.csv", csv);
});

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

// Print
printBtn.addEventListener("click", () => { window.print(); });

// Save PDF
savePdfBtn.addEventListener("click", () => {
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
  doc.text("Word List", 40, 40);
  const head = [["#", "Word", "Meaning", "POS", "Example"]];
  const body = entries.map((e, idx) => [idx+1, e.word, e.meaning, e.pos, e.example]);
  doc.autoTable({
    head, body, startY: 60, styles: { fontSize: 10, cellPadding: 6 },
    headStyles: { fillColor: [91, 141, 239] }
  });
  doc.save("wordbook_list.pdf");
}

function savePdfFlashcards() {
  // Two columns of cards per page
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const cardW = (pageW - 80 - 20) / 2; // margins 40, gutter 20
  const cardH = 120;
  let x = 40, y = 40;
  let count = 0;

  doc.setFontSize(16);
  entries.forEach((e, idx) => {
    doc.roundedRect(x, y, cardW, cardH, 8, 8);
    doc.text(e.word || "", x + 16, y + 30);
    doc.setFontSize(12);
    doc.text((e.meaning || "").toString().slice(0, 120), x + 16, y + 56, { maxWidth: cardW - 32 });
    // move
    x += cardW + 20;
    if (x + cardW > pageW - 40) { x = 40; y += cardH + 20; }
    if (y + cardH > pageH - 40) { doc.addPage(); x = 40; y = 40; }
    count++;
  });
  doc.save("wordbook_flashcards.pdf");
}

function savePdfWorksheet() {
  // Meaning blanks
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setFontSize(14);
  doc.text("Worksheet: Fill in the meanings", 40, 40);

  const rows = entries.map((e, i) => [i+1, e.word, "______________"]);
  doc.autoTable({
    head: [["#", "Word", "Meaning(blank)"]],
    body: rows,
    startY: 60,
    styles: { fontSize: 12, cellPadding: 8 },
    headStyles: { fillColor: [91, 141, 239] }
  });
  doc.save("wordbook_worksheet.pdf");
}
