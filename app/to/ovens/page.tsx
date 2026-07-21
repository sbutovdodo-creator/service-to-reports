"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Theme = "light" | "dark";

type ActData = {
  date: string;
  contractor: string;
  customer: string;
  pizzeriaAddress: string;
  serviceType: string;
  ovenModel: string;
  serialNumber: string;
  technicianName: string;
  customerRepresentative: string;
};

const STORAGE_KEY = "oven-act-draft-v1";

function localDate() {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

const initialData: ActData = {
  date: "",
  contractor: "ООО «РИК-ЛАБ»",
  customer: "",
  pizzeriaAddress: "",
  serviceType: "Плановое ТО печи",
  ovenModel: "",
  serialNumber: "",
  technicianName: "",
  customerRepresentative: "",
};

function themeForCurrentTime(): Theme {
  const hour = new Date().getHours();
  return hour >= 7 && hour < 20 ? "light" : "dark";
}

export default function OvenMaintenancePage() {
  const [form, setForm] = useState<ActData>(initialData);
  const [theme, setTheme] = useState<Theme>("light");
  const [hydrated, setHydrated] = useState(false);
  const [saveLabel, setSaveLabel] = useState("Черновик сохранится автоматически");

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("to-theme") as Theme | null;
    const initialTheme = savedTheme === "light" || savedTheme === "dark" ? savedTheme : themeForCurrentTime();
    setTheme(initialTheme);
    document.documentElement.dataset.theme = initialTheme;

    const savedDraft = window.localStorage.getItem(STORAGE_KEY);
    if (savedDraft) {
      try {
        setForm({ ...initialData, ...JSON.parse(savedDraft) });
      } catch {
        setForm({ ...initialData, date: localDate() });
      }
    } else {
      setForm({ ...initialData, date: localDate() });
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    setSaveLabel("Сохраняем…");
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
      setSaveLabel("Черновик сохранён на этом устройстве");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [form, hydrated]);

  const requiredFields = useMemo(
    () => [form.date, form.customer, form.pizzeriaAddress, form.ovenModel, form.serialNumber, form.technicianName, form.customerRepresentative],
    [form],
  );
  const completed = requiredFields.filter((value) => value.trim()).length;
  const isComplete = completed === requiredFields.length;

  function updateField<K extends keyof ActData>(field: K, value: ActData[K]) {
    setForm((current) => ({ ...current, [field]: value }));
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
    <main className="form-shell">
      <header className="topbar form-topbar">
        <a className="brand" href="/" aria-label="Вернуться к выбору ТО">
          <img className="brand-logo" src="/rik-logo.png" alt="" width="42" height="42" />
          <span className="brand-copy"><strong>РИК ЛАБ</strong><small>Сервис ТО</small></span>
        </a>
        <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label="Переключить тему">
          <span aria-hidden="true" className="theme-symbol">{theme === "dark" ? "☀" : "◐"}</span>
        </button>
      </header>

      <div className="form-heading">
        <a className="back-link" href="/">← Все виды ТО</a>
        <p className="kicker"><span aria-hidden="true" /> ТО печей</p>
        <h1>Данные акта</h1>
        <p>Заполните сведения об объекте и участниках работ. Черновик сохраняется автоматически — страницу можно закрыть и продолжить позже на этом устройстве.</p>
      </div>

      <div className="draft-status" role="status">
        <span><i aria-hidden="true" /> {saveLabel}</span>
        <strong>{completed} из {requiredFields.length}</strong>
      </div>

      <form className="act-form" onSubmit={handleSubmit}>
        <section className="form-section" aria-labelledby="act-main-title">
          <div className="section-heading">
            <span>01</span>
            <div><h2 id="act-main-title">Основная информация</h2><p>Поля из шапки акта выполненных работ</p></div>
          </div>
          <div className="field-grid">
            <label className="field"><span>Дата работ *</span><input type="date" value={form.date} onChange={(e) => updateField("date", e.target.value)} required /></label>
            <label className="field"><span>Исполнитель</span><input value={form.contractor} readOnly /></label>
            <label className="field field-wide"><span>Заказчик *</span><input value={form.customer} onChange={(e) => updateField("customer", e.target.value)} placeholder="Название организации" autoComplete="organization" required /></label>
            <label className="field field-wide"><span>Пиццерия: город и адрес *</span><textarea value={form.pizzeriaAddress} onChange={(e) => updateField("pizzeriaAddress", e.target.value)} placeholder="Москва, ул. Примерная, д. 1" rows={2} autoComplete="street-address" required /></label>
            <label className="field field-wide"><span>Вид технического обслуживания</span><input value={form.serviceType} readOnly /></label>
          </div>
        </section>

        <section className="form-section" aria-labelledby="equipment-title">
          <div className="section-heading">
            <span>02</span>
            <div><h2 id="equipment-title">Оборудование</h2><p>Данные с шильдика печи</p></div>
          </div>
          <div className="field-grid">
            <label className="field"><span>Модель печи *</span><select value={form.ovenModel} onChange={(e) => updateField("ovenModel", e.target.value)} required><option value="">Выберите модель</option><option value="XLT 3240">XLT 3240</option><option value="Робошеф 3">Робошеф 3</option><option value="Другая">Другая модель</option></select></label>
            <label className="field"><span>Серийный номер *</span><input value={form.serialNumber} onChange={(e) => updateField("serialNumber", e.target.value)} placeholder="Серийный номер" autoCapitalize="characters" required /></label>
          </div>
        </section>

        <section className="form-section" aria-labelledby="people-title">
          <div className="section-heading">
            <span>03</span>
            <div><h2 id="people-title">Участники</h2><p>ФИО для строк «работу сдал» и «работу принял»</p></div>
          </div>
          <div className="field-grid">
            <label className="field field-wide"><span>Техник — работу сдал *</span><input value={form.technicianName} onChange={(e) => updateField("technicianName", e.target.value)} placeholder="Фамилия Имя Отчество" autoComplete="name" required /></label>
            <label className="field field-wide"><span>Представитель пиццерии — работу принял *</span><input value={form.customerRepresentative} onChange={(e) => updateField("customerRepresentative", e.target.value)} placeholder="Фамилия Имя Отчество" required /></label>
          </div>
        </section>

        <div className="form-submit-bar">
          <div><strong>{isComplete ? "Раздел заполнен" : "Заполните обязательные поля"}</strong><span>После этого можно переходить к чек-листу</span></div>
          <button type="submit" disabled={!isComplete}>{isComplete ? "Сохранить данные" : `${completed}/${requiredFields.length}`}</button>
        </div>
      </form>
    </main>
  );
}
