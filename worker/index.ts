/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, PDFImage, rgb } from "pdf-lib";
import { AlignmentType, Document, Footer, Header, ImageRun, Packer, PageBreak, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from "docx";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PRIVATE_FILES: R2Bucket;
  APP_AUTH_LOGIN?: string;
  APP_AUTH_PASSWORD?: string;
  APP_AUTH_SECRET?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  MAIL_FROM?: string;
  MAIL_TO?: string;
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

    if (url.pathname === "/api/auth/login" && request.method === "POST") return login(request, env);
    if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout();
    const publicAsset = url.pathname === "/login.html" || url.pathname === "/rik-logo.png" || url.pathname === "/favicon.ico" || url.pathname === "/og.png" || url.pathname.startsWith("/assets/");
    if (!publicAsset && !(await isAuthenticated(request, env))) {
      if (url.pathname.startsWith("/api/")) return Response.json({ error: "Требуется вход" }, { status: 401 });
      const loginRequest = new Request(new URL("/login.html", request.url));
      return env.ASSETS ? env.ASSETS.fetch(loginRequest) : fetch(loginRequest);
    }

    if (url.pathname === "/api/oven-act/pdf" && request.method === "POST") {
      return createOvenActPdf(request, env);
    }
    if (url.pathname === "/api/oven-act/docx" && request.method === "POST") {
      return createOvenActDocx(request, env);
    }
    if (url.pathname === "/api/oven-report/pdf" && request.method === "POST") {
      return createOvenPhotoReport(request, env);
    }
    if (url.pathname === "/api/oven-report/docx" && request.method === "POST") {
      return createOvenPhotoReportDocx(request);
    }
    if (url.pathname === "/api/oven-package/part" && request.method === "POST") {
      return storeOvenPackagePart(request, env);
    }
    if (url.pathname === "/api/oven-package/finalize" && request.method === "POST") {
      return finalizeOvenPackage(request, env);
    }
    if (url.pathname === "/api/oven-report/email" && request.method === "POST") {
      return sendOvenReportEmail(request, env);
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

const AUTH_COOKIE = "riklab_session";

async function login(request: Request, env: Env) {
  if (!env.APP_AUTH_LOGIN || !env.APP_AUTH_PASSWORD || !env.APP_AUTH_SECRET) return Response.json({ error: "Вход ещё не настроен" }, { status: 503 });
  const body = await request.json().catch(() => ({})) as { login?: string; password?: string };
  if (body.login !== env.APP_AUTH_LOGIN || body.password !== env.APP_AUTH_PASSWORD) return Response.json({ error: "Неверный логин или пароль" }, { status: 401 });
  const token = await createAuthToken(env.APP_AUTH_SECRET);
  return new Response(null, { status: 204, headers: { "set-cookie": `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`, "cache-control": "no-store" } });
}

function logout() {
  return new Response(null, { status: 204, headers: { "set-cookie": `${AUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, "cache-control": "no-store" } });
}

async function isAuthenticated(request: Request, env: Env) {
  if (!env.APP_AUTH_SECRET) return false;
  const match = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
  if (!match) return false;
  return match[1] === await createAuthToken(env.APP_AUTH_SECRET);
}

async function createAuthToken(secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("riklab-service-v1")));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

async function createOvenActDocx(request: Request, env: Env) {
  try {
    const payload = await request.json() as PdfPayload;
    if (!payload.act?.date || !payload.act?.objectCode || !payload.act?.ovenModel || !payload.act?.ovenPosition || !payload.act?.technicianName) return Response.json({ error: "Заполнены не все данные акта" }, { status: 400 });
    if (!Array.isArray(payload.checklist) || payload.checklist.length !== 22 || payload.checklist.some((item) => !item.done)) return Response.json({ error: "Не отмечены все пункты чек-листа" }, { status: 400 });
    const stampObject = await env.PRIVATE_FILES.get("director-stamp-signature.png");
    if (!stampObject) return Response.json({ error: "Печать и подпись ещё не настроены" }, { status: 503 });
    const stampBytes = new Uint8Array(await stampObject.arrayBuffer());
    const stampSize = readImageDimensions(stampBytes, "image/png");
    const stampScale = Math.min(230 / stampSize.width, 115 / stampSize.height);
    const [year, month, day] = payload.act.date.split("-");
    const date = [day, month, year].filter(Boolean).join(".");
    const metaRows = [
      ["Дата", date],
      ["Заказчик", payload.act.customer || "Будет указан позднее"],
      ["Объект", `${payload.act.pizzeriaAddress} (${payload.act.objectCode})`],
      ["Оборудование", `${payload.act.ovenModel} (${payload.act.ovenPosition})`],
      ["Серийный номер", payload.act.serialNumber || "не указан"],
      ["Вид обслуживания", payload.act.serviceType || "Плановое ТО печи"],
    ];
    const metadataTable = new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2200, 7160],
      rows: metaRows.map(([label, value]) => new TableRow({ children: [
        new TableCell({ width: { size: 2200, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: "E8F3F7" }, children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, font: "Arial", size: 19, color: "355967" })] })] }),
        new TableCell({ width: { size: 7160, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: value, font: "Arial", size: 19, color: "102936" })] })] }),
      ] })),
    });
    const checklistRows = [
      new TableRow({ tableHeader: true, children: [
        actDocxCell("№", 600, true, "DCECF2", AlignmentType.CENTER),
        actDocxCell("Работы", 5700, true, "DCECF2", AlignmentType.CENTER),
        actDocxCell("Выполнено", 1100, true, "DCECF2", AlignmentType.CENTER),
        actDocxCell("Комментарий", 1960, true, "DCECF2", AlignmentType.CENTER),
      ] }),
      ...payload.checklist.map((item) => new TableRow({ cantSplit: true, children: [
        actDocxCell(item.number, 600, false, undefined, AlignmentType.CENTER),
        actDocxCell(item.title, 5700),
        actDocxCell(item.done ? "Да" : "Нет", 1100, false, undefined, AlignmentType.CENTER),
        actDocxCell(item.comment.trim() || "—", 1960),
      ] })),
    ];
    const checklistTable = new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [600, 5700, 1100, 1960], rows: checklistRows });
    const entries = {
      remarks: normalizeEntries(payload.entries?.remarks),
      recommendations: normalizeEntries(payload.entries?.recommendations),
      completedWorks: normalizeEntries(payload.entries?.completedWorks),
    };
    const children: Array<Paragraph | Table> = [
      new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "РИК ЛАБ", bold: true, color: "087A9F", size: 20, font: "Arial" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: "АКТ ВЫПОЛНЕННЫХ РАБОТ", bold: true, color: "102936", size: 30, font: "Arial" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 260 }, children: [new TextRun({ text: "Техническое обслуживание печи", size: 22, color: "355967", font: "Arial" })] }),
      metadataTable,
      new Paragraph({ spacing: { before: 260, after: 100 }, children: [new TextRun({ text: "Перечень выполненных работ", bold: true, size: 24, color: "087A9F", font: "Arial" })] }),
      checklistTable,
    ];
    addDocxList(children, "Замечания", entries.remarks);
    addDocxList(children, "Рекомендации", entries.recommendations);
    addDocxList(children, "Выполненные работы", entries.completedWorks);
    children.push(
      new Paragraph({ spacing: { before: 320, after: 80 }, children: [new TextRun({ text: "Исполнитель: Пахомов А.В.", bold: true, font: "Arial", size: 20, color: "102936" })] }),
      new Paragraph({ children: [new ImageRun({ type: "png", data: stampBytes, transformation: { width: Math.max(1, Math.round(stampSize.width * stampScale)), height: Math.max(1, Math.round(stampSize.height * stampScale)) } })] }),
    );
    const doc = new Document({
      creator: "ООО «РИК ЛАБ»",
      title: `Акт ТО печи ${payload.act.objectCode}`,
      description: "Редактируемый акт технического обслуживания печи",
      styles: { default: { document: { run: { font: "Arial", size: 20, color: "102936", language: { value: "ru-RU" } }, paragraph: { spacing: { after: 100, line: 252 } } } } },
      sections: [{
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 900, right: 1080, bottom: 900, left: 1080, header: 450, footer: 450 } } },
        headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `Акт ТО печи • ${payload.act.objectCode}`, size: 15, color: "688692", font: "Arial" })] })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "ООО «РИК ЛАБ» • редактируемый документ", size: 15, color: "688692", font: "Arial" })] })] }) },
        children,
      }],
    });
    const blob = await Packer.toBlob(doc);
    const code = payload.act.objectCode.replace(/[^a-zA-Zа-яА-Я0-9-]+/g, "-");
    return new Response(blob, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-disposition": `attachment; filename="oven-act-${code}-${payload.act.date}.docx"`, "cache-control": "no-store" } });
  } catch (error) {
    console.error("Failed to generate oven act DOCX", error);
    return Response.json({ error: "Не удалось сформировать редактируемый акт" }, { status: 500 });
  }
}

function actDocxCell(text: string, width: number, bold = false, fill?: string, alignment = AlignmentType.LEFT) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    ...(fill ? { shading: { type: ShadingType.CLEAR, fill } } : {}),
    children: [new Paragraph({ alignment, spacing: { after: 0, line: 220 }, children: [new TextRun({ text, bold, font: "Arial", size: 17, color: "102936" })] })],
  });
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

    const photoMetadata = Array.isArray(metadata.photos) ? metadata.photos.filter((item) => photoFiles.has(item.key)) : [];
    for (let index = 0; index < photoMetadata.length; index += 1) {
      const photoPage = pdf.addPage(pageSize);
      photoPage.drawText("Фотоотчёт по ТО печи", { x: 48, y: 798, size: 12, font, color: rgb(0.04, 0.13, 0.18) });
      const item = photoMetadata[index];
      const file = photoFiles.get(item.key)!;
      let photo: PDFImage;
      const bytes = await file.arrayBuffer();
      if (file.type === "image/png") photo = await pdf.embedPng(bytes);
      else photo = await pdf.embedJpg(bytes);
      const title = String(item.title || item.key).slice(0, 180);
      const titleLines = wrapText(title, font, 10, 500).slice(0, 2);
      titleLines.forEach((line, lineIndex) => photoPage.drawText(line, { x: 48, y: 762 - lineIndex * 14, size: 10, font, color: rgb(0.05, 0.13, 0.17) }));
      const imageTop = 762 - titleLines.length * 14 - 12;
      const maxWidth = 500;
      const maxHeight = imageTop - 50;
      const scale = Math.min(maxWidth / photo.width, maxHeight / photo.height);
      const width = photo.width * scale;
      const height = photo.height * scale;
      photoPage.drawRectangle({ x: 47, y: 43, width: 502, height: maxHeight + 2, borderWidth: 0.5, borderColor: rgb(0.82, 0.86, 0.88) });
      photoPage.drawImage(photo, { x: 48 + (maxWidth - width) / 2, y: 44 + (maxHeight - height) / 2, width, height });
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

async function createOvenPhotoReportDocx(request: Request) {
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

    const entries = {
      remarks: normalizeEntries(metadata.entries?.remarks),
      recommendations: normalizeEntries(metadata.entries?.recommendations),
      completedWorks: normalizeEntries(metadata.entries?.completedWorks),
    };
    const [year, month, day] = metadata.act.date.split("-");
    const metadataRows = [
      ["Объект", `${metadata.act.pizzeriaAddress} (${metadata.act.objectCode})`],
      ["Дата", [day, month, year].filter(Boolean).join(".")],
      ["Печь", `${metadata.act.ovenModel} (${metadata.act.ovenPosition})`],
      ["Инженер", metadata.act.technicianName],
      ["Заказчик", metadata.act.customer || "Не указан"],
    ];
    const children: Array<Paragraph | Table> = [
      new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: "ФОТООТЧЁТ", bold: true, color: "087A9F", size: 20, font: "Arial" })] }),
      new Paragraph({ spacing: { after: 300 }, children: [new TextRun({ text: "Техническое обслуживание печи", bold: true, color: "102936", size: 40, font: "Arial" })] }),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [2000, 7360],
        rows: metadataRows.map(([label, value]) => new TableRow({ children: [
          new TableCell({ width: { size: 2000, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: "E8F3F7" }, children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 20, font: "Arial", color: "355967" })] })] }),
          new TableCell({ width: { size: 7360, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: value, size: 20, font: "Arial", color: "102936" })] })] }),
        ] })),
      }),
    ];
    addDocxList(children, "Работы сверх чек-листа", entries.completedWorks);
    addDocxList(children, "Рекомендуемые работы", entries.recommendations);
    addDocxList(children, "Замечания", entries.remarks);

    const photoMetadata = Array.isArray(metadata.photos) ? metadata.photos.filter((item) => photoFiles.has(item.key)) : [];
    for (const [index, item] of photoMetadata.entries()) {
      const file = photoFiles.get(item.key)!;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const dimensions = readImageDimensions(bytes, file.type);
      const scale = Math.min(600 / dimensions.width, 750 / dimensions.height);
      children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(new Paragraph({ spacing: { after: 140 }, children: [new TextRun({ text: `${index + 1}. ${String(item.title || item.key).slice(0, 180)}`, bold: true, size: 24, font: "Arial", color: "102936" })] }));
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: file.type === "image/png" ? "png" : "jpg", data: bytes, transformation: { width: Math.max(1, Math.round(dimensions.width * scale)), height: Math.max(1, Math.round(dimensions.height * scale)) } })] }));
    }

    const doc = new Document({
      creator: "ООО «РИК ЛАБ»",
      title: `Фотоотчёт ТО печи ${metadata.act.objectCode}`,
      description: "Редактируемый фотоотчёт технического обслуживания печи на русском языке",
      styles: { default: { document: { run: { font: "Arial", size: 22, color: "102936", language: { value: "ru-RU" } }, paragraph: { spacing: { after: 120, line: 276 } } } } },
      sections: [{
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080, header: 500, footer: 500 } } },
        headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `РИК ЛАБ • ТО печи ${metadata.act.objectCode}`, size: 16, color: "688692", font: "Arial" })] })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Редактируемый фотоотчёт", size: 16, color: "688692", font: "Arial" })] })] }) },
        children,
      }],
    });
    const blob = await Packer.toBlob(doc);
    const code = metadata.act.objectCode.replace(/[^a-zA-Zа-яА-Я0-9-]+/g, "-");
    return new Response(blob, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-disposition": `attachment; filename="oven-photo-report-${code}-${metadata.act.date}.docx"`, "cache-control": "no-store" } });
  } catch (error) {
    console.error("Failed to generate oven photo report DOCX", error);
    return Response.json({ error: "Не удалось сформировать редактируемый отчёт" }, { status: 500 });
  }
}

const PACKAGE_PARTS = {
  "act-pdf": { key: "act.pdf", type: "application/pdf" },
  "act-docx": { key: "act.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  "report-pdf": { key: "report.pdf", type: "application/pdf" },
  "report-docx": { key: "report.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
} as const;

function validPackageId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9-]{20,64}$/.test(value);
}

async function storeOvenPackagePart(request: Request, env: Env) {
  try {
    const body = await request.formData();
    const packageId = body.get("packageId");
    const kind = body.get("kind");
    if (!validPackageId(packageId) || typeof kind !== "string" || !(kind in PACKAGE_PARTS)) return Response.json({ error: "Некорректный идентификатор комплекта" }, { status: 400 });
    const part = PACKAGE_PARTS[kind as keyof typeof PACKAGE_PARTS];
    const endpoint = new URL(request.url);
    let generated: Response;
    let baseName: string;
    if (kind.startsWith("act-")) {
      const actPayload = body.get("actPayload");
      if (typeof actPayload !== "string") return Response.json({ error: "Не переданы данные акта" }, { status: 400 });
      const parsed = JSON.parse(actPayload) as PdfPayload;
      baseName = `${parsed.act.objectCode}-${parsed.act.ovenPosition}-${parsed.act.date}`;
      const actRequest = new Request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: actPayload });
      generated = kind === "act-pdf" ? await createOvenActPdf(actRequest, env) : await createOvenActDocx(actRequest, env);
    } else {
      const metadata = body.get("metadata");
      if (typeof metadata !== "string") return Response.json({ error: "Не переданы данные фотоотчёта" }, { status: 400 });
      const parsed = JSON.parse(metadata) as ReportMetadata;
      baseName = `${parsed.act.objectCode}-${parsed.act.ovenPosition}-${parsed.act.date}`;
      const reportRequest = new Request(endpoint, { method: "POST", body });
      generated = kind === "report-pdf" ? await createOvenPhotoReport(reportRequest, env) : await createOvenPhotoReportDocx(reportRequest);
    }
    if (!generated.ok) return generated;
    const extension = kind.endsWith("pdf") ? "pdf" : "docx";
    const label = kind.startsWith("act-") ? "Акт-ТО-печи" : "Фотоотчёт-ТО-печи";
    const filename = `${label}-${baseName}.${extension}`;
    const blob = await generated.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await env.PRIVATE_FILES.put(`oven-packages/${packageId}/${part.key}`, bytes, { customMetadata: { filename, type: part.type, crc32: crc32(bytes).toString(16), size: String(bytes.length) } });
    return Response.json({ ok: true, size: blob.size });
  } catch (error) {
    console.error("Failed to store oven package part", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "Не удалось сохранить часть комплекта" }, { status: 500 });
  }
}

async function finalizeOvenPackage(request: Request, env: Env) {
  try {
    const input = await request.json() as { packageId?: string; metadata?: EmailMetadata };
    if (!validPackageId(input.packageId) || !input.metadata) return Response.json({ error: "Некорректные данные комплекта" }, { status: 400 });
    const parts = Object.values(PACKAGE_PARTS);
    const entries: StoredZipEntry[] = [];
    for (const part of parts) {
      const key = `oven-packages/${input.packageId}/${part.key}`;
      const object = await env.PRIVATE_FILES.head(key);
      if (!object) return Response.json({ error: "Комплект сформирован не полностью. Нажмите кнопку ещё раз" }, { status: 409 });
      entries.push({ key, filename: object.customMetadata?.filename || part.key, size: Number(object.customMetadata?.size || object.size), crc: Number.parseInt(object.customMetadata?.crc32 || "0", 16) >>> 0 });
    }
    const objectCode = String(input.metadata.objectCode || "отчёт").replace(/[^a-zA-Zа-яА-Я0-9-]+/g, "-");
    const date = String(input.metadata.date || "без-даты");
    const archiveName = `ТО-печи-${objectCode}-${date}.zip`;
    const archiveSize = storedZipSize(entries);
    await sendArchiveEmail(input.metadata, createStoredZipStream(env, entries), archiveName, env);
    const fallbackName = safeAsciiFilename(archiveName, "application/zip");
    return new Response(createStoredZipStream(env, entries), { headers: { "content-type": "application/zip", "content-length": String(archiveSize), "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(archiveName)}`, "cache-control": "no-store", "x-mail-recipient": env.MAIL_TO || "" } });
  } catch (error) {
    console.error("Failed to finalize oven package", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "Не удалось упаковать и отправить документы" }, { status: 500 });
  }
}

