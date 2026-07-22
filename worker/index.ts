/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, PDFImage, rgb } from "pdf-lib";

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
    if (url.pathname === "/api/oven-report/pdf" && request.method === "POST") {
      return createOvenPhotoReport(request, env);
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
  act: { date: string; contractor: string; customer: string; objectCode: string; pizzeriaAddress: string; serviceType: string; ovenModel: string; ovenPosition: string; serialNumber: string; technicianName: string };
  checklist: Array<{ number: string; title: string; done: boolean; comment: string }>;
  entries?: { remarks?: string[]; recommendations?: string[]; completedWorks?: string[] };
};

async function createOvenActPdf(request: Request, env: Env) {
  try {
    const payload = await request.json() as PdfPayload;
    if (!payload.act?.date || !payload.act?.objectCode || !payload.act?.ovenModel || !payload.act?.ovenPosition || !payload.act?.technicianName) return Response.json({ error: "Заполнены не все данные акта" }, { status: 400 });
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
    text(`${payload.act.pizzeriaAddress} (${payload.act.objectCode})`, 160, 105, 5.8);
    text(`${payload.act.ovenModel} (${payload.act.ovenPosition})`, 160, 136);
    text(payload.act.serialNumber || "не указан", 160, 148);

    drawMaintenanceTable(page, font, payload.checklist);

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

    if (needsEntriesAppendix) addActEntriesPage(pdf, font, entries);
    const bytes = await pdf.save();
    const fileCode = payload.act.objectCode.replace(/[^a-zA-Zа-яА-Я0-9-]+/g, "-");
    return new Response(bytes, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="oven-act-${fileCode}-${payload.act.date}.pdf"`, "cache-control": "no-store" } });
  } catch (error) {
    console.error("Failed to generate oven act PDF", error);
    return Response.json({ error: "Не удалось сформировать PDF" }, { status: 500 });
  }
}

type ReportMetadata = {
  act: PdfPayload["act"];
  entries?: { remarks?: string[]; recommendations?: string[]; completedWorks?: string[] };
  photos?: Array<{ key: string; title: string; required: boolean }>;
};

const REQUIRED_REPORT_PHOTOS = ["oven-overview", "heaters-before", "heaters-after", "chain", "plugs-before", "plugs-after", "conduit-oven", "conduit-socket", "ground", "controls-before", "controls-after", "contacts", "filters", "heater-load", "heater-resistance", "phase-voltage", "psu-voltage"];

async function createOvenPhotoReport(request: Request, env: Env) {
  try {
    const formData = await request.formData();
    const metadataValue = formData.get("metadata");
    if (typeof metadataValue !== "string") return Response.json({ error: "Не переданы данные фотоотчёта" }, { status: 400 });
    const metadata = JSON.parse(metadataValue) as ReportMetadata;
    if (!metadata.act?.date || !metadata.act?.objectCode || !metadata.act?.ovenModel || !metadata.act?.ovenPosition || !metadata.act?.technicianName) return Response.json({ error: "Сначала заполните данные акта" }, { status: 400 });

    const photoFiles = new Map<string, File>();
    let totalBytes = 0;
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("photo:") || typeof value === "string") continue;
      const photoKey = key.slice(6);
      if (!/^[-a-z0-9]+$/.test(photoKey) || value.size > 4_000_000) return Response.json({ error: "Одна из фотографий слишком большая" }, { status: 413 });
      totalBytes += value.size;
      photoFiles.set(photoKey, value);
    }
    if (totalBytes > 60_000_000) return Response.json({ error: "Общий размер фотографий слишком большой" }, { status: 413 });
    if (REQUIRED_REPORT_PHOTOS.some((key) => !photoFiles.has(key))) return Response.json({ error: "Добавлены не все обязательные фотографии" }, { status: 400 });

    const fetchAsset = (path: string) => env.ASSETS ? env.ASSETS.fetch(new Request(new URL(path, request.url))) : fetch(new Request(new URL(path, request.url)));
    const fontResponse = await fetchAsset("/fonts/DejaVuSans.ttf");
    if (!fontResponse.ok) return Response.json({ error: "Шрифт отчёта недоступен" }, { status: 500 });
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(await fontResponse.arrayBuffer(), { subset: true });
    const pageSize: [number, number] = [595.92, 842.88];
    let page = pdf.addPage(pageSize);
    let y = 786;
    page.drawText("ФОТООТЧЁТ", { x: 48, y, size: 10, font, color: rgb(0.04, 0.42, 0.57) });
    y -= 31;
    page.drawText("Техническое обслуживание печи", { x: 48, y, size: 21, font, color: rgb(0.04, 0.13, 0.18) });
    y -= 44;
    const [year, month, day] = metadata.act.date.split("-");
    const metaRows = [
      ["Объект", `${metadata.act.pizzeriaAddress} (${metadata.act.objectCode})`],
      ["Дата", [day, month, year].filter(Boolean).join(".")],
      ["Печь", `${metadata.act.ovenModel} (${metadata.act.ovenPosition})`],
      ["Инженер", metadata.act.technicianName],
      ["Заказчик", metadata.act.customer || "Не указан"],
    ];
    for (const [label, value] of metaRows) {
      page.drawText(label, { x: 48, y, size: 7.5, font, color: rgb(0.35, 0.46, 0.52) });
      const lines = wrapText(value, font, 10, 390);
      lines.forEach((line, index) => page.drawText(line, { x: 148, y: y - index * 13, size: 10, font, color: rgb(0.04, 0.1, 0.14) }));
      y -= Math.max(25, lines.length * 13 + 8);
    }
    y -= 7;
    const entries = {
      remarks: normalizeEntries(metadata.entries?.remarks),
      recommendations: normalizeEntries(metadata.entries?.recommendations),
      completedWorks: normalizeEntries(metadata.entries?.completedWorks),
    };
    ({ page, y } = drawReportList(pdf, page, font, y, "Работы сверх чек-листа", entries.completedWorks, pageSize));
    ({ page, y } = drawReportList(pdf, page, font, y, "Рекомендуемые работы", entries.recommendations, pageSize));
    ({ page, y } = drawReportList(pdf, page, font, y, "Замечания", entries.remarks, pageSize));

    const photoMetadata = Array.isArray(metadata.photos) ? metadata.photos.filter((item) => photoFiles.has(item.key)).slice(0, 30) : [];
    for (let index = 0; index < photoMetadata.length; index += 2) {
      const photoPage = pdf.addPage(pageSize);
      photoPage.drawText("Фотоотчёт по ТО печи", { x: 48, y: 798, size: 12, font, color: rgb(0.04, 0.13, 0.18) });
      for (let slotIndex = 0; slotIndex < 2; slotIndex += 1) {
        const item = photoMetadata[index + slotIndex];
        if (!item) break;
        const file = photoFiles.get(item.key)!;
        let photo: PDFImage;
        const bytes = await file.arrayBuffer();
        if (file.type === "image/png") photo = await pdf.embedPng(bytes);
        else photo = await pdf.embedJpg(bytes);
        const blockTop = slotIndex === 0 ? 758 : 390;
        const title = String(item.title || item.key).slice(0, 180);
        const titleLines = wrapText(title, font, 9, 500).slice(0, 2);
        titleLines.forEach((line, lineIndex) => photoPage.drawText(line, { x: 48, y: blockTop - lineIndex * 12, size: 9, font, color: rgb(0.05, 0.13, 0.17) }));
        const maxWidth = 500;
        const maxHeight = 300;
        const scale = Math.min(maxWidth / photo.width, maxHeight / photo.height);
        const width = photo.width * scale;
        const height = photo.height * scale;
        const imageTop = blockTop - titleLines.length * 12 - 10;
        photoPage.drawRectangle({ x: 47, y: imageTop - maxHeight - 1, width: 502, height: maxHeight + 2, borderWidth: 0.5, borderColor: rgb(0.82, 0.86, 0.88) });
        photoPage.drawImage(photo, { x: 48 + (maxWidth - width) / 2, y: imageTop - height, width, height });
      }
    }

    const pages = pdf.getPages();
    pages.forEach((reportPage, index) => reportPage.drawText(`${index + 1} / ${pages.length}`, { x: 510, y: 22, size: 7, font, color: rgb(0.42, 0.5, 0.54) }));
    const bytes = await pdf.save();
    const code = metadata.act.objectCode.replace(/[^a-zA-Zа-яА-Я0-9-]+/g, "-");
    return new Response(bytes, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="oven-photo-report-${code}-${metadata.act.date}.pdf"`, "cache-control": "no-store" } });
  } catch (error) {
    console.error("Failed to generate oven photo report", error);
    return Response.json({ error: "Не удалось сформировать фотоотчёт" }, { status: 500 });
  }
}

