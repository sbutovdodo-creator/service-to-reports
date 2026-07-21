"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const serviceTypes = [
  {
    eyebrow: "Тепловое оборудование",
    title: "ТО печей",
    description: "Обслуживание пицца-печей XLT 3240 и Робошеф 3",
    href: "/to/ovens",
    mark: "ПЕЧЬ",
  },
  {
    eyebrow: "Электрооборудование",
    title: "ТО щитов",
    description: "Проверка щитов, соединений и защитной автоматики",
    href: "/to/panels",
    mark: "ЩИТ",
  },
  {
    eyebrow: "Моечное оборудование",
    title: "ТО ПММ",
    description: "Обслуживание посудомоечных машин и систем подачи",
    href: "/to/dishwashers",
    mark: "ПММ",
  },
];

function themeForCurrentTime(): Theme {
  const hour = new Date().getHours();
  return hour >= 7 && hour < 20 ? "light" : "dark";
}

export default function Home() {
  const [theme, setTheme] = useState<Theme>("light");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("to-theme") as Theme | null;
    const initial = saved === "light" || saved === "dark" ? saved : themeForCurrentTime();
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
    setReady(true);
  }, []);

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("to-theme", next);
  }

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="РИК ЛАБ — Сервис ТО, на главную">
          <img className="brand-logo" src="/rik-logo.png" alt="" width="42" height="42" />
          <span className="brand-copy">
            <strong>РИК ЛАБ</strong>
            <small>Сервис ТО</small>
          </span>
        </a>
        <button
          className="theme-toggle"
          type="button"
          onClick={toggleTheme}
          aria-label={theme === "light" ? "Включить тёмную тему" : "Включить светлую тему"}
          title={theme === "light" ? "Тёмная тема" : "Светлая тема"}
        >
          <span aria-hidden="true" className="theme-symbol">
            {ready && theme === "dark" ? "☀" : "◐"}
          </span>
        </button>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="kicker"><span aria-hidden="true" /> Новый отчёт</p>
          <h1 id="page-title">ТО чего<br />проводим?</h1>
          <p className="intro">Выберите оборудование, чтобы перейти к заполнению отчёта.</p>
        </div>

        <div className="service-grid" aria-label="Выбор типа технического обслуживания">
          {serviceTypes.map((item, index) => (
            <a className="service-card" href={item.href} key={item.title}>
              <div className="card-topline">
                <span className="card-number">0{index + 1}</span>
                <span className="card-mark" aria-hidden="true">{item.mark}</span>
              </div>
              <div className="card-copy">
                <p>{item.eyebrow}</p>
                <h2>{item.title}</h2>
                <span>{item.description}</span>
              </div>
              <span className="card-action">
                Начать <span aria-hidden="true">→</span>
              </span>
            </a>
          ))}
        </div>
      </section>

      <footer>
        <span>Форма для технических специалистов</span>
        <span className="status"><i aria-hidden="true" /> Система готова</span>
      </footer>
    </main>
  );
}