type EmailMetadata = {
  objectCode?: string;
  date?: string;
  serviceType?: string;
  pizzeriaAddress?: string;
  ovenModel?: string;
  ovenPosition?: string;
  technicianName?: string;
};

async function sendOvenReportEmail(request: Request, env: Env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.MAIL_FROM || !env.MAIL_TO) {
    return Response.json({ error: "Отправка почты ещё не настроена" }, { status: 503 });
  }

  try {
    const formData = await request.formData();
    const metadataValue = formData.get("metadata");
    const act = formData.get("act");
    const actDocx = formData.get("actDocx");
    const reportPdf = formData.get("reportPdf");
    const reportDocx = formData.get("reportDocx");
    if (typeof metadataValue !== "string") return Response.json({ error: "Не переданы данные отчёта" }, { status: 400 });
    if (!(act instanceof File) || !(actDocx instanceof File) || !(reportPdf instanceof File) || !(reportDocx instanceof File)) {
      return Response.json({ error: "Сначала сформируйте полный комплект документов" }, { status: 400 });
    }

    const metadata = JSON.parse(metadataValue) as EmailMetadata;
    const clean = (value: unknown, fallback: string) => String(value || fallback).replace(/[\r\n]+/g, " ").trim().slice(0, 180);
    const objectCode = clean(metadata.objectCode, "без номера");
    const date = clean(metadata.date, "без даты");
    const serviceType = clean(metadata.serviceType, "ТО печи");
    const pizzeriaAddress = clean(metadata.pizzeriaAddress, "адрес не указан");
    const ovenModel = clean(metadata.ovenModel, "модель не указана");
    const ovenPosition = clean(metadata.ovenPosition, "положение не указано");
    const technicianName = clean(metadata.technicianName, "не указан");
    const sourceFiles = [act, actDocx, reportPdf, reportDocx];
    const totalBytes = sourceFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > 34_000_000) return Response.json({ error: "Общий размер четырёх файлов превышает 34 МБ" }, { status: 413 });
    if (sourceFiles.some((file) => !isAllowedEmailAttachment(file))) {
      return Response.json({ error: "К письму можно приложить только PDF и DOCX" }, { status: 400 });
    }
    const archiveName = `ТО-печи-${objectCode}-${date}.zip`;
    const archiveBytes = await createStoredZip(sourceFiles);
    const archive = new File([archiveBytes], archiveName, { type: "application/zip" });

    const boundary = `riklab-${crypto.randomUUID()}`;
    const displayDate = formatRussianDate(date);
    const subject = `${objectCode} — ${serviceType} — ${displayDate}`;
    const body = [
      "Документы по техническому обслуживанию печи сформированы на сайте РИК ЛАБ.",
      "",
      `Объект: ${objectCode}`,
      `Адрес: ${pizzeriaAddress}`,
      `Вид ТО: ${serviceType}`,
      `Дата: ${displayDate}`,
      `Печь: ${ovenModel} (${ovenPosition})`,
      `Инженер: ${technicianName}`,
      "",
      "Во вложении ZIP-архив: акт PDF, редактируемый акт DOCX, фотоотчёт PDF и редактируемый фотоотчёт DOCX.",
    ].join("\r\n");
    const parts = [
      `From: ${formatMailbox(env.MAIL_FROM)}`,
      `To: ${formatMailbox(env.MAIL_TO)}`,
      `Subject: ${encodeMimeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@riklab.ru>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(base64Utf8(body)),
    ];

    const fallbackName = safeAsciiFilename(archive.name, archive.type);
    parts.push(
      `--${boundary}`,
      `Content-Type: application/zip; name="${fallbackName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(archive.name)}`,
      "",
      wrapBase64(base64Bytes(archiveBytes)),
    );
    parts.push(`--${boundary}--`, "");
    await smtpSend(env, parts.join("\r\n"));
    return new Response(archiveBytes, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(archive.name)}`, "cache-control": "no-store", "x-mail-recipient": env.MAIL_TO } });
  } catch (error) {
    console.error("SMTP send failed", error instanceof Error ? error.message : "Unknown error");
    return Response.json({ error: "Не удалось отправить письмо. Попробуйте ещё раз" }, { status: 502 });
  }
}

function isAllowedEmailAttachment(file: File) {
  return file.type === "application/pdf" || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

function formatRussianDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

async function createStoredZip(files: File[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const now = new Date();
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((Math.floor(now.getSeconds() / 2)) & 31);
  const dosDate = (((Math.max(1980, now.getFullYear()) - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
  let localOffset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name.replace(/[\\/]/g, "-"));
    const data = new Uint8Array(await file.arrayBuffer());
    const crc = crc32(data);
    const localHeader = new Uint8Array(30);
    const local = new DataView(localHeader.buffer);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    localParts.push(localHeader, name, data);

    const centralHeader = new Uint8Array(46);
    const central = new DataView(centralHeader.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, localOffset, true);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endHeader = new Uint8Array(22);
  const end = new DataView(endHeader.buffer);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, localOffset, true);
  end.setUint16(20, 0, true);
  return concatBytes([...localParts, ...centralParts, endHeader]);
}

type StoredZipEntry = {
  key: string;
  filename: string;
  size: number;
  crc: number;
};

function createStoredZipStream(env: Env, entries: StoredZipEntry[]) {
  const encoder = new TextEncoder();
  const now = new Date();
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((Math.floor(now.getSeconds() / 2)) & 31);
  const dosDate = (((Math.max(1980, now.getFullYear()) - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

  async function* chunks() {
    const centralParts: Uint8Array[] = [];
    let localOffset = 0;

    for (const entry of entries) {
      const name = encoder.encode(entry.filename.replace(/[\\/]/g, "-"));
      const localHeader = new Uint8Array(30);
      const local = new DataView(localHeader.buffer);
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, entry.crc, true);
      local.setUint32(18, entry.size, true);
      local.setUint32(22, entry.size, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      yield localHeader;
      yield name;

      const object = await env.PRIVATE_FILES.get(entry.key);
      if (!object) throw new Error("Stored package part is missing");
      const reader = object.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) yield value;
        }
      } finally {
        reader.releaseLock();
      }

      const centralHeader = new Uint8Array(46);
      const central = new DataView(centralHeader.buffer);
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(10, 0, true);
      central.setUint16(12, dosTime, true);
      central.setUint16(14, dosDate, true);
      central.setUint32(16, entry.crc, true);
      central.setUint32(20, entry.size, true);
      central.setUint32(24, entry.size, true);
      central.setUint16(28, name.length, true);
      central.setUint16(30, 0, true);
      central.setUint16(32, 0, true);
      central.setUint16(34, 0, true);
      central.setUint16(36, 0, true);
      central.setUint32(38, 0, true);
      central.setUint32(42, localOffset, true);
      centralParts.push(centralHeader, name);
      localOffset += localHeader.length + name.length + entry.size;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    for (const part of centralParts) yield part;
    const endHeader = new Uint8Array(22);
    const end = new DataView(endHeader.buffer);
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, localOffset, true);
    end.setUint16(20, 0, true);
    yield endHeader;
  }

  const iterator = chunks();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function storedZipSize(entries: StoredZipEntry[]) {
  const encoder = new TextEncoder();
  return entries.reduce((total, entry) => {
    const nameLength = encoder.encode(entry.filename.replace(/[\\/]/g, "-")).length;
    return total + 30 + nameLength + entry.size + 46 + nameLength;
  }, 22);
}

function concatBytes(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function formatMailbox(value: string) {
  const mailbox = value.replace(/[\r\n<>]/g, "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox)) throw new Error("Invalid mailbox configuration");
  return `<${mailbox}>`;
}

function safeAsciiFilename(name: string, mimeType: string) {
  const extension = mimeType === "application/pdf" ? ".pdf" : mimeType === "application/zip" ? ".zip" : ".docx";
  const stem = name.replace(/\.[^.]+$/, "").normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "riklab-report";
  return `${stem}${extension}`;
}

function encodeMimeHeader(value: string) {
  return `=?UTF-8?B?${base64Utf8(value)}?=`;
}

function base64Utf8(value: string) {
  return base64Bytes(new TextEncoder().encode(value));
}

function base64Bytes(bytes: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 12_288) {
    const end = Math.min(bytes.length, offset + 12_288);
    let chunk = "";
    for (let index = offset; index < end; index += 3) {
      const a = bytes[index];
      const hasB = index + 1 < bytes.length;
      const hasC = index + 2 < bytes.length;
      const b = hasB ? bytes[index + 1] : 0;
      const c = hasC ? bytes[index + 2] : 0;
      chunk += alphabet[a >> 2];
      chunk += alphabet[((a & 3) << 4) | (b >> 4)];
      chunk += hasB ? alphabet[((b & 15) << 2) | (c >> 6)] : "=";
      chunk += hasC ? alphabet[c & 63] : "=";
    }
    chunks.push(chunk);
  }
  return chunks.join("");
}

function wrapBase64(value: string) {
  return value.match(/.{1,76}/g)?.join("\r\n") || "";
}

async function sendArchiveEmail(metadata: EmailMetadata, archive: ReadableStream<Uint8Array>, archiveName: string, env: Env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.MAIL_FROM || !env.MAIL_TO) throw new Error("Mail is not configured");
  const clean = (value: unknown, fallback: string) => String(value || fallback).replace(/[\r\n]+/g, " ").trim().slice(0, 180);
  const objectCode = clean(metadata.objectCode, "без номера");
  const date = clean(metadata.date, "без даты");
  const serviceType = clean(metadata.serviceType, "ТО печи");
  const pizzeriaAddress = clean(metadata.pizzeriaAddress, "адрес не указан");
  const ovenModel = clean(metadata.ovenModel, "модель не указана");
  const ovenPosition = clean(metadata.ovenPosition, "положение не указано");
  const technicianName = clean(metadata.technicianName, "не указан");
  const displayDate = formatRussianDate(date);
  const subject = `${objectCode} — ${serviceType} — ${displayDate}`;
  const body = [
    "Документы по техническому обслуживанию печи сформированы на сайте РИК ЛАБ.",
    "",
    `Объект: ${objectCode}`,
    `Адрес: ${pizzeriaAddress}`,
    `Вид ТО: ${serviceType}`,
    `Дата: ${displayDate}`,
    `Печь: ${ovenModel} (${ovenPosition})`,
    `Инженер: ${technicianName}`,
    "",
    "Во вложении ZIP-архив: акт PDF, редактируемый акт DOCX, фотоотчёт PDF и редактируемый фотоотчёт DOCX.",
  ].join("\r\n");
  const boundary = `riklab-${crypto.randomUUID()}`;
  const fallbackName = safeAsciiFilename(archiveName, "application/zip");

  await smtpSend(env, async (write) => {
    await write([
      `From: ${formatMailbox(env.MAIL_FROM!)}`,
      `To: ${formatMailbox(env.MAIL_TO!)}`,
      `Subject: ${encodeMimeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@riklab.ru>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(base64Utf8(body)),
      `--${boundary}`,
      `Content-Type: application/zip; name="${fallbackName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(archiveName)}`,
      "",
    ].join("\r\n"));
    await writeBase64Stream(archive, write);
    await write(`\r\n--${boundary}--\r\n`);
  });
}

