export type StoredPhoto = {
  key: string;
  blob: Blob;
  updatedAt: number;
  compressionVersion?: number;
};

const DATABASE_NAME = "oven-maintenance-photos";
const STORE_NAME = "photos";
const COMPRESSION_VERSION = 1;

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, mode);
    const request = action(tx.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => database.close();
  });
}

export async function loadStoredPhotos() {
  const photos = await transaction<StoredPhoto[]>("readonly", (store) => store.getAll());
  return Object.fromEntries(photos.map((photo) => [photo.key, photo]));
}

export async function saveStoredPhoto(key: string, blob: Blob) {
  const photo = { key, blob, updatedAt: Date.now(), compressionVersion: COMPRESSION_VERSION } satisfies StoredPhoto;
  await transaction<IDBValidKey>("readwrite", (store) => store.put(photo));
  return photo;
}

export async function removeStoredPhoto(key: string) {
  await transaction<undefined>("readwrite", (store) => store.delete(key));
}

export async function clearStoredPhotos() {
  await transaction<undefined>("readwrite", (store) => store.clear());
}

async function loadPhotoSource(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close?: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch { /* Safari can decode HEIC through an image element even when createImageBitmap cannot */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function compressPhoto(file: Blob) {
  const decoded = await loadPhotoSource(file);
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(decoded.width * scale));
  canvas.height = Math.max(1, Math.round(decoded.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Не удалось обработать фотографию");
  context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
  decoded.close?.();
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Не удалось сжать фотографию")), "image/jpeg", 0.70));
}

export async function optimizeStoredPhoto(photo: StoredPhoto) {
  if (photo.compressionVersion === COMPRESSION_VERSION) return photo;
  const blob = await compressPhoto(photo.blob);
  const optimized = { ...photo, blob, compressionVersion: COMPRESSION_VERSION };
  await transaction<IDBValidKey>("readwrite", (store) => store.put(optimized));
  return optimized;
}
