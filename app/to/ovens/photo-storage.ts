export type StoredPhoto = {
  key: string;
  blob: Blob;
  updatedAt: number;
};

const DATABASE_NAME = "oven-maintenance-photos";
const STORE_NAME = "photos";

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
  await transaction<IDBValidKey>("readwrite", (store) => store.put({ key, blob, updatedAt: Date.now() } satisfies StoredPhoto));
}

export async function removeStoredPhoto(key: string) {
  await transaction<undefined>("readwrite", (store) => store.delete(key));
}

export async function clearStoredPhotos() {
  await transaction<undefined>("readwrite", (store) => store.clear());
}

export async function compressPhoto(file: File) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Не удалось обработать фотографию");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Не удалось сжать фотографию")), "image/jpeg", 0.82));
}