async function writeBase64Stream(stream: ReadableStream<Uint8Array>, write: (chunk: string) => Promise<void>) {
  const reader = stream.getReader();
  let carry = new Uint8Array(0);
  let hasOutput = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const combined = new Uint8Array(carry.length + value.length);
      combined.set(carry);
      combined.set(value, carry.length);
      const processLength = Math.floor(combined.length / 57) * 57;
      if (processLength) {
        const encoded = wrapBase64(base64Bytes(combined.subarray(0, processLength)));
        await write(`${hasOutput ? "\r\n" : ""}${encoded}`);
        hasOutput = true;
      }
      carry = combined.slice(processLength);
    }
    if (carry.length) await write(`${hasOutput ? "\r\n" : ""}${wrapBase64(base64Bytes(carry))}`);
  } finally {
    reader.releaseLock();
  }
}

type SmtpMessage = string | ((write: (chunk: string) => Promise<void>) => Promise<void>);

async function smtpSend(env: Env, message: SmtpMessage) {
  const { connect } = await import("cloudflare:sockets");
  const socket = connect(
    { hostname: env.SMTP_HOST!, port: Number(env.SMTP_PORT || 465) },
    { secureTransport: "on", allowHalfOpen: false },
  );
  await socket.opened;
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = "";

  const readLine = async (): Promise<string> => {
    while (!lineBuffer.includes("\r\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SMTP connection closed unexpectedly");
      lineBuffer += decoder.decode(value, { stream: true });
    }
    const separator = lineBuffer.indexOf("\r\n");
    const line = lineBuffer.slice(0, separator);
    lineBuffer = lineBuffer.slice(separator + 2);
    return line;
  };
  const readResponse = async () => {
    const first = await readLine();
    const match = first.match(/^(\d{3})([ -])/);
    if (!match) throw new Error("Invalid SMTP response");
    const code = Number(match[1]);
    if (match[2] === "-") {
      while (true) {
        const line = await readLine();
        if (line.startsWith(`${match[1]} `)) break;
      }
    }
    return code;
  };
  const expect = async (allowed: number[]) => {
    const code = await readResponse();
    if (!allowed.includes(code)) throw new Error(`SMTP rejected command (${code})`);
  };
  const command = async (value: string, allowed: number[]) => {
    await writer.write(encoder.encode(`${value}\r\n`));
    await expect(allowed);
  };

  try {
    await expect([220]);
    await command("EHLO service-to-reports.riklab.ru", [250]);
    await command("AUTH LOGIN", [334]);
    await command(base64Utf8(env.SMTP_USER!), [334]);
    await command(base64Utf8(env.SMTP_PASSWORD!), [235]);
    await command(`MAIL FROM:${formatMailbox(env.MAIL_FROM!)}`, [250]);
    await command(`RCPT TO:${formatMailbox(env.MAIL_TO!)}`, [250, 251]);
    await command("DATA", [354]);
    if (typeof message === "string") {
      const dotStuffed = message.replace(/(^|\r\n)\./g, "$1..");
      await writer.write(encoder.encode(dotStuffed));
    } else {
      await message(async (chunk) => writer.write(encoder.encode(chunk)));
    }
    await writer.write(encoder.encode("\r\n.\r\n"));
    await expect([250]);
    await command("QUIT", [221]);
  } finally {
    reader.releaseLock();
    writer.releaseLock();
    socket.close();
  }
}

function addDocxList(children: Array<Paragraph | Table>, title: string, values: string[]) {
  children.push(new Paragraph({ spacing: { before: 260, after: 100 }, children: [new TextRun({ text: title, bold: true, size: 26, color: "087A9F", font: "Arial" })] }));
  if (!values.length) {
    children.push(new Paragraph({ children: [new TextRun({ text: "Не указаны", italics: true, color: "688692", font: "Arial" })] }));
    return;
  }
  values.forEach((value) => children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: value, font: "Arial", size: 22 })] })));
}

function readImageDimensions(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/png" && bytes.length > 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { height: (bytes[offset + 5] << 8) + bytes[offset + 6], width: (bytes[offset + 7] << 8) + bytes[offset + 8] };
    if (!length) break;
    offset += 2 + length;
  }
  return { width: 1600, height: 1200 };
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
