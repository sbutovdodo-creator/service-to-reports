/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, rgb } from "pdf-lib";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PRIVATE_FILES: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/oven-act/pdf" && request.method === "POST") {
      return createOvenActPdf(request, env);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

type PdfPayload = {
  act: { date: string; contractor: string; customer: string; objectCode: string; pizzeriaAddress: string; serviceType: string; ovenModel: string; serialNumber: string; technicianName: string };
  checklist: Array<{ number: string; title: string; done: boolean; comment: string }>;
  entries?: { remarks?: string[]; recommendations?: string[]; completedWorks?: string[] };
};

async function createOvenActPdf(request: Request, env: Env) {
  try {
    const payload = await request.json() as PdfPayload;
    if (!payload.act?.date || !payload.act?.objectCode || !payload.act?.ovenModel || !payload.act?.technicianName) return Response.json({ error: "Заполнены не все данные акта" }, { status: 400 });
    if (!Array.isArray(payload.checklist) || payload.checklist.length !== 22 || payload.checklist.some((item) => !item.done)) return Response.json({ error: "Не отмечены все пункты чек-листа" }, { status: 400 });

    const fetchAsset = (path: string) => env.ASSETS
      ? env.ASSETS.fetch(new Request(new URL(path, request.url)))
      : fetch(new Request(new URL(path, request.url)));
    const [templateResponse, fontResponse, stampObject] = await Promise.all([
      fetchAsset("/oven-act-template.pdf"),
      fetchAsset("/fonts/DejaVuSans.ttf"),
      env.PRIVATE_FILES.get("director-stamp-signature.png"),
    ]);
    if (!templateResponse.ok || !fontResponse.ok) return Response.json({ error: "Шаблон акта недоступен" }, { status: 500 });
    if (!stampObject) return Response.json({ error: "Печать и подпись ещё не настроены" }, { status: 503 });

    const pdf = await PDFDocument.load(await templateResponse.arrayBuffer());
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(await fontResponse.arrayBuffer(), { subset: true });
    const stamp = await pdf.embedPng(await stampObject.arrayBuffer());
    const page = pdf.getPages()[0];
    const { height } = page.getSize();
    const text = (value: string, x: number, top: number, size = 6.2) => page.drawText(value || "—", { x, y: height - top - size, size, font, color: rgb(0.04, 0.08, 0.1), maxWidth: 382 });

    const [year, month, day] = payload.act.date.split("-");
    text([day, month, year].filter(Boolean).join("."), 160, 69);
    text(payload.act.customer || "Заказчик будет указан позднее", 160, 93);
    text(`${payload.act.objectCode}, ${payload.act.pizzeriaAddress}`, 160, 105, 5.8);
    text(payload.act.ovenModel, 160, 136);
    text(payload.act.serialNumber || "не указан", 160, 148);

    const checkboxTops = [202.69, 219.77, 236.85, 249.95, 263.04, 276.14, 289.23, 302.33, 315.42, 328.52, 341.61, 354.71, 367.8, 384.88, 401.4, 413.92, 426.45, 439.54, 452.64, 465.16, 477.69, 490.21];
    payload.checklist.forEach((item, index) => {
      const top = checkboxTops[index];
      page.drawText("✓", { x: 432.2, y: height - top - 8.8, size: 8.4, font, color: rgb(0.02, 0.38, 0.24) });
      if (item.comment.trim()) {
        const short = item.comment.trim().length > 26 ? `${item.comment.trim().slice(0, 25)}…` : item.comment.trim();
        page.drawText(short, { x: 466, y: height - top - 6.8, size: 4.1, font, color: rgb(0.08, 0.1, 0.12), maxWidth: 78 });
      }
    });

    const entries = {
      remarks: normalizeEntries(payload.entries?.remarks),
      recommendations: normalizeEntries(payload.entries?.recommendations),
      completedWorks: normalizeEntries(payload.entries?.completedWorks),
    };
    const actRows = [
      { values: entries.remarks, tops: [515, 527, 539] },
      { values: entries.recommendations, tops: [564, 576, 588] },
      { values: entries.completedWorks, tops: [613, 625, 637] },
    ];
    let needsEntriesAppendix = false;
    for (const group of actRows) {
      if (group.values.length > 3) needsEntriesAppendix = true;
      group.values.slice(0, 3).forEach((value, index) => {
        if (font.widthOfTextAtSize(value, 5.6) > 410) needsEntriesAppendix = true;
        page.drawText(fitTextToWidth(value, font, 5.6, 410), { x: 160, y: height - group.tops[index] - 5.6, size: 5.6, font, color: rgb(0.04, 0.08, 0.1) });
      });
    }

    text("Пахомов А.В.", 160, 741, 6.2);
    const stampScale = Math.min(148 / stamp.width, 92 / stamp.height);
    page.drawImage(stamp, { x: 345, y: 59, width: stamp.width * stampScale, height: stamp.height * stampScale });

    const comments = payload.checklist.filter((item) => item.comment.trim());
    if (comments.length) addCommentsPage(pdf, font, comments);
    if (needsEntriesAppendix) addActEntriesPage(pdf, font, entries);
    const bytes = await pdf.save();
    const fileCode = payload.act.objectCode.replace(/[^a-zA-Zа-яА-Я0-9-]+/g, "-");
    return new Response(bytes, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="oven-act-${fileCode}-${payload.act.date}.pdf"`, "cache-control": "no-store" } });
  } catch (error) {
    console.error("Failed to generate oven act PDF", error);
    return Response.json({ error: "Не удалось сформировать PDF" }, { status: 500 });
  }
}

function normalizeEntries(values?: string[]) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value).trim().slice(0, 1000)).filter(Boolean).slice(0, 20);
}

function fitTextToWidth(value: string, font: PDFFont, size: number, maxWidth: number) {
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  let shortened = value;
  while (shortened.length && font.widthOfTextAtSize(`${shortened}…`, size) > maxWidth) shortened = shortened.slice(0, -1);
  return `${shortened.trimEnd()}…`;
}

function addActEntriesPage(pdf: PDFDocument, font: PDFFont, entries: { remarks: string[]; recommendations: string[]; completedWorks: string[] }) {
  let page = pdf.addPage([595.92, 842.88]);
  let y = 795;
  page.drawText("Приложение к акту ТО печи", { x: 48, y, size: 15, font, color: rgb(0.04, 0.13, 0.18) });
  y -= 36;
  const groups = [
    ["Замечания", entries.remarks],
    ["Рекомендации", entries.recommendations],
    ["Выполненные работы", entries.completedWorks],
  ] as const;
  for (const [title, values] of groups) {
    if (!values.length) continue;
    if (y < 90) { page = pdf.addPage([595.92, 842.88]); y = 795; }
    page.drawText(title, { x: 48, y, size: 11, font, color: rgb(0.04, 0.13, 0.18) });
    y -= 22;
    for (const [index, value] of values.entries()) {
      const lines = wrapText(`${index + 1}. ${value}`, font, 8.5, 495);
      if (y - lines.length * 13 < 48) { page = pdf.addPage([595.92, 842.88]); y = 795; }
      for (const line of lines) { page.drawText(line, { x: 48, y, size: 8.5, font, color: rgb(0.06, 0.09, 0.12) }); y -= 13; }
      y -= 6;
    }
    y -= 10;
  }
}

function addCommentsPage(pdf: PDFDocument, font: PDFFont, comments: PdfPayload["checklist"]) {
  let page = pdf.addPage([595.92, 842.88]);
  let y = 795;
  page.drawText("Комментарии к чек-листу ТО печи", { x: 48, y, size: 15, font, color: rgb(0.04, 0.13, 0.18) });
  y -= 34;
  for (const item of comments) {
    const lines = wrapText(`${item.number}. ${item.title}: ${item.comment.trim()}`, font, 8.5, 495);
    if (y - lines.length * 13 < 48) {
      page = pdf.addPage([595.92, 842.88]);
      y = 795;
    }
    for (const line of lines) {
      page.drawText(line, { x: 48, y, size: 8.5, font, color: rgb(0.06, 0.09, 0.12) });
      y -= 13;
    }
    y -= 7;
  }
}

function wrapText(value: string, font: PDFFont, size: number, maxWidth: number) {
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) line = next;
    else { if (line) lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

export default worker;
