import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { ConsoleBanner } from "./components/console-banner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: "Read the Bones - samp cube roto analytics",
  description: "samp cube roto draft analysis",
  openGraph: {
    title: "Read the Bones",
    description: "samp cube roto draft analysis",
    images: [{ url: "/read-the-bones-art.jpg", width: 571, height: 460 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Read the Bones",
    description: "samp cube roto draft analysis",
    images: ["/read-the-bones-art.jpg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <ConsoleBanner />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
