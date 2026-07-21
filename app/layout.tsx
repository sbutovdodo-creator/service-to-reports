import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["cyrillic", "latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "Сервис ТО — новый отчёт",
    description: "Мобильная форма отчётов о техническом обслуживании оборудования.",
    icons: { icon: "/favicon.ico", shortcut: "/favicon.ico", apple: "/rik-logo.png" },
    openGraph: {
      title: "Сервис ТО — новый отчёт",
      description: "Выберите оборудование и заполните отчёт о техническом обслуживании.",
      images: [{ url: `${origin}/og.png`, width: 1536, height: 1024, alt: "Сервис ТО — выбор оборудования" }],
      locale: "ru_RU",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: "Сервис ТО — новый отчёт",
      description: "Выберите оборудование и заполните отчёт о техническом обслуживании.",
      images: [`${origin}/og.png`],
    },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#dcecf6" },
    { media: "(prefers-color-scheme: dark)", color: "#0a1821" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className={manrope.variable}>{children}</body>
    </html>
  );
}
