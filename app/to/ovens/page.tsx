"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { siteGroups, siteObjects } from "./objects";

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
  serialNumber: string;
  technicianName: string;
};

const STORAGE_KEY = "oven-act-draft-v2";
const technicians = ["Давыдов Алексей", "Кусков Сергей", "Пахомов Александр", "Рубцов Алексей", "Фефелов Сергей", "Эсанов Бахром", "Эсанбоев Анвар"];
const ovenModels = ["XLT3240", "Robochef", "Zanolli 11/65", "Turbochef"];

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
  serialNumber: "",
  technicianName: "",
};

function themeForCurrentTime(): Theme {
  const hour = new Date().getHours();
  return hour >= 7 && hour < 20 ? "light" : "dark";
}

export default function OvenMaintenancePage() {
  const [form, setForm] = useState<ActData>(initialData);
  const [theme, setTheme] = useState<Theme>("light");
  const [hydrated, setHydrated] = useState(false);
  const [saveLabel, setSaveLabel] = useState("Автосохранение включено");

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("to-theme") as Theme | null;
    const initialTheme = savedTheme === "light" || savedTheme === "dark" ? savedTheme : themeForCurrentTime();
    setTheme(initialTheme);
    document.documentElement.dataset.theme = initialTheme;
    const savedDraft = window.localStorage.getItem(STORAGE_KEY);
    if (savedDraft) {
      try { setForm({ ...initialData, ...JSON.parse(savedDraft) }); }
      catch { setForm({ ...initialData, date: localDate() }); }
    } else setForm({ ...initialData, date: localDate() });
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

  const requiredFields = useMemo(() => [form.date, form.objectId, form.ovenModel, form.technicianName], [form]);
  const completed = requiredFields.filter(Boolean).length;
  const isComplete = completed === requiredFields.length;

  function updateField<K extends keyof ActData>(field: K, value: ActData[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function selectObject(objectId: string) {
    const site = siteObjects.find((item) => item.id === objectId);
    setForm((current) => ({
      ...current,
      objectId,
      objectCode: site?.code ?? "",
      pizzeriaAddress: site?.address ?? "",
      customer: site ? "Додо Пицца" : "",
    }));
  }

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("to-theme", next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isComplete) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    setSaveLabel("Данные акта заполнены и сохранены");
  }

  return (
    <main className="form-shell compact-act-shell">
      <header className="topbar form-topbar compact-topbar">
        <a className="brand" href="/" aria-label="Вернуться к выбору ТО">
          <img className="brand-logo" src="/rik-logo.png" alt="" width="42" height="42" />
          <span className="brand-copy"><strong>РИК ЛАБ</strong><small>Сервис ТО</small></span>
        </a>
        <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label="Переключить тему"><span aria-hidden="true" className="theme-symbol">{theme === "dark" ? "☀" : "◐"}</span></button>
      </header>

      <div className="compact-heading">
        <a className="back-link" href="/">← Все виды ТО</a>
        <div className="compact-title-row"><div><p className="kicker"><span aria-hidden="true" /> ТО печей</p><h1>Данные акта</h1></div><span className="compact-progress">{completed}/{requiredFields.length}</span></div>
        <p>Выберите объект — заказчик и адрес заполнятся автоматически.</p>
      </div>

      <form className="act-form compact-act-form" onSubmit={handleSubmit}>
        <section className="form-section compact-form-section">
          <label className="field object-field"><span>Объект *</span>
            <select value={form.objectId} onChange={(event) => selectObject(event.target.value)} required>
              <option value="">Выберите объект</option>
              {siteGroups.map((group) => <optgroup label={group} key={group}>{siteObjects.filter((site) => site.group === group).map((site) => <option value={site.id} key={site.id}>{site.code} — {site.address}</option>)}</optgroup>)}
            </select>
          </label>

          {form.objectId && <div className="object-summary" aria-live="polite"><div><span>Заказчик</span><strong>{form.customer}</strong></div><div><span>Пиццерия</span><strong>{form.objectCode}</strong><p>{form.pizzeriaAddress}</p></div></div>}

          <div className="compact-field-grid">
            <label className="field"><span>Дата работ *</span><input type="date" value={form.date} onChange={(event) => updateField("date", event.target.value)} required /></label>
            <label className="field"><span>Модель печи *</span><select value={form.ovenModel} onChange={(event) => updateField("ovenModel", event.target.value)} required><option value="">Выберите модель</option>{ovenModels.map((model) => <option value={model} key={model}>{model}</option>)}</select></label>
            <label className="field"><span>Техник *</span><select value={form.technicianName} onChange={(event) => updateField("technicianName", event.target.value)} required><option value="">Выберите техника</option>{technicians.map((technician) => <option value={technician} key={technician}>{technician}</option>)}</select></label>
            <label className="field"><span>Серийный номер <small>необязательно</small></span><input value={form.serialNumber} onChange={(event) => updateField("serialNumber", event.target.value)} placeholder="Можно заполнить позже" autoCapitalize="characters" /></label>
          </div>

          <div className="act-fixed-meta"><span>Исполнитель: <strong>{form.contractor}</strong></span><span>Вид ТО: <strong>{form.serviceType}</strong></span></div>
        </section>

        <div className="compact-save-row"><span className="compact-save-status"><i aria-hidden="true" /> {saveLabel}</span><button type="submit" disabled={!isComplete}>{isComplete ? "Сохранить" : `Заполнено ${completed} из ${requiredFields.length}`}</button></div>
      </form>
    </main>
  );
}
