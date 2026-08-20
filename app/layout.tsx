import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./motion-tokens.css";
import "./globals.css";
import "./effects.css";

const inter = localFont({
  src: [
    {
      path: "./fonts/InterVariable.woff2",
      style: "normal",
      weight: "100 900",
    },
    {
      path: "./fonts/InterVariable-Italic.woff2",
      style: "italic",
      weight: "100 900",
    },
  ],
  variable: "--font-inter",
  display: "swap",
  fallback: ["Arial", "Helvetica", "sans-serif"],
});

export const metadata: Metadata = {
  title: "Material Collager",
  description: "Create publication-ready interior material collages with high-fidelity product and finish references.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  initialScale: 1,
  themeColor: "#fafafa",
  viewportFit: "cover",
  width: "device-width",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} antialiased`}>
        {children}
        <div className="grain-overlay" aria-hidden />
      </body>
    </html>
  );
}
