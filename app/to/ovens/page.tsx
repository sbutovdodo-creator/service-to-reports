"use client";

import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { ovenChecklist } from "./checklist";
import { legalEntityForPointCode } from "./legal-entities";
import { siteGroups, siteObjects } from "./objects";
import { allPhotoSlots, photoRequirements, requiredPhotoSlots } from "./photos";
import { clearStoredPhotos, compressPhoto, loadStoredPhotos, optimizeStoredPhoto, removeStoredPhoto, saveStoredPhoto, StoredPhoto } from "./photo-storage";

type Theme = "light" | "dark";
type ActData = {
  date: string;
  contractor: string;
  customer: string;
  objectId: string;
  objectCode: string;
  pizzeriaAddress: string;
  serviceType: string;
  ovenModel: string;
  ovenPosition: string;
  serialNumber: string;
  technicianName: string;
};

type ActEntries = {
  remarks: string[];
  recommendations: string[];
  completedWorks: string[];
};

const STORAGE_KEY = "oven-act-draft-v2";
const CHECKLIST_KEY = "oven-checklist-draft-v1";
const ACT_ENTRIES_KEY = "oven-act-entries-draft-v1";
const STEP_KEY = "oven-maintenance-step-v1";
const EXTRA_PHOTO_PREFIX = "extra-work-";
const ISSUE_PHOTO_PREFIX = "unresolved-issue-";
const SLOT_PHOTO_SEPARATOR = "--photo-";
const IMAGE_FILE_EXTENSION = /\.(?:avif|heic|heif|jpe?g|png|webp)$/i;
const technicians = ["Давыдов Алексей", "Кусков Сергей", "Пахомов Александр", "Рубцов Алексей", "Фефелов Сергей", "Эсанов Бахром", "Эсанбоев Анвар"];
const ovenModels = ["XLT3240", "Robochef", "Zanolli 11/65", "Turbochef", "Abat"];

function customerForObject(objectId: string) {
  const site = siteObjects.find((item) => item.id === objectId);
  return site ? legalEntityForPointCode(site.code) : "";
}

function siteLabel(site: (typeof siteObjects)[number]) {
  return `${site.code} — ${site.address}`;
}

function normalizeSearch(value: string) {
  return value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/gi, " ").trim();
}

