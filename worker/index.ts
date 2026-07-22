/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, rgb } from "pdf-lib";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PRIVATE_FILES: R2Bucket;
  STAMP_SETUP_KEY?: string;
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

    if (url.pathname === "/api/admin/stamp" && request.method === "PUT") {
      if (!env.STAMP_SETUP_KEY || request.headers.get("x-setup-key") !== env.STAMP_SETUP_KEY) return new Response("Forbidden", { status: 403 });
      const bytes = await request.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 500_000) return new Response("Invalid image", { status: 400 });
      await env.PRIVATE_FILES.put("director-stamp-signature.png", bytes, { httpMetadata: { contentType: "image/png" } });
      return Response.json({ ok: true });
    }

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

    text(payload.act.technicianName, 160, 741, 6.2);
    const stampScale = Math.min(132 / stamp.width, 82 / stamp.height);
    page.drawImage(stamp, { x: 360, y: 63, width: stamp.width * stampScale, height: stamp.height * stampScale, opacity: 0.9 });

    const comments = payload.checklist.filter((item) => item.comment.trim());
    if (comments.length) addCommentsPage(pdf, font, comments);
    const bytes = await pdf.save();
    const fileCode = payload.act.objectCode.replace(/[^a-zA-Zа-яА-Я0-9-]+/g, "-");
    return new Response(bytes, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="oven-act-${fileCode}-${payload.act.date}.pdf"`, "cache-control": "no-store" } });
  } catch (error) {
    console.error("Failed to generate oven act PDF", error);
    return Response.json({ error: "Не удалось сформировать PDF" }, { status: 500 });
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
