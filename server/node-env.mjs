import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tls from "node:tls";
import path from "node:path";

const storageRoot = path.resolve(process.env.STORAGE_DIR || "/var/lib/riklab-service/private");
const assetRoot = path.resolve(process.env.ASSET_DIR || "dist-node/client");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
};

function safePath(root, key) {
  const segments = String(key).replaceAll("\\", "/").split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || !/^[\p{L}\p{N}._-]+$/u.test(segment))) {
    throw new Error("Unsafe storage path");
  }
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Unsafe storage path");
  return target;
}

async function readMetadata(filename) {
  try {
    return JSON.parse(await readFile(`${filename}.metadata.json`, "utf8"));
  } catch {
    return {};
  }
}

async function writeBody(filename, body) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await mkdir(path.dirname(filename), { recursive: true });
  try {
    if (body instanceof ReadableStream) {
      await pipeline(Readable.fromWeb(body), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    } else if (body instanceof Blob) {
      await writeFile(temporary, new Uint8Array(await body.arrayBuffer()), { flag: "wx", mode: 0o600 });
    } else {
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    }
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function storedObject(filename, details, customMetadata) {
  return {
    size: details.size,
    customMetadata,
    body: Readable.toWeb(createReadStream(filename)),
    async arrayBuffer() {
      const bytes = await readFile(filename);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

const privateFiles = {
  async put(key, body, options = {}) {
    const filename = safePath(storageRoot, key);
    await writeBody(filename, body);
    await writeFile(`${filename}.metadata.json`, JSON.stringify(options.customMetadata || {}), { mode: 0o600 });
  },
  async get(key) {
    const filename = safePath(storageRoot, key);
    try {
      const details = await stat(filename);
      if (!details.isFile()) return null;
      return storedObject(filename, details, await readMetadata(filename));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  },
  async head(key) {
    const filename = safePath(storageRoot, key);
    try {
      const details = await stat(filename);
      if (!details.isFile()) return null;
      return { size: details.size, customMetadata: await readMetadata(filename) };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  },
  async delete(key) {
    const filename = safePath(storageRoot, key);
    await Promise.all([rm(filename, { force: true }), rm(`${filename}.metadata.json`, { force: true })]);
  },
};

const assets = {
  async fetch(request) {
    const url = new URL(request.url);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    let filename;
    try {
      filename = safePath(assetRoot, relative);
    } catch {
      return new Response("Not Found", { status: 404 });
    }
    try {
      const bytes = await readFile(filename);
      return new Response(bytes, {
        headers: {
          "content-type": MIME_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream",
          "cache-control": pathname === "/login.html" ? "no-store" : "public, max-age=3600",
        },
      });
    } catch (error) {
      if (error?.code === "ENOENT") return new Response("Not Found", { status: 404 });
      throw error;
    }
  },
};

function connect(address, options) {
  const socket = tls.connect({
    host: address.hostname,
    port: address.port,
    servername: address.hostname,
    allowHalfOpen: options.allowHalfOpen,
  });
  const opened = new Promise((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  return {
    readable: Readable.toWeb(socket),
    writable: Writable.toWeb(socket),
    opened,
    close: () => socket.destroy(),
  };
}

export async function createNodeEnv() {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  return {
    ASSETS: assets,
    PRIVATE_FILES: privateFiles,
    CONNECT: connect,
    DB: {},
    IMAGES: {},
    APP_AUTH_LOGIN: process.env.APP_AUTH_LOGIN,
    APP_AUTH_PASSWORD: process.env.APP_AUTH_PASSWORD,
    APP_AUTH_SECRET: process.env.APP_AUTH_SECRET,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASSWORD: process.env.SMTP_PASSWORD,
    MAIL_FROM: process.env.MAIL_FROM,
    MAIL_TO: process.env.MAIL_TO,
  };
}