function localDate() {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

const initialData: ActData = {
  date: "",
  contractor: "ООО «РИК-ЛАБ»",
  customer: "",
  objectId: "",
  objectCode: "",
  pizzeriaAddress: "",
  serviceType: "Плановое ТО печи",
  ovenModel: "",
  ovenPosition: "",
  serialNumber: "",
  technicianName: "",
};

const emptyChecklist = () => Object.fromEntries(ovenChecklist.map((item) => [item.id, { done: false, comment: "" }]));
const emptyActEntries = (): ActEntries => ({ remarks: [""], recommendations: [""], completedWorks: [""] });

function themeForCurrentTime(): Theme {
  const hour = new Date().getHours();
  return hour >= 7 && hour < 20 ? "light" : "dark";
}

export default function OvenMaintenancePage() {
  const [form, setForm] = useState<ActData>(initialData);
  const [checklist, setChecklist] = useState<Record<string, { done: boolean; comment: string }>>(emptyChecklist);
  const [actEntries, setActEntries] = useState<ActEntries>(emptyActEntries);
  const [theme, setTheme] = useState<Theme>("light");
  const [hydrated, setHydrated] = useState(false);
  const [saveLabel, setSaveLabel] = useState("Автосохранение включено");
  const [isGenerating, setIsGenerating] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const [photos, setPhotos] = useState<Record<string, StoredPhoto>>({});
  const [photoError, setPhotoError] = useState("");
  const [processingPhoto, setProcessingPhoto] = useState<string | null>(null);
  const [extraDragActive, setExtraDragActive] = useState(false);
  const [issueDragActive, setIssueDragActive] = useState(false);
  const [objectSearch, setObjectSearch] = useState("");
  const [objectMenuOpen, setObjectMenuOpen] = useState(false);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("to-theme") as Theme | null;
    const initialTheme = savedTheme === "light" || savedTheme === "dark" ? savedTheme : themeForCurrentTime();
    setTheme(initialTheme);
    document.documentElement.dataset.theme = initialTheme;

    const savedDraft = window.localStorage.getItem(STORAGE_KEY);
    if (savedDraft) {
      try {
        const restored = { ...initialData, ...JSON.parse(savedDraft) } as ActData;
        setForm({ ...restored, customer: customerForObject(restored.objectId) });
        const restoredSite = siteObjects.find((site) => site.id === restored.objectId);
        setObjectSearch(restoredSite ? siteLabel(restoredSite) : "");
      } catch { setForm({ ...initialData, date: localDate() }); }
    } else setForm({ ...initialData, date: localDate() });

    const savedChecklist = window.localStorage.getItem(CHECKLIST_KEY);
    if (savedChecklist) {
      try {
        const restoredChecklist = JSON.parse(savedChecklist);
        setChecklist(Object.fromEntries(ovenChecklist.map((item) => [item.id, { done: false, comment: "", ...restoredChecklist[item.id] }])));
      } catch { /* keep an empty checklist */ }
    }
    const savedActEntries = window.localStorage.getItem(ACT_ENTRIES_KEY);
    if (savedActEntries) {
      try {
        const restored = JSON.parse(savedActEntries) as Partial<ActEntries>;
        setActEntries({
          remarks: restored.remarks?.length ? restored.remarks : [""],
          recommendations: restored.recommendations?.length ? restored.recommendations : [""],
          completedWorks: restored.completedWorks?.length ? restored.completedWorks : [""],
        });
      } catch { /* keep empty act entries */ }
    }
    loadStoredPhotos().then(setPhotos).catch(() => setPhotoError("Не удалось восстановить сохранённые фотографии"));
    window.localStorage.removeItem(STEP_KEY);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    setSaveLabel("Сохраняем…");
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
      setSaveLabel("Черновик сохранён");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [form, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(CHECKLIST_KEY, JSON.stringify(checklist));
  }, [checklist, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(ACT_ENTRIES_KEY, JSON.stringify(actEntries));
  }, [actEntries, hydrated]);

  const requiredFields = useMemo(() => [form.date, form.objectId, form.ovenModel, form.ovenPosition, form.technicianName], [form]);
  const actCompleted = requiredFields.filter(Boolean).length;
  const checklistCompleted = ovenChecklist.filter((item) => checklist[item.id]?.done).length;
  const totalCompleted = actCompleted + checklistCompleted;
  const totalRequired = requiredFields.length + ovenChecklist.length;
  const isComplete = totalCompleted === totalRequired;
  const completedRequiredPhotos = requiredPhotoSlots.filter((slot) => photos[slot.key]).length;
  const reportIsComplete = isComplete && completedRequiredPhotos === requiredPhotoSlots.length;
  const extraPhotos = Object.values(photos).filter((photo) => photo.key.startsWith(EXTRA_PHOTO_PREFIX)).sort((left, right) => left.updatedAt - right.updatedAt);
  const issuePhotos = Object.values(photos).filter((photo) => photo.key.startsWith(ISSUE_PHOTO_PREFIX)).sort((left, right) => left.updatedAt - right.updatedAt);
  const filteredSites = useMemo(() => {
    const terms = normalizeSearch(objectSearch).split(" ").filter(Boolean);
    if (!terms.length || form.objectId) return siteObjects;
    return siteObjects.filter((site) => {
      const searchable = normalizeSearch(`${site.code} ${site.address} ${site.group}`);
      return terms.every((term) => searchable.includes(term));
    });
  }, [objectSearch, form.objectId]);

  function updateField<K extends keyof ActData>(field: K, value: ActData[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function selectObject(objectId: string) {
    const site = siteObjects.find((item) => item.id === objectId);
    setForm((current) => ({ ...current, objectId, objectCode: site?.code ?? "", pizzeriaAddress: site?.address ?? "", customer: site ? customerForObject(site.id) : "" }));
    if (site) setObjectSearch(siteLabel(site));
  }

  function searchObject(value: string) {
    setObjectSearch(value);
    setObjectMenuOpen(true);
    const exactSite = siteObjects.find((site) => normalizeSearch(siteLabel(site)) === normalizeSearch(value));
    selectObject(exactSite?.id ?? "");
  }

  function updateChecklist(itemId: string, patch: Partial<{ done: boolean; comment: string }>) {
    setChecklist((current) => ({ ...current, [itemId]: { ...current[itemId], ...patch } }));
  }

  async function addFilesToSlot(slotKey: string, files: File[]) {
    if (!files.length) return;
    setProcessingPhoto(slotKey);
    setPhotoError("");
    let hasPrimaryPhoto = Boolean(photos[slotKey]);
    for (const [index, file] of files.entries()) {
      const key = hasPrimaryPhoto
        ? `${slotKey}${SLOT_PHOTO_SEPARATOR}${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`
        : slotKey;
      try {
        const blob = await compressPhoto(file);
        const photo = await saveStoredPhoto(key, blob);
        const orderedPhoto = { ...photo, updatedAt: photo.updatedAt + index };
        setPhotos((current) => ({ ...current, [key]: orderedPhoto }));
        hasPrimaryPhoto = true;
      } catch {
        setPhotoError("Одно из изображений не удалось прочитать. Попробуйте выбрать его из приложения «Фото» или сделать новый снимок камерой.");
      }
    }
    setProcessingPhoto(null);
  }

  async function handlePhotoChange(slotKey: string, event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    await addFilesToSlot(slotKey, files);
  }

  function acceptedDroppedImages(files: File[]) {
    return files.filter((file) => file.type.startsWith("image/") || IMAGE_FILE_EXTENSION.test(file.name));
  }

  async function handleDroppedPhotos(slotKey: string, files: File[]) {
    const images = acceptedDroppedImages(files);
    if (!images.length) {
      setPhotoError("Перетаскивать можно только файлы изображений.");
      return;
    }
    await addFilesToSlot(slotKey, images);
  }

  async function deletePhoto(key: string) {
    await removeStoredPhoto(key).catch(() => undefined);
    const baseSlot = allPhotoSlots.find((slot) => key === slot.key || key.startsWith(`${slot.key}${SLOT_PHOTO_SEPARATOR}`));
    let promotedPhoto: StoredPhoto | undefined;
    let promotedFromKey: string | undefined;
    if (baseSlot && key === baseSlot.key) {
      const replacement = Object.values(photos)
        .filter((photo) => photo.key.startsWith(`${baseSlot.key}${SLOT_PHOTO_SEPARATOR}`))
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (replacement) {
        promotedFromKey = replacement.key;
        promotedPhoto = await saveStoredPhoto(baseSlot.key, replacement.blob);
        await removeStoredPhoto(replacement.key).catch(() => undefined);
      }
    }
    setPhotos((current) => {
      const next = { ...current };
      delete next[key];
      if (promotedPhoto && baseSlot) {
        if (promotedFromKey) delete next[promotedFromKey];
        next[baseSlot.key] = promotedPhoto;
      }
      return next;
    });
  }

  async function addFilesToPhotoCollection(prefix: string, files: File[]) {
    for (const [index, file] of files.entries()) {
      const key = `${prefix}${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
      setProcessingPhoto(key);
      setPhotoError("");
      try {
        const blob = await compressPhoto(file);
        const photo = await saveStoredPhoto(key, blob);
        const orderedPhoto = { ...photo, updatedAt: photo.updatedAt + index };
        setPhotos((current) => ({ ...current, [key]: orderedPhoto }));
      } catch {
        setPhotoError("Одно из изображений не удалось прочитать. Попробуйте выбрать его из приложения «Фото».");
      }
    }
    setProcessingPhoto(null);
  }

  async function addExtraPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    await addFilesToPhotoCollection(EXTRA_PHOTO_PREFIX, files);
  }

  async function addIssuePhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    await addFilesToPhotoCollection(ISSUE_PHOTO_PREFIX, files);
  }

  async function handleExtraPhotoDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setExtraDragActive(false);
    const images = acceptedDroppedImages(Array.from(event.dataTransfer.files));
    if (!images.length) {
      setPhotoError("Перетаскивать можно только файлы изображений.");
      return;
    }
    await addFilesToPhotoCollection(EXTRA_PHOTO_PREFIX, images);
  }

  async function handleIssuePhotoDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIssueDragActive(false);
    const images = acceptedDroppedImages(Array.from(event.dataTransfer.files));
    if (!images.length) {
      setPhotoError("Перетаскивать можно только файлы изображений.");
      return;
    }
    await addFilesToPhotoCollection(ISSUE_PHOTO_PREFIX, images);
  }

  function updateActEntry(section: keyof ActEntries, index: number, value: string) {
    setActEntries((current) => ({ ...current, [section]: current[section].map((entry, entryIndex) => entryIndex === index ? value : entry) }));
  }

  function addActEntry(section: keyof ActEntries) {
    setActEntries((current) => ({ ...current, [section]: [...current[section], ""] }));
  }

  function removeActEntry(section: keyof ActEntries, index: number) {
    setActEntries((current) => {
      const next = current[section].filter((_, entryIndex) => entryIndex !== index);
      return { ...current, [section]: next.length ? next : [""] };
    });
  }

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("to-theme", next);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reportIsComplete) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    window.localStorage.setItem(CHECKLIST_KEY, JSON.stringify(checklist));
    setIsGenerating(true);
    setPdfError("");
    try {
      const reportPhotos: Record<string, StoredPhoto> = {};
      const photoValues = Object.values(photos);
      for (const [index, photo] of photoValues.entries()) {
        setSaveLabel(`Оптимизируем фото — ${index + 1} из ${photoValues.length}`);
        const optimized = await optimizeStoredPhoto(photo);
        reportPhotos[optimized.key] = optimized;
      }
      setPhotos(reportPhotos);
      const actPayload = JSON.stringify({ act: form, checklist: ovenChecklist.map((item) => ({ ...item, ...checklist[item.id] })), entries: actEntries });
      const packageId = crypto.randomUUID();
      const storePart = async (kind: "act-pdf" | "act-docx" | "report-pdf" | "report-docx", body: FormData) => {
        body.append("packageId", packageId);
        body.append("kind", kind);
        const response = await fetch("/api/oven-package/part", { method: "POST", body });
        if (!response.ok) {
          const result = await response.json().catch(() => ({ error: "Не удалось сформировать документ" }));
          throw new Error(result.error || "Не удалось сформировать документ");
        }
      };
      const createActBody = () => { const body = new FormData(); body.append("actPayload", actPayload); return body; };
      setSaveLabel("Формируем акт PDF — 1 из 4");
      await storePart("act-pdf", createActBody());
      setSaveLabel("Формируем акт DOCX — 2 из 4");
      await storePart("act-docx", createActBody());
      setSaveLabel("Формируем фотоотчёт PDF — 3 из 4");
      await storePart("report-pdf", createReportBody(reportPhotos));
      setSaveLabel("Формируем фотоотчёт DOCX — 4 из 4");
      await storePart("report-docx", createReportBody(reportPhotos));
      setSaveLabel("Упаковываем ZIP и отправляем письмо…");
      const deliveryResponse = await fetch("/api/oven-package/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packageId, metadata: { objectCode: form.objectCode, date: form.date, serviceType: "ТО печи", pizzeriaAddress: form.pizzeriaAddress, ovenModel: form.ovenModel, ovenPosition: form.ovenPosition, technicianName: form.technicianName } }),
      });
      if (!deliveryResponse.ok) {
        const result = await deliveryResponse.json().catch(() => ({ error: "Не удалось отправить архив" }));
        throw new Error(result.error || "Не удалось отправить архив");
      }
      const mailStatus = deliveryResponse.headers.get("x-mail-status");
      const telegramStatus = deliveryResponse.headers.get("x-telegram-status");
      const archive = await deliveryResponse.blob();
      const archiveName = `ТО-печи-${form.objectCode}-${form.date}.zip`;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(archive);
      link.download = archiveName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 5_000);
      if (mailStatus === "failed" && telegramStatus === "failed") {
        setSaveLabel("ZIP скачан на устройство");
        setPdfError("Документы созданы и ZIP скачан, но почта и Telegram временно не приняли файлы. Черновик сохранён — попробуйте отправить комплект ещё раз.");
      } else if (mailStatus === "failed") {
        setSaveLabel("ZIP скачан на устройство");
        setPdfError("Документы созданы, PDF отправлены в Telegram и ZIP скачан, но почтовый сервер не принял письмо. Черновик сохранён — попробуйте отправить комплект ещё раз.");
      } else if (telegramStatus === "failed") {
        setSaveLabel("ZIP скачан и отправлен на info@riklab.ru");
        setPdfError("Почта приняла документы, но Telegram временно не принял PDF. Черновик сохранён — попробуйте отправить комплект ещё раз.");
      } else {
        setSaveLabel("ZIP скачан, письмо и PDF в Telegram отправлены");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось сформировать документы";
      setPdfError(message === "Load failed" || message === "Failed to fetch" ? "Связь прервалась. Черновик сохранён — нажмите кнопку ещё раз при устойчивом интернете." : message);
    } finally {
      setIsGenerating(false);
    }
  }

  function createReportBody(sourcePhotos: Record<string, StoredPhoto>) {
    const regularItems = allPhotoSlots.flatMap((slot) => {
      const slotPhotos = Object.values(sourcePhotos)
        .filter((photo) => photo.key === slot.key || photo.key.startsWith(`${slot.key}${SLOT_PHOTO_SEPARATOR}`))
        .sort((left, right) => left.key === slot.key ? -1 : right.key === slot.key ? 1 : left.updatedAt - right.updatedAt);
      return slotPhotos.map((photo, index) => ({
        key: photo.key,
        title: `${slot.requirementTitle} — ${slot.label}${slotPhotos.length > 1 ? ` — фото ${index + 1}` : ""}`,
        required: slot.required && index === 0,
      }));
    });
    const optimizedExtraPhotos = Object.values(sourcePhotos).filter((photo) => photo.key.startsWith(EXTRA_PHOTO_PREFIX)).sort((left, right) => left.updatedAt - right.updatedAt);
    const extraItems = optimizedExtraPhotos.map((photo, index) => ({ key: photo.key, title: `Дополнительные работы — фото ${index + 1}`, required: false }));
    const optimizedIssuePhotos = Object.values(sourcePhotos).filter((photo) => photo.key.startsWith(ISSUE_PHOTO_PREFIX)).sort((left, right) => left.updatedAt - right.updatedAt);
    const issueItems = optimizedIssuePhotos.map((photo, index) => ({ key: photo.key, title: `Выявленные замечания — фото ${index + 1}`, required: false }));
    const photoItems = [...regularItems, ...extraItems, ...issueItems];
    const body = new FormData();
    body.append("metadata", JSON.stringify({ act: form, entries: actEntries, photos: photoItems }));
    photoItems.forEach((item) => body.append(`photo:${item.key}`, sourcePhotos[item.key].blob, `${item.key}.jpg`));
    return body;
  }

  function resetDraft() {
    if (!window.confirm("Очистить данные акта, все галочки и комментарии?")) return;
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(CHECKLIST_KEY);
    window.localStorage.removeItem(ACT_ENTRIES_KEY);
    setForm({ ...initialData, date: localDate() });
    setObjectSearch("");
    setObjectMenuOpen(false);
    setChecklist(emptyChecklist());
    setActEntries(emptyActEntries());
    clearStoredPhotos().catch(() => undefined);
    setPhotos({});
    setPdfError("");
    setSaveLabel("Черновик очищен");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="form-shell compact-act-shell one-page-act">
      <header className="topbar form-topbar compact-topbar">
        <a className="brand" href="/" aria-label="Вернуться к выбору ТО"><img className="brand-logo" src="/rik-logo.png" alt="" width="42" height="42" /><span className="brand-copy"><strong>РИК ЛАБ</strong><small>Сервис ТО</small></span></a>
        <div className="topbar-actions"><button className="logout-button" type="button" onClick={logout}>Выйти</button><button className="theme-toggle" type="button" onClick={toggleTheme} aria-label="Переключить тему"><span aria-hidden="true" className="theme-symbol">{theme === "dark" ? "☀" : "◐"}</span></button></div>
      </header>

      <div className="compact-heading">
        <a className="back-link" href="/">← Все виды ТО</a>
        <div className="compact-title-row"><div><p className="kicker"><span aria-hidden="true" /> Техническое обслуживание</p><h1>ТО печи</h1></div><span className="compact-progress">{totalCompleted}/{totalRequired}</span></div>
        <p>Сначала добавьте фотографии, затем заполните акт. Черновик и фото сохраняются на этом устройстве.</p>
      </div>

      <form className="one-page-form" onSubmit={handleSubmit}>
        <section className="form-section compact-form-section act-data-section">
          <div className="checklist-section-heading"><span>01</span><div><h2>Данные акта</h2><p>Объект, оборудование и инженер</p></div></div>
          <label className="field object-field"><span>Объект *</span><div className="object-combobox"><input value={objectSearch} onChange={(event) => searchObject(event.target.value)} onFocus={() => setObjectMenuOpen(true)} onBlur={() => window.setTimeout(() => setObjectMenuOpen(false), 120)} onKeyDown={(event) => { if (event.key === "Escape") setObjectMenuOpen(false); if (event.key === "Enter" && objectMenuOpen && !form.objectId && filteredSites[0]) { event.preventDefault(); selectObject(filteredSites[0].id); setObjectMenuOpen(false); } }} placeholder="Введите номер точки или адрес" role="combobox" aria-expanded={objectMenuOpen} aria-controls="object-search-results" aria-autocomplete="list" autoComplete="off" required />{objectMenuOpen && <div className="object-search-results" id="object-search-results" role="listbox">{filteredSites.length ? siteGroups.map((group) => { const groupSites = filteredSites.filter((site) => site.group === group); return groupSites.length ? <div className="object-search-group" key={group}><span>{group}</span>{groupSites.map((site) => <button type="button" role="option" aria-selected={site.id === form.objectId} onPointerDown={(event) => { event.preventDefault(); selectObject(site.id); setObjectMenuOpen(false); }} key={site.id}><strong>{site.code}</strong><small>{site.address}</small></button>)}</div> : null; }) : <p className="object-search-empty">Точки не найдены</p>}</div>}</div></label>
          {form.objectId && <div className="object-summary" aria-live="polite"><div><span>Заказчик</span><strong>{form.customer}</strong></div><div><span>Пиццерия</span><strong>{form.objectCode}</strong><p>{form.pizzeriaAddress}</p></div></div>}
          <div className="compact-field-grid">
            <label className="field"><span>Дата работ *</span><input type="date" value={form.date} onChange={(event) => updateField("date", event.target.value)} required /></label>
            <label className="field"><span>Модель печи *</span><select value={form.ovenModel} onChange={(event) => updateField("ovenModel", event.target.value)} required><option value="">Выберите модель</option>{ovenModels.map((model) => <option value={model} key={model}>{model}</option>)}</select></label>
            <label className="field"><span>Расположение печи *</span><select value={form.ovenPosition} onChange={(event) => updateField("ovenPosition", event.target.value)} required><option value="">Выберите расположение</option><option value="верхняя">Верхняя</option><option value="нижняя">Нижняя</option></select></label>
            <label className="field"><span>Инженер *</span><select value={form.technicianName} onChange={(event) => updateField("technicianName", event.target.value)} required><option value="">Выберите инженера</option>{technicians.map((technician) => <option value={technician} key={technician}>{technician}</option>)}</select></label>
            <label className="field"><span>Серийный номер <small>необязательно</small></span><input value={form.serialNumber} onChange={(event) => updateField("serialNumber", event.target.value)} placeholder="Можно заполнить позже" autoCapitalize="characters" /></label>
          </div>
          <div className="act-fixed-meta"><span>Исполнитель: <strong>{form.contractor}</strong></span><span>Вид ТО: <strong>{form.serviceType}</strong></span></div>
        </section>

        <section className="checklist-section photo-report-section" aria-labelledby="photo-report-title">
          <div className="checklist-section-heading"><span>02</span><div><h2 id="photo-report-title">Обязательные фотографии</h2><p>{completedRequiredPhotos} из {requiredPhotoSlots.length} обязательных фото добавлено</p></div></div>
          <div className="photo-progress" aria-hidden="true"><span style={{ width: `${requiredPhotoSlots.length ? completedRequiredPhotos / requiredPhotoSlots.length * 100 : 0}%` }} /></div>
          <div className="photo-requirements">{photoRequirements.map((requirement, index) => <PhotoRequirementRow requirement={requirement} index={index} photos={photos} processingPhoto={processingPhoto} onChange={handlePhotoChange} onDropFiles={handleDroppedPhotos} onDelete={deletePhoto} key={requirement.id} />)}</div>
          <article
            className={`photo-requirement-row extra-photo-row${extraDragActive ? " is-dragging" : ""}`}
            onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setExtraDragActive(true); } }}
            onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setExtraDragActive(true); } }}
            onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setExtraDragActive(false); }}
            onDrop={handleExtraPhotoDrop}
          >
            <div className="photo-requirement-copy"><span>{String(photoRequirements.length + 1).padStart(2, "0")}</span><div><strong>Дополнительные работы</strong><small>Добавьте столько фотографий, сколько необходимо</small></div></div>
            <div className="extra-photo-actions">
              <label className="camera-action">Камера<input type="file" accept="image/*,.heic,.heif,.avif,.webp" capture="environment" onChange={addExtraPhotos} /></label>
              <label className="gallery-action">Галерея<input type="file" accept="image/*,.heic,.heif,.avif,.webp" multiple onChange={addExtraPhotos} /></label>
            </div>
            <span className="photo-drop-hint">или перетащите фотографии из папки сюда</span>
            {extraPhotos.length > 0 && <div className="extra-photo-grid">{extraPhotos.map((photo, index) => <PhotoPreviewCard photo={photo} label={`Фото ${index + 1}`} onDelete={deletePhoto} key={photo.key} />)}</div>}
          </article>
          <article
            className={`photo-requirement-row extra-photo-row${issueDragActive ? " is-dragging" : ""}`}
            onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setIssueDragActive(true); } }}
            onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setIssueDragActive(true); } }}
            onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setIssueDragActive(false); }}
            onDrop={handleIssuePhotoDrop}
          >
            <div className="photo-requirement-copy"><span>{String(photoRequirements.length + 2).padStart(2, "0")}</span><div><strong>Выявленные замечания</strong><small>Фото неисправностей, которые не удалось устранить во время ТО — необязательно</small></div></div>
            <div className="extra-photo-actions">
              <label className="camera-action">Камера<input type="file" accept="image/*,.heic,.heif,.avif,.webp" capture="environment" onChange={addIssuePhotos} /></label>
              <label className="gallery-action">Галерея<input type="file" accept="image/*,.heic,.heif,.avif,.webp" multiple onChange={addIssuePhotos} /></label>
            </div>
            <span className="photo-drop-hint">или перетащите фотографии из папки сюда</span>
            {issuePhotos.length > 0 && <div className="extra-photo-grid">{issuePhotos.map((photo, index) => <PhotoPreviewCard photo={photo} label={`Замечание — фото ${index + 1}`} onDelete={deletePhoto} key={photo.key} />)}</div>}
          </article>
          {photoError && <p className="pdf-error" role="alert">{photoError}</p>}
          <p className="photo-storage-note">Обязательные фото нужны только для формирования отдельного фотоотчёта. Условные фотографии помечены как необязательные.</p>
        </section>

        <section className="checklist-section" aria-labelledby="inspection-title">
          <div className="checklist-section-heading"><span>03</span><div><h2 id="inspection-title">Осмотр элементов печи</h2><p>Проверка состояния оборудования до обслуживания</p></div></div>
          <div className="checklist-items">{ovenChecklist.filter((item) => item.group === "inspection").map((item) => <ChecklistRow item={item} value={checklist[item.id]} onChange={(patch) => updateChecklist(item.id, patch)} key={item.id} />)}</div>
        </section>

        <section className="checklist-section" aria-labelledby="maintenance-title">
          <div className="checklist-section-heading"><span>04</span><div><h2 id="maintenance-title">Работы по техническому обслуживанию</h2><p>Очистка, протяжка, замеры и проверки</p></div></div>
          <div className="checklist-items">{ovenChecklist.filter((item) => item.group === "maintenance").map((item) => <ChecklistRow item={item} value={checklist[item.id]} onChange={(patch) => updateChecklist(item.id, patch)} key={item.id} />)}</div>
        </section>

        <section className="checklist-section act-entries-section" aria-labelledby="act-entries-title">
          <div className="checklist-section-heading"><span>05</span><div><h2 id="act-entries-title">Записи в акт</h2><p>Добавляйте нужное количество строк кнопкой «+»</p></div></div>
          <div className="act-entry-groups">
            <ActEntryGroup title="Замечания" section="remarks" entries={actEntries.remarks} onChange={updateActEntry} onAdd={addActEntry} onRemove={removeActEntry} />
            <ActEntryGroup title="Рекомендации" section="recommendations" entries={actEntries.recommendations} onChange={updateActEntry} onAdd={addActEntry} onRemove={removeActEntry} />
            <ActEntryGroup title="Выполненные работы" section="completedWorks" entries={actEntries.completedWorks} onChange={updateActEntry} onAdd={addActEntry} onRemove={removeActEntry} />
          </div>
          <p className="fixed-act-signer">Исполнитель в акте: <strong>Пахомов А.В.</strong></p>
        </section>

        {pdfError && <p className="pdf-error" role="alert">{pdfError}</p>}
        <div className="compact-save-row">
          <span className="compact-save-status"><i aria-hidden="true" /> {saveLabel}</span>
          <div className="compact-form-actions">
            <button className="reset-draft-button" type="button" onClick={resetDraft}>Очистить</button>
            <button className="save-draft-button" type="submit" disabled={!reportIsComplete || isGenerating}>{isGenerating ? "Создаём ZIP и отправляем…" : reportIsComplete ? "Создать акт и отчёт" : `${totalCompleted}/${totalRequired} • фото ${completedRequiredPhotos}/${requiredPhotoSlots.length}`}</button>
          </div>
        </div>
      </form>
    </main>
  );
}

function PhotoRequirementRow({ requirement, index, photos, processingPhoto, onChange, onDropFiles, onDelete }: { requirement: (typeof photoRequirements)[number]; index: number; photos: Record<string, StoredPhoto>; processingPhoto: string | null; onChange: (key: string, event: ChangeEvent<HTMLInputElement>) => void; onDropFiles: (key: string, files: File[]) => void; onDelete: (key: string) => void; }) {
  return (
    <article className="photo-requirement-row">
      <div className="photo-requirement-copy"><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{requirement.title}</strong>{requirement.note && <small>{requirement.note}</small>}</div></div>
      <div className="photo-slot-list">{requirement.slots.map((slot) => {
        const slotPhotos = Object.values(photos)
          .filter((photo) => photo.key === slot.key || photo.key.startsWith(`${slot.key}${SLOT_PHOTO_SEPARATOR}`))
          .sort((left, right) => left.key === slot.key ? -1 : right.key === slot.key ? 1 : left.updatedAt - right.updatedAt);
        return <PhotoSlotGroup slot={slot} photos={slotPhotos} processing={processingPhoto === slot.key} onChange={onChange} onDropFiles={onDropFiles} onDelete={onDelete} key={slot.key} />;
      })}</div>
    </article>
  );
}

function PhotoSlotGroup({ slot, photos, processing, onChange, onDropFiles, onDelete }: { slot: (typeof photoRequirements)[number]["slots"][number]; photos: StoredPhoto[]; processing: boolean; onChange: (key: string, event: ChangeEvent<HTMLInputElement>) => void; onDropFiles: (key: string, files: File[]) => void; onDelete: (key: string) => void; }) {
  const [dragActive, setDragActive] = useState(false);
  return (
    <div
      className={`photo-slot-group${photos.length ? " has-photos" : ""}${dragActive ? " is-dragging" : ""}`}
      onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragActive(true); } }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragActive(true); } }}
      onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragActive(false); }}
      onDrop={(event) => { event.preventDefault(); setDragActive(false); onDropFiles(slot.key, Array.from(event.dataTransfer.files)); }}
    >
      <div className="photo-slot-group-heading">
        <strong>{slot.label}</strong>
        <small>{photos.length ? `${photos.length} фото` : slot.required ? "минимум 1 фото" : "необязательно"}</small>
      </div>
      <div className="photo-source-actions">
        <label className="camera-action">{processing ? "Обработка…" : photos.length ? "Ещё с камеры" : "Сделать фото"}<input type="file" accept="image/*,.heic,.heif,.avif,.webp" capture="environment" onChange={(event) => onChange(slot.key, event)} disabled={processing} /></label>
        <label className="gallery-action">{photos.length ? "Добавить фото" : "Выбрать фото"}<input type="file" accept="image/*,.heic,.heif,.avif,.webp" multiple onChange={(event) => onChange(slot.key, event)} disabled={processing} /></label>
      </div>
      <span className="photo-drop-hint">или перетащите фото сюда</span>
      {photos.length > 0 && <div className="photo-slot-previews">{photos.map((photo, index) => <PhotoPreviewCard photo={photo} label={`${slot.label}, фото ${index + 1}`} onDelete={onDelete} key={photo.key} />)}</div>}
    </div>
  );
}

function PhotoPreviewCard({ photo, label, onDelete }: { photo: StoredPhoto; label: string; onDelete: (key: string) => void; }) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    const url = URL.createObjectURL(photo.blob);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  return (
    <div className="photo-slot has-photo">
      {preview && <img src={preview} alt="" />}
      <strong>✓ {label}</strong>
      <button type="button" onClick={() => onDelete(photo.key)} aria-label={`Удалить фото: ${label}`}>×</button>
    </div>
  );
}

function ActEntryGroup({ title, section, entries, onChange, onAdd, onRemove }: { title: string; section: keyof ActEntries; entries: string[]; onChange: (section: keyof ActEntries, index: number, value: string) => void; onAdd: (section: keyof ActEntries) => void; onRemove: (section: keyof ActEntries, index: number) => void; }) {
  return (
    <div className="act-entry-group">
      <div className="act-entry-group-heading"><h3>{title}</h3><button type="button" onClick={() => onAdd(section)} aria-label={`Добавить строку: ${title}`}>+</button></div>
      <div className="act-entry-list">{entries.map((entry, index) => <div className="act-entry-row" key={`${section}-${index}`}><span>{index + 1}</span><textarea value={entry} onChange={(event) => onChange(section, index, event.target.value)} placeholder="Введите текст" rows={2} lang="ru" spellCheck autoCorrect="on" autoCapitalize="sentences" />{entries.length > 1 && <button type="button" onClick={() => onRemove(section, index)} aria-label={`Удалить строку ${index + 1}`}>×</button>}</div>)}</div>
    </div>
  );
}

function ChecklistRow({ item, value, onChange }: { item: (typeof ovenChecklist)[number]; value: { done: boolean; comment: string }; onChange: (patch: Partial<{ done: boolean; comment: string }>) => void; }) {
  return (
    <article className={`checklist-row${value?.done ? " is-done" : ""}`}>
      <label className="checklist-main"><input type="checkbox" checked={value?.done ?? false} onChange={(event) => onChange({ done: event.target.checked })} /><span className="checkmark" aria-hidden="true">✓</span><span className="checklist-number">{item.number}</span><strong>{item.title}</strong></label>
      <details className="comment-details" open={Boolean(value?.comment)}><summary>{value?.comment ? "Комментарий добавлен" : "Добавить комментарий"}</summary><textarea value={value?.comment ?? ""} onChange={(event) => onChange({ comment: event.target.value })} placeholder="Замечание, результат замера или пояснение" rows={2} lang="ru" spellCheck autoCorrect="on" autoCapitalize="sentences" /></details>
    </article>
  );
}
