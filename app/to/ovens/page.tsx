"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { ovenChecklist } from "./checklist";
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
const CHECKLIST_KEY = "oven-checklist-draft-v1";
const STEP_KEY = "oven-maintenance-step-v1";
const technicians = ["Давыдов Алексей", "Кусков Сергей", "Пахомов Александр", "Рубцов Алексей", "Фефелов Сергей", "Эсанов Бахром", "Эсанбоев Анвар"];
const ovenModels = ["XLT3240", "Robochef", "Zanolli 11/65", "Turbochef"];

function customerForObject(objectId: string) {
  if (/^0-\d+$/.test(objectId) || /^x[1-4]$/.test(objectId)) return "ООО «Пицца Венчур»";
  if (/^m(?:[1-9]|[12]\d|30)$/.test(objectId) || /^m27-/.test(objectId) || ["r1", "r2", "zh1", "zh2", "k1", "k2"].includes(objectId)) return "ООО «ДПМ Север»";
  return "";
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
  serialNumber: "",
  technicianName: "",
};

function themeForCurrentTime(): Theme {
  const hour = new Date().getHours();
  return hour >= 7 && hour < 20 ? "light" : "dark";
}

export default function OvenMaintenancePage() {
  const [form, setForm] = useState<ActData>(initialData);
  const [step, setStep] = useState<"act" | "checklist">("act");
  const [checklist, setChecklist] = useState<Record<string, { done: boolean; comment: string }>>(() =>
    Object.fromEntries(ovenChecklist.map((item) => [item.id, { done: false, comment: "" }])),
  );
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
      try {
        const restored = { ...initialData, ...JSON.parse(savedDraft) } as ActData;
        setForm({ ...restored, customer: customerForObject(restored.objectId) });
      }
      catch { setForm({ ...initialData, date: localDate() }); }
    } else setForm({ ...initialData, date: localDate() });
    const savedChecklist = window.localStorage.getItem(CHECKLIST_KEY);
    if (savedChecklist) {
      try {
        const restoredChecklist = JSON.parse(savedChecklist);
        setChecklist(Object.fromEntries(ovenChecklist.map((item) => [item.id, { done: false, comment: "", ...restoredChecklist[item.id] }])));
      } catch { /* keep an empty checklist */ }
    }
    if (window.localStorage.getItem(STEP_KEY) === "checklist") setStep("checklist");
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

  const requiredFields = useMemo(() => [form.date, form.objectId, form.ovenModel, form.technicianName], [form]);
  const completed = requiredFields.filter(Boolean).length;
  const isComplete = completed === requiredFields.length;
  const checklistCompleted = ovenChecklist.filter((item) => checklist[item.id]?.done).length;
  const checklistIsComplete = checklistCompleted === ovenChecklist.length;

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
      customer: site ? customerForObject(site.id) : "",
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
    window.localStorage.setItem(STEP_KEY, "checklist");
    setSaveLabel("Данные акта заполнены и сохранены");
    setStep("checklist");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function updateChecklist(itemId: string, patch: Partial<{ done: boolean; comment: string }>) {
    setChecklist((current) => ({ ...current, [itemId]: { ...current[itemId], ...patch } }));
  }

  function handleChecklistSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!checklistIsComplete) return;
    window.localStorage.setItem(CHECKLIST_KEY, JSON.stringify(checklist));
    setSaveLabel("Чек-лист полностью заполнен и сохранён");
  }

  function returnToAct() {
    window.localStorage.setItem(STEP_KEY, "act");
    setStep("act");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetDraft() {
    if (!window.confirm("Очистить все заполненные данные акта?")) return;
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(CHECKLIST_KEY);
    window.localStorage.removeItem(STEP_KEY);
    setForm({ ...initialData, date: localDate() });
    setChecklist(Object.fromEntries(ovenChecklist.map((item) => [item.id, { done: false, comment: "" }])));
    setStep("act");
    setSaveLabel("Черновик очищен");
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

      {step === "act" ? (
        <>
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

              {form.objectId && <div className="object-summary" aria-live="polite"><div><span>Заказчик</span><strong>{form.customer || "Будет добавлен позже"}</strong></div><div><span>Пиццерия</span><strong>{form.objectCode}</strong><p>{form.pizzeriaAddress}</p></div></div>}

              <div className="compact-field-grid">
                <label className="field"><span>Дата работ *</span><input type="date" value={form.date} onChange={(event) => updateField("date", event.target.value)} required /></label>
                <label className="field"><span>Модель печи *</span><select value={form.ovenModel} onChange={(event) => updateField("ovenModel", event.target.value)} required><option value="">Выберите модель</option>{ovenModels.map((model) => <option value={model} key={model}>{model}</option>)}</select></label>
                <label className="field"><span>Инженер *</span><select value={form.technicianName} onChange={(event) => updateField("technicianName", event.target.value)} required><option value="">Выберите инженера</option>{technicians.map((technician) => <option value={technician} key={technician}>{technician}</option>)}</select></label>
                <label className="field"><span>Серийный номер <small>необязательно</small></span><input value={form.serialNumber} onChange={(event) => updateField("serialNumber", event.target.value)} placeholder="Можно заполнить позже" autoCapitalize="characters" /></label>
              </div>

              <div className="act-fixed-meta"><span>Исполнитель: <strong>{form.contractor}</strong></span><span>Вид ТО: <strong>{form.serviceType}</strong></span></div>
            </section>

            <div className="compact-save-row">
              <span className="compact-save-status"><i aria-hidden="true" /> {saveLabel}</span>
              <div className="compact-form-actions">
                <button className="reset-draft-button" type="button" onClick={resetDraft}>Очистить черновик</button>
                <button className="save-draft-button" type="submit" disabled={!isComplete}>{isComplete ? "К чек-листу →" : `Заполнено ${completed} из ${requiredFields.length}`}</button>
              </div>
            </div>
          </form>
        </>
      ) : (
        <>
          <div className="compact-heading checklist-heading">
            <button className="back-link back-button" type="button" onClick={returnToAct}>← Данные акта</button>
            <div className="compact-title-row"><div><p className="kicker"><span aria-hidden="true" /> {form.objectCode} · {form.ovenModel}</p><h1>Чек-лист ТО</h1></div><span className="compact-progress">{checklistCompleted}/{ovenChecklist.length}</span></div>
            <p>Отметьте каждый выполненный пункт. При необходимости раскройте поле комментария.</p>
          </div>

          <form className="checklist-form" onSubmit={handleChecklistSubmit}>
            <section className="checklist-section" aria-labelledby="inspection-title">
              <div className="checklist-section-heading"><span>01</span><div><h2 id="inspection-title">Осмотр элементов печи</h2><p>Проверка состояния оборудования до обслуживания</p></div></div>
              <div className="checklist-items">
                {ovenChecklist.filter((item) => item.group === "inspection").map((item) => <ChecklistRow item={item} value={checklist[item.id]} onChange={(patch) => updateChecklist(item.id, patch)} key={item.id} />)}
              </div>
            </section>

            <section className="checklist-section" aria-labelledby="maintenance-title">
              <div className="checklist-section-heading"><span>02</span><div><h2 id="maintenance-title">Работы по техническому обслуживанию</h2><p>Очистка, протяжка, замеры и проверки</p></div></div>
              <div className="checklist-items">
                {ovenChecklist.filter((item) => item.group === "maintenance").map((item) => <ChecklistRow item={item} value={checklist[item.id]} onChange={(patch) => updateChecklist(item.id, patch)} key={item.id} />)}
              </div>
            </section>

            <div className="compact-save-row">
              <span className="compact-save-status"><i aria-hidden="true" /> {saveLabel}</span>
              <div className="compact-form-actions">
                <button className="reset-draft-button" type="button" onClick={returnToAct}>Назад</button>
                <button className="save-draft-button" type="submit" disabled={!checklistIsComplete}>{checklistIsComplete ? "Сохранить чек-лист" : `${checklistCompleted} из ${ovenChecklist.length}`}</button>
              </div>
            </div>
          </form>
        </>
      )}
    </main>
  );
}

function ChecklistRow({ item, value, onChange }: {
  item: (typeof ovenChecklist)[number];
  value: { done: boolean; comment: string };
  onChange: (patch: Partial<{ done: boolean; comment: string }>) => void;
}) {
  return (
    <article className={`checklist-row${value?.done ? " is-done" : ""}`}>
      <label className="checklist-main">
        <input type="checkbox" checked={value?.done ?? false} onChange={(event) => onChange({ done: event.target.checked })} />
        <span className="checkmark" aria-hidden="true">✓</span>
        <span className="checklist-number">{item.number}</span>
        <strong>{item.title}</strong>
      </label>
      <details className="comment-details" open={Boolean(value?.comment)}>
        <summary>{value?.comment ? "Комментарий добавлен" : "Добавить комментарий"}</summary>
        <textarea value={value?.comment ?? ""} onChange={(event) => onChange({ comment: event.target.value })} placeholder="Замечание, результат замера или пояснение" rows={2} />
      </details>
    </article>
  );
}