function drawReportList(pdf: PDFDocument, initialPage: ReturnType<PDFDocument["getPages"]>[number], font: PDFFont, initialY: number, title: string, values: string[], pageSize: [number, number]) {
  let page = initialPage;
  let y = initialY;
  if (y < 110) { page = pdf.addPage(pageSize); y = 790; }
  page.drawText(title, { x: 48, y, size: 11, font, color: rgb(0.04, 0.13, 0.18) });
  y -= 22;
  if (!values.length) {
    page.drawText("Не указаны", { x: 48, y, size: 8.5, font, color: rgb(0.4, 0.48, 0.52) });
    return { page, y: y - 24 };
  }
  for (const [index, value] of values.entries()) {
    const lines = wrapText(`${index + 1}. ${value}`, font, 8.5, 495);
    if (y - lines.length * 12 < 48) { page = pdf.addPage(pageSize); y = 790; }
    lines.forEach((line) => { page.drawText(line, { x: 48, y, size: 8.5, font, color: rgb(0.06, 0.1, 0.13) }); y -= 12; });
    y -= 5;
  }
  return { page, y: y - 10 };
}

function drawMaintenanceTable(page: ReturnType<PDFDocument["getPages"]>[number], font: PDFFont, items: PdfPayload["checklist"]) {
  const { height } = page.getSize();
  const x = 50;
  const top = 155;
  const maxBottom = 501;
  const widths = [34, 288, 55, 119];
  const tableWidth = widths.reduce((sum, width) => sum + width, 0);
  const titleHeight = 14;
  const headerHeight = 20;
  let fontSize = 5.25;
  let leading = 6.15;
  let rows: Array<{ work: string[]; comment: string[]; height: number }> = [];

  for (let attempt = 0; attempt < 8; attempt += 1) {
    rows = items.map((item) => {
      const work = wrapText(item.title, font, fontSize, widths[1] - 8);
      const comment = item.comment.trim() ? wrapText(item.comment.trim(), font, fontSize, widths[3] - 8) : [];
      return { work, comment, height: Math.max(11, Math.max(work.length, comment.length, 1) * leading + 4) };
    });
    const totalHeight = titleHeight + headerHeight + rows.reduce((sum, row) => sum + row.height, 0);
    if (top + totalHeight <= maxBottom || fontSize <= 4.2) break;
    fontSize -= 0.15;
    leading -= 0.17;
  }

  const baseTotalHeight = titleHeight + headerHeight + rows.reduce((sum, row) => sum + row.height, 0);
  const extraPerRow = Math.max(0, Math.min(2.2, (maxBottom - top - baseTotalHeight) / rows.length));
  if (extraPerRow > 0) rows = rows.map((row) => ({ ...row, height: row.height + extraPerRow }));
  const totalHeight = titleHeight + headerHeight + rows.reduce((sum, row) => sum + row.height, 0);
  page.drawRectangle({ x, y: height - maxBottom, width: tableWidth, height: maxBottom - top, color: rgb(1, 1, 1) });
  const line = (x1: number, top1: number, x2: number, top2: number, thickness = 0.45) => page.drawLine({ start: { x: x1, y: height - top1 }, end: { x: x2, y: height - top2 }, thickness, color: rgb(0.05, 0.07, 0.08) });
  const centered = (value: string, left: number, cellWidth: number, rowTop: number, rowHeight: number, size = 5.4) => {
    const textWidth = font.widthOfTextAtSize(value, size);
    page.drawText(value, { x: left + Math.max(3, (cellWidth - textWidth) / 2), y: height - rowTop - (rowHeight + size) / 2 + 1.2, size, font, color: rgb(0.04, 0.06, 0.08) });
  };

  line(x, top, x + tableWidth, top, 0.7);
  line(x, top + titleHeight, x + tableWidth, top + titleHeight);
  centered("Перечень работ по техническому обслуживанию", x, tableWidth, top, titleHeight, 6.2);
  const headerTop = top + titleHeight;
  const columns = [x, x + widths[0], x + widths[0] + widths[1], x + widths[0] + widths[1] + widths[2], x + tableWidth];
  for (const columnX of columns) line(columnX, headerTop, columnX, top + totalHeight);
  line(x, headerTop + headerHeight, x + tableWidth, headerTop + headerHeight, 0.7);
  centered("№", columns[0], widths[0], headerTop, headerHeight, 5.6);
  centered("Работы", columns[1], widths[1], headerTop, headerHeight, 5.6);
  centered("Выполнено", columns[2], widths[2], headerTop, headerHeight, 5.2);
  centered("Комментарий", columns[3], widths[3], headerTop, headerHeight, 5.2);

  let rowTop = headerTop + headerHeight;
  items.forEach((item, index) => {
    const row = rows[index];
    centered(item.number, columns[0], widths[0], rowTop, row.height, fontSize);
    row.work.forEach((value, lineIndex) => page.drawText(value, { x: columns[1] + 4, y: height - rowTop - 3 - fontSize - lineIndex * leading, size: fontSize, font, color: rgb(0.04, 0.06, 0.08) }));
    row.comment.forEach((value, lineIndex) => page.drawText(value, { x: columns[3] + 4, y: height - rowTop - 3 - fontSize - lineIndex * leading, size: fontSize, font, color: rgb(0.04, 0.06, 0.08) }));
    const boxSize = 7.5;
    const boxX = columns[2] + (widths[2] - boxSize) / 2;
    const boxY = height - rowTop - (row.height + boxSize) / 2;
    page.drawRectangle({ x: boxX, y: boxY, width: boxSize, height: boxSize, borderWidth: 0.55, borderColor: rgb(0.35, 0.4, 0.42) });
    page.drawText("✓", { x: boxX + 0.6, y: boxY + 0.4, size: 6.7, font, color: rgb(0.02, 0.38, 0.24) });
    rowTop += row.height;
    line(x, rowTop, x + tableWidth, rowTop);
  });
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
